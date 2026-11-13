#!/usr/bin/env bash
# Joins the GitHub-hosted runners of one workflow run into a private WireGuard network (the
# "mesh"), so the end-to-end test jobs can reach each other. See e2e/README.md for diagrams.
#
# Runners can't accept connections from the internet: they sit behind a NAT that only lets packets
# in from an address the runner has sent to. That NAT keeps one public port per local port whatever
# the destination, so each runner learns its public UDP address with STUN, publishes it with its
# WireGuard public key as a workflow artifact, and configures the others as peers. Both sides then
# send WireGuard handshakes, and each side's first packets open its own NAT for the other side.
#
#   mesh.sh prepare ROLE           keys, mesh address, STUN; writes $MESH_DIR/publish/ROLE.json
#                                  (the workflow uploads it as the artifact ${MESH_ARTIFACT_PREFIX}ROLE)
#   mesh.sh join ROLE PEER...      downloads the peers' artifacts and waits until they answer. A
#                                  PEER written as NAME? is optional: it is added as soon as its
#                                  artifact shows up (for up to 10 minutes), and left out if it
#                                  never does or never answers. Stops waiting for any peer whose
#                                  job ended without publishing its address (fails for a required
#                                  one, leaves an optional one out).
#   mesh.sh ip ROLE                prints a role's mesh address
#   mesh.sh share FILE [NAME]      serves FILE to the other runners at http://<mesh ip>:18999/NAME
#   mesh.sh wait-file ROLE NAME    waits until ROLE serves NAME (or stops answering) and prints it
#   mesh.sh wait-all NAME ROLE...  waits until each ROLE that joined serves NAME or stops answering;
#                                  fails if one stopped answering without it
#   mesh.sh wait-fetched NAME ROLE...
#                                  waits (up to 2 minutes) until each ROLE fetched NAME from this runner
#
# Roles: wg (WireGuard server), source (Acestream broadcast), stack and stack-podman (AceSwarm and
# the tests, on Docker and on rootless Podman). Both stacks share the other two.
# Needs sudo, wireguard-tools, jq, node (for stun.ts) and gh with GH_TOKEN (actions: read).
set -euo pipefail

MESH_DIR="${MESH_DIR:-${RUNNER_TEMP:-/tmp}/mesh}"
MESH_PORT="${MESH_PORT:-51000}"
MESH_ARTIFACT_PREFIX="${MESH_ARTIFACT_PREFIX:-mesh-}"
# `prepare` tries installing wireguard-tools and STUN this many times. An install try gets
# MESH_APT_SECONDS, a STUN try 20 s; both usually take a few seconds.
MESH_TRIES="${MESH_TRIES:-3}"
MESH_APT_SECONDS="${MESH_APT_SECONDS:-60}"
MESH_IFACE=wg-mesh
MESH_KEY=/etc/wireguard/wg-mesh.key
# Leaves room for a WireGuard tunnel inside the mesh: each layer adds up to 80 bytes.
MESH_MTU=1380
SHARE_PORT=18999
here="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[mesh %s] %s\n' "$(date +%T)" "$*" >&2; }

# The job names in .github/workflows/e2e.yml, to tell when a peer's job has ended.
job_name() {
  case "$1" in
    wg) echo "WireGuard server" ;;
    source) echo "Dummy Acestream broadcast" ;;
    stack) echo "AceSwarm with real engines" ;;
    stack-podman) echo "AceSwarm with real engines (Podman)" ;;
    *)
      log "unknown role $1"
      exit 2
      ;;
  esac
}

# TEST-NET-1 addresses: nothing on the runners uses them, and the gateway counts them as internet
# peers (it skips private ranges like 192.168.0.0/16 in its peer statistics).
mesh_ip() {
  case "$1" in
    wg) echo 192.0.2.1 ;;
    source) echo 192.0.2.2 ;;
    stack) echo 192.0.2.3 ;;
    stack-podman) echo 192.0.2.4 ;;
    *)
      log "unknown role $1"
      exit 2
      ;;
  esac
}

