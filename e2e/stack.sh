#!/usr/bin/env bash
# The AceSwarm side of the end-to-end tests: builds the images (with the real engine image) and
# starts or stops the stack. See e2e/README.md.
#
#   e2e/stack.sh build|up|down|logs|check
#
# `check` fails fast when the gateway can't ping its probe target (the WireGuard server's runner)
# on the direct path: every path would stay down and every test would time out.
#
# On the Podman leg, `docker` is Podman (podman-docker, see e2e/podman.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=aceswarm-e2e
export COMPOSE_PROFILES=""
export ACESWARM_STACK_NAME=aceswarm-e2e
export ACESWARM_ENGINE_NETWORK=aceswarm-e2e_engines
export E2E_HTTP_PORT="${E2E_HTTP_PORT:-18080}"

compose() {
  docker compose -f compose.yaml -f e2e/compose.e2e.yaml "$@"
}

build() {
  for target in controller transcoder netgw; do
    docker build -q --target "$target" -t "aceswarm-${target}:e2e" . >/dev/null
  done
  docker build -q -f engine/Dockerfile -t aceswarm-engine:e2e . >/dev/null
}

down() {
  # Engines are created by the controller, not by compose, so they are removed by label.
  docker ps -aq --filter "label=aceswarm.stack=${ACESWARM_STACK_NAME}" | xargs -r docker rm -f >/dev/null
  compose down --volumes --remove-orphans
}

logs() {
  compose logs --no-color
  # What the gateway runs as and can reach: its WireGuard setup writes and reads these paths.
  echo "--- netgw identity and runtime directories"
  compose exec -T netgw sh -c 'id; grep -E "^Cap(Eff|Bnd)" /proc/self/status; cat /proc/self/attr/current 2>/dev/null; echo; ls -land /run /run/aceswarm /run/wireguard /config/wireguard /config/wireguard/* 2>&1; grep -E " /(run|config)" /proc/self/mountinfo' || true
  local engine
  for engine in $(docker ps -aq --filter "label=aceswarm.stack=${ACESWARM_STACK_NAME}"); do
    echo "--- engine $(docker inspect -f '{{.Name}}' "$engine")"
    # Drops noise: a disk probe that fails in containers and crash-report retries.
    docker logs "$engine" 2>&1 | grep -vE 'disk/by-id|raven' | tail -60
  done
}

check() {
  # shellcheck disable=SC2016 # expanded inside the gateway container
  if ! compose exec -T netgw sh -c 'ping -c 3 -W 2 "${PROBE_TARGETS%%,*}"'; then
    echo "the gateway can't ping its probe target, so no network path can come up" >&2
    return 1
  fi
}

case "${1:-}" in
  build) build ;;
  check) check ;;
  up) compose up -d --wait --wait-timeout 180 ;;
  down) down ;;
  logs) logs ;;
  *)
    echo "usage: $0 build|up|down|logs|check" >&2
    exit 2
    ;;
esac
