#!/bin/sh
# Starts the Acestream Linux engine (x86_64). The cache stays in memory to spare disks and SD cards.
set -eu
export HOME=/home/appuser
# ACESWARM_ENGINE_FLAGS is a space separated list of extra engine options, so it is split on purpose.
# shellcheck disable=SC2086
exec /app/start-engine \
  --client-console \
  --bind-all \
  --log-stdout \
  --disable-sentry \
  --cache-dir "$HOME/.ACEStream/cache" \
  --cache-limit 1 \
  --live-cache-type memory \
  --live-mem-cache-size "${ACESWARM_LIVE_CACHE_BYTES:-104857600}" \
  ${ACESWARM_ENGINE_FLAGS:-} \
  "$@"
