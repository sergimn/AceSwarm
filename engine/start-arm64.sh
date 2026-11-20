#!/bin/sh
# Starts the Acestream Android engine (arm64) through its Linux wrapper. The stream cache stays in
# memory unless ACESWARM_CACHE_DIR names a folder for it (see below).
set -eu
cd /acestream
# ACESWARM_MEMORY_CACHE_BYTES caps the stream data the engine keeps in memory (--memory-cache-limit).
# Without a cap that cache grows for over an hour, past what an engine needs. 0 leaves the size to
# the engine, which picks it from the host's RAM (1 GiB on hosts with 4 GB or more).
live_bytes="${ACESWARM_LIVE_CACHE_BYTES:-104857600}"
case "$live_bytes" in
  ""|*[!0-9]*)
    echo "ACESWARM_LIVE_CACHE_BYTES must be a number of bytes, got '$live_bytes'" >&2
    exit 64
    ;;
esac
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
# (ENGINE_CACHE_DIR), and ACESWARM_DISK_CACHE_BYTES the most the engine keeps in it. The same options
# as on x86_64 (see start-amd64.sh). The bridge of the arm64 engine lacks the disk-space calls the
# engine makes for the cache folder, so arm64-shim.py answers them.
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
    cache_flags="--live-cache-type memory --live-mem-cache-size $live_bytes"
    ;;
esac
# cache_flags, cache_limit and ACESWARM_ENGINE_FLAGS hold space separated engine options, so they are
# split on purpose. None of them holds a value with a space: the entrypoint names the cache folder.
# The shim answers the disk-space calls and then runs the engine's main.py with these options.
# shellcheck disable=SC2086
exec python /usr/local/lib/aceswarm/arm64-shim.py \
  --bind-all \
  --log-stdout \
  --disable-sentry \
  --disable-upnp \
  $cache_flags \
  $cache_limit \
  ${ACESWARM_ENGINE_FLAGS:-} \
  "$@"
