#!/bin/sh
# Starts the Acestream Android engine (arm64) through its Linux wrapper. Its cache is always in
# memory: this engine cannot keep it on disk (see below).
set -eu
cd /acestream
# ACESWARM_MEMORY_CACHE_BYTES caps the stream data the engine keeps in memory (--memory-cache-limit).
# Without a cap that cache grows for over an hour, past what an engine needs. 0 leaves the size to
# the engine, which picks it from the host's RAM (1 GiB on hosts with 4 GB or more).
cache_bytes="${ACESWARM_MEMORY_CACHE_BYTES:-134217728}"
cache_limit=""
case "$cache_bytes" in
  *[!0-9]*)
    echo "ACESWARM_MEMORY_CACHE_BYTES must be a number of bytes, got '$cache_bytes'" >&2
    exit 64
    ;;
  *[!0]*) cache_limit="--memory-cache-limit $cache_bytes" ;;
esac
# ACESWARM_DISK_CACHE_BYTES asks for the cache on disk (ENGINE_CACHE_DIR). The Android engine
# cannot do that: when it starts it sets its stream cache to memory, whatever --live-cache-type
# says, and its wrapper lacks the Android calls it asks for free disk space with. It would take
# the options and keep everything in memory, so it is refused here, with the entrypoint's exit
# code for a cache that cannot be set up. The controller refuses the setting on arm64 before any
# engine starts.
disk_bytes="${ACESWARM_DISK_CACHE_BYTES:-0}"
case "$disk_bytes" in
  *[!0-9]*)
    echo "ACESWARM_DISK_CACHE_BYTES must be a number of bytes, got '$disk_bytes'" >&2
    exit 64
    ;;
  *[!0]*)
    echo "engine cache on disk: the arm64 engine cannot keep its stream cache on disk. ENGINE_CACHE_DIR" \
      "works on x86_64 only: leave it empty here, and lower ENGINE_MEMORY_CACHE_MB to use less memory." >&2
    exit 78
    ;;
esac
cache_flags="--live-cache-type memory --live-mem-cache-size ${ACESWARM_LIVE_CACHE_BYTES:-104857600}"
# cache_flags, cache_limit and ACESWARM_ENGINE_FLAGS hold space separated engine options, so they are
# split on purpose. None of them holds a value with a space: the entrypoint names the cache folder.
# shellcheck disable=SC2086
exec python main.py \
  --bind-all \
  --log-stdout \
  --disable-sentry \
  --disable-upnp \
  $cache_flags \
  $cache_limit \
  ${ACESWARM_ENGINE_FLAGS:-} \
  "$@"
