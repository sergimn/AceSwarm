#!/usr/bin/env bash
# The throwaway WireGuard server for the end-to-end tests (image: e2e/wg-server). It listens on
# UDP 51820 of this runner, so AceSwarm on another runner reaches it through the mesh, and it NATs
# client traffic out of this runner: to the broadcast runner over the mesh, and to the internet.
# See e2e/README.md for diagrams.
#
#   vpn.sh build                 builds the server image
#   vpn.sh start ENDPOINT_HOST   starts it on ENDPOINT_HOST:51820, which the client profile points at
#   vpn.sh profile               waits for the client profile and prints its path
#   vpn.sh logs
set -euo pipefail

VPN_DIR="${VPN_DIR:-${RUNNER_TEMP:-/tmp}/vpn}"
IMAGE=aceswarm-wg-server:e2e
NAME=aceswarm-vpn
# The tunnel runs inside the mesh (MTU 1380), and WireGuard adds up to 80 bytes.
CLIENT_MTU=1280
here="$(cd "$(dirname "$0")" && pwd)"

build() {
  docker build -q -t "$IMAGE" "$here/../wg-server" >/dev/null
}

start() {
  mkdir -p "$VPN_DIR"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --cap-add NET_ADMIN --device /dev/net/tun \
    --sysctl net.ipv4.ip_forward=1 -p "$1:51820:51820/udp" \
    -e WG_ENDPOINT="$1:51820" -e WG_CLIENT_MTU="$CLIENT_MTU" \
    -v "$VPN_DIR:/state" "$IMAGE" >/dev/null
}

profile() {
  for _ in $(seq 1 60); do
    # Not `grep -q`: it stops reading at the match, and pipefail then fails on docker's SIGPIPE.
    if docker logs "$NAME" 2>&1 | grep 'wireguard server ready' >/dev/null; then
      # The server writes the profile as root with mode 0644.
      echo "$VPN_DIR/client.conf"
      return 0
    fi
    sleep 1
  done
  docker logs "$NAME" >&2 || true
  echo "the WireGuard server did not start" >&2
  return 1
}

logs() {
  docker logs "$NAME" 2>&1 || true
  docker exec "$NAME" wg show 2>&1 || true
}

case "${1:-}" in
  build) build ;;
  start) start "$2" ;;
  profile) profile ;;
  logs) logs ;;
  *)
    sed -n '2,10p' "$0" >&2
    exit 2
    ;;
esac
