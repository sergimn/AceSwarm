#!/usr/bin/env bash
# The AceSwarm side of the multi-machine E2E tests: builds the images (with the real engine image,
# not the mock) and starts or stops the stack. See e2e/README.md.
#
#   e2e/multi/stack.sh build|up|down|logs
set -euo pipefail
cd "$(dirname "$0")/../.."

export COMPOSE_PROJECT_NAME=aceswarm-e2e
export COMPOSE_PROFILES=""
export ACESWARM_STACK_NAME=aceswarm-e2e
export ACESWARM_ENGINE_NETWORK=aceswarm-e2e_engines
export E2E_HTTP_PORT="${E2E_HTTP_PORT:-18080}"

compose() {
  docker compose -f compose.yaml -f e2e/multi/compose.multi.yaml "$@"
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
  local engine
  for engine in $(docker ps -aq --filter "label=aceswarm.stack=${ACESWARM_STACK_NAME}"); do
    echo "--- engine $(docker inspect -f '{{.Name}}' "$engine")"
    # Drops noise: a disk probe that fails in containers and crash-report retries.
    docker logs "$engine" 2>&1 | grep -vE 'disk/by-id|raven' | tail -60
  done
}

case "${1:-}" in
  build) build ;;
  up) compose up -d --wait --wait-timeout 180 ;;
  down) down ;;
  logs) logs ;;
  *)
    echo "usage: $0 build|up|down|logs" >&2
    exit 2
    ;;
esac
