#!/usr/bin/env bash
# Joins the GitHub-hosted runners of one workflow run into a private WireGuard mesh, so the
# multi-machine E2E jobs can reach each other. Runners have no inbound connectivity (they sit behind
# NAT), so each one learns its public UDP address with STUN, publishes it with its WireGuard public
# key as a workflow artifact, and configures the others as peers. WireGuard handshakes from both
# sides then punch through both NATs (the runners' NAT maps a local port to the same public port
# for every destination).
#
#   mesh.sh prepare ROLE            key pair + STUN; writes $MESH_DIR/publish/ROLE.json (upload it
#                                   as the artifact "mesh-ROLE")
#   mesh.sh join ROLE PEER...       downloads the peers' artifacts, brings wg-mesh up, waits for them
#   mesh.sh ip ROLE                 prints a role's mesh address
#   mesh.sh serve-signals ROLE      serves $MESH_DIR/signals on the mesh (port 18999)
#   mesh.sh signal NAME             creates a signal file that peers can poll
#   mesh.sh wait-signal ROLE NAME   waits until ROLE serves the signal NAME (or stops answering)
#
# Needs: sudo, wireguard-tools, node (for e2e/multi/stun.ts), gh with GH_TOKEN (actions: read).
set -euo pipefail

MESH_DIR="${MESH_DIR:-${RUNNER_TEMP:-/tmp}/mesh}"
MESH_PORT="${MESH_PORT:-51000}"
MESH_IFACE=wg-mesh
SIGNAL_PORT=18999
here="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[mesh %s] %s\n' "$(date +%T)" "$*" >&2; }

mesh_ip() {
  case "$1" in
    wg) echo 192.168.233.1 ;;
    source) echo 192.168.233.2 ;;
    stack) echo 192.168.233.3 ;;
    *)
      log "unknown role $1"
      exit 2
      ;;
  esac
}

prepare() {
  local role="$1"
  mkdir -p "$MESH_DIR/publish" "$MESH_DIR/peers" "$MESH_DIR/signals"
  if ! command -v wg >/dev/null; then
    sudo apt-get install -y -qq wireguard-tools >/dev/null
  fi
  sudo modprobe wireguard
  (umask 077 && wg genkey >"$MESH_DIR/private.key")
  wg pubkey <"$MESH_DIR/private.key" >"$MESH_DIR/public.key"
  # Keeps the NAT mapping alive from the WireGuard port until `join` hands the port to WireGuard.
  rm -f "$MESH_DIR/stun.json"
  nohup node "$here/stun.ts" --port "$MESH_PORT" --out "$MESH_DIR/stun.json" --keepalive 10 \
    >"$MESH_DIR/stun.log" 2>&1 &
  echo $! >"$MESH_DIR/stun.pid"
  for _ in $(seq 1 30); do
    [[ -s "$MESH_DIR/stun.json" ]] && break
    sleep 0.5
  done
  if [[ ! -s "$MESH_DIR/stun.json" ]]; then
    cat "$MESH_DIR/stun.log" >&2
    log "STUN failed"
    exit 1
  fi
  log "public UDP address: $(cat "$MESH_DIR/stun.json")"
  jq -n --arg role "$role" --arg ip "$(mesh_ip "$role")" --arg key "$(cat "$MESH_DIR/public.key")" \
    --slurpfile stun "$MESH_DIR/stun.json" \
    '{role: $role, meshIp: $ip, publicKey: $key, endpoint: "\($stun[0].ip):\($stun[0].port)", stun: $stun[0]}' \
    >"$MESH_DIR/publish/$role.json"
}

