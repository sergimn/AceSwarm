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
#   mesh.sh join ROLE PEER...      downloads the peers' artifacts and waits until they answer
#   mesh.sh ip ROLE                prints a role's mesh address
#   mesh.sh share FILE [NAME]      serves FILE to the other runners at http://<mesh ip>:18999/NAME
#   mesh.sh wait-file ROLE NAME    waits until ROLE serves NAME (or stops answering) and prints it
#   mesh.sh wait-fetched NAME ROLE...
#                                  waits (up to 2 minutes) until each ROLE fetched NAME from this runner
#
# Roles: wg (WireGuard server), source (Acestream broadcast), stack (AceSwarm and the tests).
# Needs sudo, wireguard-tools, jq, node (for stun.ts) and gh with GH_TOKEN (actions: read).
set -euo pipefail

MESH_DIR="${MESH_DIR:-${RUNNER_TEMP:-/tmp}/mesh}"
MESH_PORT="${MESH_PORT:-51000}"
MESH_ARTIFACT_PREFIX="${MESH_ARTIFACT_PREFIX:-mesh-}"
MESH_IFACE=wg-mesh
MESH_KEY=/etc/wireguard/wg-mesh.key
# Leaves room for a WireGuard tunnel inside the mesh: each layer adds up to 80 bytes.
MESH_MTU=1380
SHARE_PORT=18999
here="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[mesh %s] %s\n' "$(date +%T)" "$*" >&2; }

# TEST-NET-1 addresses: nothing on the runners uses them, and the gateway counts them as internet
# peers (it skips private ranges like 192.168.0.0/16 in its peer statistics).
mesh_ip() {
  case "$1" in
    wg) echo 192.0.2.1 ;;
    source) echo 192.0.2.2 ;;
    stack) echo 192.0.2.3 ;;
    *)
      log "unknown role $1"
      exit 2
      ;;
  esac
}

prepare() {
  local role="$1"
  mkdir -p "$MESH_DIR/publish" "$MESH_DIR/peers" "$MESH_DIR/share"
  command -v wg >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq wireguard-tools >/dev/null; }
  sudo modprobe wireguard
  # The private key lives in /etc/wireguard: on Ubuntu 26.04, AppArmor's profile for wg lets it
  # read files there only. Otherwise wg only gets pipes here.
  sudo install -d -m 0700 /etc/wireguard
  wg genkey | sudo sh -c "umask 077 && cat >$MESH_KEY"
  local public
  public="$(sudo cat "$MESH_KEY" | wg pubkey)"
  echo "$public" >"$MESH_DIR/public.key"

  # Refreshes the NAT mapping every 10 s until `join` hands the port to WireGuard.
  rm -f "$MESH_DIR/stun.json"
  nohup node "$here/stun.ts" --port "$MESH_PORT" --out "$MESH_DIR/stun.json" --keepalive 10 \
    >"$MESH_DIR/stun.log" 2>&1 &
  echo $! >"$MESH_DIR/stun.pid"
  for _ in $(seq 1 40); do
    [[ -s "$MESH_DIR/stun.json" ]] && break
    sleep 0.5
  done
  if [[ ! -s "$MESH_DIR/stun.json" ]]; then
    cat "$MESH_DIR/stun.log" >&2
    log "STUN failed: no public UDP address"
    exit 1
  fi

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

# Waits until the workflow run has the peer's artifact and downloads it.
fetch_peer() {
  local peer="$1" name="${MESH_ARTIFACT_PREFIX}$1" deadline=$((SECONDS + ${MESH_WAIT_SECONDS:-600}))
  until gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/artifacts?per_page=100" \
    --jq '.artifacts[].name' 2>/dev/null | grep -x "$name" >/dev/null; do
    if ((SECONDS > deadline)); then
      log "timed out waiting for the $peer runner (artifact $name)"
      exit 1
    fi
    sleep 3
  done
  rm -rf "$MESH_DIR/download-$peer"
  gh run download "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" -n "$name" -D "$MESH_DIR/download-$peer" >/dev/null
  cp "$MESH_DIR/download-$peer/$peer.json" "$MESH_DIR/peers/$peer.json"
  log "$peer: $(jq -c '{meshIp, endpoint}' "$MESH_DIR/peers/$peer.json")"
}

join() {
  local role="$1"
  shift
  local peer
  for peer in "$@"; do
    fetch_peer "$peer"
  done
  # The NAT keeps an idle mapping for well over the second this takes.
  local stun_pid
  stun_pid="$(cat "$MESH_DIR/stun.pid")"
  kill "$stun_pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$stun_pid" 2>/dev/null || break
    sleep 0.1
  done
  sudo wg set "$MESH_IFACE" listen-port "$MESH_PORT"
  for peer in "$@"; do
    local file="$MESH_DIR/peers/$peer.json"
    sudo wg set "$MESH_IFACE" peer "$(jq -r .publicKey "$file")" \
      endpoint "$(jq -r .endpoint "$file")" \
      allowed-ips "$(jq -r .meshIp "$file")/32" \
      persistent-keepalive 5
  done
  local start=$SECONDS
  for peer in "$@"; do
    local ip
    ip="$(mesh_ip "$peer")"
    until ping -c 1 -W 1 "$ip" >/dev/null 2>&1; do
      if ((SECONDS - start > ${MESH_HANDSHAKE_SECONDS:-180})); then
        sudo wg show "$MESH_IFACE" >&2
        log "no connectivity to $peer ($ip)"
        exit 1
      fi
    done
    log "$peer answers at $ip after $((SECONDS - start)) s"
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

# The file server stops with this runner's job, so a runner that shares a file and then finishes
# has to wait until the others fetched it. A runner that is gone never will, hence the time limit.
wait_fetched() {
  local name="$1" role pattern deadline=$((SECONDS + ${MESH_FETCH_WAIT_SECONDS:-120}))
  shift
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
  wait-fetched) wait_fetched "${@:2}" ;;
  *)
    sed -n '2,21p' "$0" >&2
    exit 2
    ;;
esac
