#!/bin/sh
# Starts the Acestream Android engine (arm64) through its Linux wrapper. The cache stays in memory.
set -eu
cd /acestream
# ACESWARM_MEMORY_CACHE_BYTES caps the stream data the engine keeps in memory (--memory-cache-limit).
# Without a cap that cache grows for over an hour, past what an engine needs. 0 leaves it uncapped.
cache_bytes="${ACESWARM_MEMORY_CACHE_BYTES:-536870912}"
cache_limit=""
case "$cache_bytes" in
  *[!0-9]*)
    echo "ACESWARM_MEMORY_CACHE_BYTES must be a number of bytes, got '$cache_bytes'" >&2
    exit 64
    ;;
  *[!0]*) cache_limit="--memory-cache-limit $cache_bytes" ;;
esac
# cache_limit and ACESWARM_ENGINE_FLAGS hold space separated engine options, so they are split on purpose.
# shellcheck disable=SC2086
exec python main.py \
  --bind-all \
  --log-stdout \
  --disable-sentry \
  --disable-upnp \
  --live-cache-type memory \
  --live-mem-cache-size "${ACESWARM_LIVE_CACHE_BYTES:-104857600}" \
  $cache_limit \
  ${ACESWARM_ENGINE_FLAGS:-} \
  "$@"