# Installs wireguard-tools if it's missing. apt usually takes a few seconds on a runner, but a
# package mirror that stops answering can hold it forever (once for a whole one-hour job), so each
# try has a time limit. timeout runs under sudo so that it can stop apt's own child processes too.
install_wireguard_tools() {
  command -v wg >/dev/null && return 0
  local try
  for try in $(seq 1 "$MESH_TRIES"); do
    if sudo timeout -k 5 "$MESH_APT_SECONDS" env DEBIAN_FRONTEND=noninteractive sh -c \
      'apt-get -qq -o DPkg::Lock::Timeout=20 -o Acquire::http::Timeout=15 update &&
       apt-get -qq -o DPkg::Lock::Timeout=20 -o Acquire::http::Timeout=15 install -y wireguard-tools >/dev/null'; then
      return 0
    fi
    log "installing wireguard-tools failed or took over $MESH_APT_SECONDS s (try $try of $MESH_TRIES)"
    # A try stopped while dpkg was unpacking leaves it half done, which would fail the next one.
    sudo timeout -k 5 60 dpkg --configure -a || true
    # A try stopped after wg was unpacked (in a slow trigger, say) still did the job.
    command -v wg >/dev/null && return 0
    sleep 2
  done
  log "could not install wireguard-tools"
  return 1
}

# Stops the STUN client and waits until its UDP port is free again.
stop_stun() {
  local pid
  pid="$(cat "$MESH_DIR/stun.pid" 2>/dev/null)" || return 0
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$MESH_DIR/stun.pid"
}

# Learns this runner's public UDP address. The client keeps running in the background and refreshes
# the NAT mapping every 10 s until `join` hands the port to WireGuard.
start_stun() {
  local try pid
  for try in $(seq 1 "$MESH_TRIES"); do
    rm -f "$MESH_DIR/stun.json"
    nohup node "$here/stun.ts" --port "$MESH_PORT" --out "$MESH_DIR/stun.json" --keepalive 10 \
      >"$MESH_DIR/stun.log" 2>&1 &
    pid=$!
    echo "$pid" >"$MESH_DIR/stun.pid"
    # Up to 20 s. The client gives up by itself after about 12 s without an answer.
    for _ in $(seq 1 40); do
      [[ -s "$MESH_DIR/stun.json" ]] && return 0
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    [[ -s "$MESH_DIR/stun.json" ]] && return 0
    stop_stun
    cat "$MESH_DIR/stun.log" >&2
    log "STUN failed (try $try of $MESH_TRIES)"
    sleep 2
  done
  log "STUN failed: no public UDP address"
  return 1
}

prepare() {
  local role="$1"
  mkdir -p "$MESH_DIR/publish" "$MESH_DIR/peers" "$MESH_DIR/share"
  install_wireguard_tools
  sudo timeout 30 modprobe wireguard
  # The private key lives in /etc/wireguard: on Ubuntu 26.04, AppArmor's profile for wg lets it
  # read files there only. Otherwise wg only gets pipes here.
  sudo install -d -m 0700 /etc/wireguard
  wg genkey | sudo sh -c "umask 077 && cat >$MESH_KEY"
  local public
  public="$(sudo cat "$MESH_KEY" | wg pubkey)"
  echo "$public" >"$MESH_DIR/public.key"
  start_stun

  # The address exists from the start, so services can bind to it and announce it before the peers
  # are known. WireGuard gets the STUN port in `join`.
  sudo ip link del "$MESH_IFACE" 2>/dev/null || true
  sudo ip link add "$MESH_IFACE" type wireguard
  sudo wg set "$MESH_IFACE" private-key "$MESH_KEY"
  sudo ip address add "$(mesh_ip "$role")/24" dev "$MESH_IFACE"
  sudo ip link set "$MESH_IFACE" mtu "$MESH_MTU" up
  nohup python3 -m http.server "$SHARE_PORT" --bind "$(mesh_ip "$role")" --directory "$MESH_DIR/share" \
    >"$MESH_DIR/share.log" 2>&1 &

  log "public UDP address: $(cat "$MESH_DIR/stun.json")"
  if [[ "$(jq -r .endpointIndependent "$MESH_DIR/stun.json")" != true ]]; then
    log "warning: STUN servers saw different ports, so hole punching may fail"
  fi
  jq -n --arg role "$role" --arg ip "$(mesh_ip "$role")" --arg key "$(cat "$MESH_DIR/public.key")" \
    --slurpfile stun "$MESH_DIR/stun.json" \
    '{role: $role, meshIp: $ip, publicKey: $key, endpoint: "\($stun[0].ip):\($stun[0].port)", stun: $stun[0]}' \
    >"$MESH_DIR/publish/$role.json"
}

has_artifact() {
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/artifacts?per_page=100" \
    --jq '.artifacts[].name' 2>/dev/null | grep -x "${MESH_ARTIFACT_PREFIX}$1" >/dev/null
}

# Prints the status of a peer's job in this run attempt (queued, in_progress, completed...), or
# nothing if the API doesn't answer or has no job by that name.
job_status() {
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs?per_page=100" \
    2>/dev/null | jq -r --arg name "$(job_name "$1")" '.jobs[] | select(.name == $name) | .status' 2>/dev/null |
    head -1 || true
}

