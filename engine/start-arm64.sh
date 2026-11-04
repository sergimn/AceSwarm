#!/bin/sh
# Starts the Acestream Android engine (arm64) through its Linux wrapper. The cache stays in memory.
set -eu
cd /acestream
# ACESWARM_ENGINE_FLAGS is a space separated list of extra engine options, so it is split on purpose.
# shellcheck disable=SC2086
exec python main.py \
  --bind-all \
  --log-stdout \
  --disable-sentry \
  --disable-upnp \
  --live-cache-type memory \
  --live-mem-cache-size "${ACESWARM_LIVE_CACHE_BYTES:-104857600}" \
  ${ACESWARM_ENGINE_FLAGS:-} \
  "$@"
