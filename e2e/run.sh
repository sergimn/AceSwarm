#!/usr/bin/env bash
# End-to-end tests: builds the images, starts the stack with the mock engine, runs Playwright and
# tears everything down.
#
#   e2e/run.sh            build, start, test, stop
#   e2e/run.sh up|down    only start or stop the stack (for running Playwright by hand)
#
# Builds behind a TLS-inspecting proxy can pass its CA bundle with BUILD_CA_FILE=/path/to/ca.crt.
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
  local secret=()
  if [[ -n "${BUILD_CA_FILE:-}" ]]; then
    secret=(--secret "id=build_ca,src=${BUILD_CA_FILE}")
  fi
  for target in controller transcoder netgw; do
    docker build "${secret[@]}" --target "$target" -t "aceswarm-${target}:e2e" .
  done
  docker build "${secret[@]}" --target mock-engine \
    --build-arg MOCK_PEERS=198.51.100.10:8621,198.51.100.11:8621 \
    --build-arg MOCK_VPN_PEERS=203.0.113.10:8621 \
    -t aceswarm-mock-engine:e2e .
  docker build "${secret[@]}" -t aceswarm-wg-server:e2e e2e/wg-server
}

up() {
  compose up -d --wait --wait-timeout 180
}

down() {
  # Engines are created by the controller, not by compose, so they are removed by label.
  docker ps -aq --filter "label=aceswarm.stack=${ACESWARM_STACK_NAME}" | xargs -r docker rm -f >/dev/null
  compose down --volumes --remove-orphans
}

case "${1:-all}" in
  build) build ;;
  up) up ;;
  down) down ;;
  all)
    if [[ "${E2E_SKIP_BUILD:-}" != "1" ]]; then
      build
    fi
    down >/dev/null 2>&1 || true
    trap 'compose logs --no-color > e2e-stack.log 2>&1 || true; down' EXIT
    up
    npx playwright test --config e2e/playwright.config.ts
    ;;
  *)
    echo "usage: $0 [all|build|up|down]" >&2
    exit 2
    ;;
esac