# Whether the peer's job has ended without publishing its address, so it never will. The artifact
# list is checked once more after the job's status, in case the artifact came just before.
peer_gone() {
  [[ "$(job_status "$1")" == completed ]] && ! has_artifact "$1"
}

# Downloads a peer's artifact (it must exist) to $MESH_DIR/peers/PEER.json.
download_peer() {
  local peer="$1"
  rm -rf "$MESH_DIR/download-$peer"
  gh run download "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" -n "${MESH_ARTIFACT_PREFIX}$peer" \
    -D "$MESH_DIR/download-$peer" >/dev/null || return 1
  cp "$MESH_DIR/download-$peer/$peer.json" "$MESH_DIR/peers/$peer.json" || return 1
  log "$peer: $(jq -c '{meshIp, endpoint}' "$MESH_DIR/peers/$peer.json")"
}

# Waits until the workflow run has the peer's artifact and downloads it.
fetch_peer() {
  local peer="$1" deadline=$((SECONDS + ${MESH_WAIT_SECONDS:-600})) polls=0
  until has_artifact "$peer"; do
    if ((SECONDS > deadline)); then
      log "timed out waiting for the $peer runner (artifact ${MESH_ARTIFACT_PREFIX}$peer)"
      exit 1
    fi
    # Every 15 s or so, rather than waiting out the whole time limit for a runner that is gone.
    if ((++polls % 5 == 0)) && peer_gone "$peer"; then
      log "the $peer runner's job ended without publishing its address"
      exit 1
    fi
    sleep 3
  done
  download_peer "$peer" || exit 1
}

add_peer() {
  local file="$MESH_DIR/peers/$1.json"
  sudo wg set "$MESH_IFACE" peer "$(jq -r .publicKey "$file")" \
    endpoint "$(jq -r .endpoint "$file")" \
    allowed-ips "$(jq -r .meshIp "$file")/32" \
    persistent-keepalive 5
}

# Waits until the peer answers pings through the mesh; returns 1 if it never does.
await_peer() {
  local peer="$1" ip start=$SECONDS
  ip="$(mesh_ip "$peer")"
  until ping -c 1 -W 1 "$ip" >/dev/null 2>&1; do
    if ((SECONDS - start > ${MESH_HANDSHAKE_SECONDS:-180})); then
      sudo wg show "$MESH_IFACE" >&2
      log "no connectivity to $peer ($ip)"
      return 1
    fi
  done
  log "$peer answers at $ip after $((SECONDS - start)) s"
  echo "$peer" >>"$MESH_DIR/joined"
}

# Adds each optional peer whose artifact exists now and prints the ones still missing.
add_ready() {
  local peer
  for peer in "$@"; do
    if has_artifact "$peer" && download_peer "$peer"; then
      add_peer "$peer"
      echo "+$peer"
    else
      echo "$peer"
    fi
  done
}