# Waits until the workflow run has the artifact "mesh-PEER" and downloads it.
fetch_peer() {
  local peer="$1" deadline=$((SECONDS + ${MESH_WAIT_SECONDS:-600}))
  until [[ -s "$MESH_DIR/peers/$peer.json" ]]; do
    if gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/artifacts?per_page=100" \
      --jq '.artifacts[].name' 2>/dev/null | grep -qx "mesh-$peer"; then
      gh run download "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" -n "mesh-$peer" -D "$MESH_DIR/download-$peer" >/dev/null
      cp "$MESH_DIR/download-$peer/$peer.json" "$MESH_DIR/peers/$peer.json"
      log "got $peer: $(jq -c . "$MESH_DIR/peers/$peer.json")"
      return
    fi
    if ((SECONDS > deadline)); then
      log "timed out waiting for the $peer runner"
      exit 1
    fi
    sleep 3
  done
}

join() {
  local role="$1"
  shift
  local peer
  for peer in "$@"; do
    fetch_peer "$peer"
  done
  # Hand the port from the STUN keepalive to WireGuard, within the NAT's mapping timeout.
  kill "$(cat "$MESH_DIR/stun.pid")" 2>/dev/null || true
  sleep 0.2
  sudo ip link del "$MESH_IFACE" 2>/dev/null || true
  sudo ip link add "$MESH_IFACE" type wireguard
  sudo wg set "$MESH_IFACE" listen-port "$MESH_PORT" private-key "$MESH_DIR/private.key"
  for peer in "$@"; do
    local file="$MESH_DIR/peers/$peer.json"
    sudo wg set "$MESH_IFACE" peer "$(jq -r .publicKey "$file")" \
      endpoint "$(jq -r .endpoint "$file")" \
      allowed-ips "$(jq -r .meshIp "$file")/32" \
      persistent-keepalive 5
  done
  sudo ip address add "$(mesh_ip "$role")/24" dev "$MESH_IFACE"
  # Leaves room for a WireGuard tunnel inside the mesh (each layer adds 60-80 bytes).
  sudo ip link set "$MESH_IFACE" mtu 1380 up
  local start=$SECONDS
  for peer in "$@"; do
    local ip
    ip="$(mesh_ip "$peer")"
    until ping -c 1 -W 1 "$ip" >/dev/null 2>&1; do
      if ((SECONDS - start > ${MESH_HANDSHAKE_SECONDS:-120})); then
        sudo wg show "$MESH_IFACE" >&2
        log "no connectivity to $peer ($ip)"
        exit 1
      fi
    done
    log "$peer reachable at $ip after $((SECONDS - start)) s"
  done
  sudo wg show "$MESH_IFACE"
}

serve_signals() {
  local role="$1"
  mkdir -p "$MESH_DIR/signals"
  nohup python3 -m http.server "$SIGNAL_PORT" --bind "$(mesh_ip "$role")" --directory "$MESH_DIR/signals" \
    >"$MESH_DIR/signals.log" 2>&1 &
}

signal() {
  mkdir -p "$MESH_DIR/signals"
  date -u +%FT%TZ >"$MESH_DIR/signals/$1"
}

wait_signal() {
  local role="$1" name="$2" ip unreachable=0
  ip="$(mesh_ip "$role")"
  local deadline=$((SECONDS + ${MESH_SIGNAL_WAIT_SECONDS:-3000}))
  while ((SECONDS < deadline)); do
    if curl -sf -m 5 -o /dev/null "http://$ip:$SIGNAL_PORT/$name"; then
      log "got signal $name from $role"
      return 0
    fi
    # Gone for good (the job failed or was cancelled): stop waiting.
    if ping -c 1 -W 2 "$ip" >/dev/null 2>&1; then unreachable=0; else unreachable=$((unreachable + 1)); fi
    if ((unreachable >= 30)); then
      log "$role stopped answering"
      return 1
    fi
    sleep 3
  done
  log "timed out waiting for signal $name from $role"
  return 1
}

case "${1:-}" in
  prepare) prepare "$2" ;;
  join) join "${@:2}" ;;
  ip) mesh_ip "$2" ;;
  serve-signals) serve_signals "$2" ;;
  signal) signal "$2" ;;
  wait-signal) wait_signal "$2" "$3" ;;
  *)
    sed -n '2,20p' "$0" >&2
    exit 2
    ;;
esac
