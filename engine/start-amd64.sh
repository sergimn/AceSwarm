#!/bin/sh
# Starts the Acestream Linux engine (x86_64). The cache stays in memory to spare disks and SD cards,
# unless ACESWARM_CACHE_DIR names a folder for it (see below).
set -eu
export HOME=/home/appuser
# ACESWARM_MEMORY_CACHE_BYTES caps the stream data the engine keeps in memory (--memory-cache-limit).
# Without a cap that cache grows for over an hour, past what an engine needs. 0 leaves the size to
# the engine, which picks it from the host's RAM (it reached about 1.7 GB in testing).
cache_bytes="${ACESWARM_MEMORY_CACHE_BYTES:-134217728}"
cache_limit=""
case "$cache_bytes" in
  *[!0-9]*)
    echo "ACESWARM_MEMORY_CACHE_BYTES must be a number of bytes, got '$cache_bytes'" >&2
    exit 64
    ;;
  *[!0]*) cache_limit="--memory-cache-limit $cache_bytes" ;;
esac
# ACESWARM_CACHE_DIR is the folder the entrypoint made for this engine when the cache goes to disk
# (ENGINE_CACHE_DIR), and ACESWARM_DISK_CACHE_BYTES the most the engine keeps in it. The engine then
# writes the stream to a file there that it overwrites in place, and uses no memory cache.
# --cache-auto 0 matters: without it the engine sizes the cache by itself, ignores the limit and
# grows the file towards 10 GiB.
disk_bytes="${ACESWARM_DISK_CACHE_BYTES:-0}"
case "$disk_bytes" in
  *[!0-9]*)
    echo "ACESWARM_DISK_CACHE_BYTES must be a number of bytes, got '$disk_bytes'" >&2
    exit 64
    ;;
  *[!0]*)
    if [ -z "${ACESWARM_CACHE_DIR:-}" ]; then
      echo "ACESWARM_DISK_CACHE_BYTES is set, but ACESWARM_CACHE_DIR names no folder for the cache" >&2
      exit 64
    fi
    cache_flags="--cache-dir $ACESWARM_CACHE_DIR --live-cache-type disk --disk-cache-limit $disk_bytes --cache-auto 0"
    ;;
  *)
    cache_flags="--cache-dir $HOME/.ACEStream/cache --cache-limit 1 --live-cache-type memory --live-mem-cache-size ${ACESWARM_LIVE_CACHE_BYTES:-104857600}"
    ;;
esac
# cache_flags, cache_limit and ACESWARM_ENGINE_FLAGS hold space separated engine options, so they are
# split on purpose. None of them holds a value with a space: the entrypoint names the cache folder.
# shellcheck disable=SC2086
exec /app/start-engine \
  --client-console \
  --bind-all \
  --log-stdout \
  --disable-sentry \
  $cache_flags \
  $cache_limit \
  ${ACESWARM_ENGINE_FLAGS:-} \
  "$@"