join() {
  local role="$1"
  shift
  local peer required=() optional=()
  for peer in "$@"; do
    if [[ "$peer" == *\? ]]; then optional+=("${peer%\?}"); else required+=("$peer"); fi
  done
  for peer in "${required[@]}"; do
    fetch_peer "$peer"
  done
  # The NAT keeps an idle mapping for well over the second this takes.
  stop_stun
  sudo wg set "$MESH_IFACE" listen-port "$MESH_PORT"
  : >"$MESH_DIR/joined"
  for peer in "${required[@]}"; do
    add_peer "$peer"
  done

  # Optional peers go in as soon as their artifact shows up, so one that is late or never comes
  # holds nobody up: a peer that is already waiting for this runner gets its handshakes answered.
  local pending=() added=() line deadline=$((SECONDS + ${MESH_WAIT_SECONDS:-600})) polls=0
  while read -r line; do
    if [[ "$line" == +* ]]; then added+=("${line#+}"); else pending+=("$line"); fi
  done < <(add_ready "${optional[@]}")
  for peer in "${required[@]}"; do
    await_peer "$peer" || exit 1
  done
  while ((${#added[@]} > 0 || (${#pending[@]} > 0 && SECONDS < deadline))); do
    for peer in "${added[@]}"; do
      await_peer "$peer" || log "leaving out $peer"
    done
    added=()
    ((${#pending[@]} > 0)) || break
    sleep 3
    local still=()
    while read -r line; do
      if [[ "$line" == +* ]]; then added+=("${line#+}"); else still+=("$line"); fi
    done < <(add_ready "${pending[@]}")
    pending=()
    for peer in "${still[@]}"; do
      # Every 15 s or so: one whose job ended without an artifact will never come.
      if ((polls % 5 == 4)) && peer_gone "$peer"; then
        log "the $peer runner's job ended without publishing its address; leaving it out"
      else
        pending+=("$peer")
      fi
    done
    ((++polls))
  done
  for peer in "${pending[@]}"; do
    log "$peer never showed up; leaving it out"
  done
  sudo wg show "$MESH_IFACE"
}

share() {
  local file="$1" name="${2:-$(basename "$1")}"
  mkdir -p "$MESH_DIR/share"
  cp "$file" "$MESH_DIR/share/.$name.tmp"
  mv "$MESH_DIR/share/.$name.tmp" "$MESH_DIR/share/$name"
}

wait_file() {
  local role="$1" name="$2" ip silent=0
  ip="$(mesh_ip "$role")"
  local deadline=$((SECONDS + ${MESH_FILE_WAIT_SECONDS:-3400}))
  while ((SECONDS < deadline)); do
    if curl -sf -m 5 "http://$ip:$SHARE_PORT/$name"; then
      log "got $name from $role"
      return 0
    fi
    # Gone for good (its job failed or was cancelled): stop waiting.
    if ping -c 1 -W 2 "$ip" >/dev/null 2>&1; then silent=0; else silent=$((silent + 1)); fi
    if ((silent >= 30)); then
      log "$role stopped answering"
      return 1
    fi
    sleep 3
  done
  log "timed out waiting for $name from $role"
  return 1
}

# Waits for NAME from every ROLE that joined this runner's mesh, side by side, since each one's
# file server stops with its job: a stack that finishes first must not wait for the other.
wait_all() {
  local name="$1" role pending=() missing=0
  shift
  for role in "$@"; do
    if grep -qx "$role" "$MESH_DIR/joined" 2>/dev/null; then
      pending+=("$role")
    else
      log "$role never joined"
    fi
  done
  local -A silent=()
  local deadline=$((SECONDS + ${MESH_FILE_WAIT_SECONDS:-3400}))
  while ((${#pending[@]} > 0 && SECONDS < deadline)); do
    local still=()
    for role in "${pending[@]}"; do
      if curl -sf -m 5 -o /dev/null "http://$(mesh_ip "$role"):$SHARE_PORT/$name"; then
        log "got $name from $role"
      elif ping -c 1 -W 2 "$(mesh_ip "$role")" >/dev/null 2>&1; then
        silent[$role]=0
        still+=("$role")
      elif ((${silent[$role]:-0} + 1 >= 30)); then
        log "$role stopped answering"
        missing=1
      else
        silent[$role]=$((${silent[$role]:-0} + 1))
        still+=("$role")
      fi
    done
    pending=("${still[@]}")
    ((${#pending[@]} == 0)) || sleep 3
  done
  if ((${#pending[@]} > 0)); then
    log "timed out waiting for $name from ${pending[*]}"
    return 1
  fi
  return "$missing"
}

# The file server stops with this runner's job, so a runner that shares a file and then finishes
# has to wait until the others fetched it. A runner that is gone never will, hence the time limit.
wait_fetched() {
  local name="$1" role pattern deadline=$((SECONDS + ${MESH_FETCH_WAIT_SECONDS:-120}))
  shift
  # A runner that failed before `join` set up its peers can't be reached, so nobody will fetch it.
  if [[ -z "$(sudo wg show "$MESH_IFACE" peers 2>/dev/null)" ]]; then
    log "not in the mesh, so no runner can fetch $name"
    return 0
  fi
  for role in "$@"; do
    # http.server logs each request as: 192.0.2.1 - - [date] "GET /done HTTP/1.1" 200 -
    pattern="^$(mesh_ip "$role" | sed 's/\./\\./g') .*\"GET /$name HTTP/[0-9.]+\" 200 "
    until grep -E "$pattern" "$MESH_DIR/share.log" >/dev/null 2>&1; do
      if ((SECONDS > deadline)); then
        log "$role did not fetch $name"
        break
      fi
      sleep 1
    done
  done
}

case "${1:-}" in
  prepare) prepare "$2" ;;
  join) join "${@:2}" ;;
  ip) mesh_ip "$2" ;;
  share) share "${@:2}" ;;
  wait-file) wait_file "$2" "$3" ;;
  wait-all) wait_all "${@:2}" ;;
  wait-fetched) wait_fetched "${@:2}" ;;
  *)
    sed -n '2,29p' "$0" >&2
    exit 2
    ;;
esac
