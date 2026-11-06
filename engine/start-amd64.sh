#!/bin/sh
# Starts the Acestream Linux engine (x86_64). The cache stays in memory to spare disks and SD cards.
set -eu
export HOME=/home/appuser
# ACESWARM_MEMORY_CACHE_BYTES caps the stream data the engine keeps in memory (--memory-cache-limit).
# Without a cap that cache grows for over an hour, past what an engine needs. 0 leaves the size to
# the engine, which picks it from the host's RAM (1 GiB on hosts with 4 GB or more).
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
exec /app/start-engine \
  --client-console \
  --bind-all \
  --log-stdout \
  --disable-sentry \
  --cache-dir "$HOME/.ACEStream/cache" \
  --cache-limit 1 \
  --live-cache-type memory \
  --live-mem-cache-size "${ACESWARM_LIVE_CACHE_BYTES:-104857600}" \
  $cache_limit \
  ${ACESWARM_ENGINE_FLAGS:-} \
  "$@"
