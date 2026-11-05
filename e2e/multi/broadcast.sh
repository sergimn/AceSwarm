#!/usr/bin/env bash
# Broadcasts a dummy live stream with a real Acestream engine (the x86_64 Linux engine 3.2.11) for
# the multi-machine E2E tests. See e2e/README.md for diagrams.
#
#  - ffmpeg makes a test pattern with a tone and serves it as HTTP MPEG-TS on 127.0.0.1:18000.
#  - The engine runs as a broadcast source (--stream-source) on the host network, reads that stream
#    and writes the transport file test.acelive. Players find it by its infohash.
#  - The source's built-in tracker refuses every announce ("not authorized"), so the source and the
#    players announce to e2e/multi/tracker.ts (port 7700) instead.
#
#   broadcast.sh start HOST   HOST: the address players reach this machine on (its mesh address)
#   broadcast.sh wait         waits until the source is live and prints the infohash
#   broadcast.sh logs         prints the logs of every part
#   broadcast.sh stop
#
# Writes to $BC_DIR: publish/test.acelive, tracker.log and the engine's state and cache.
set -euo pipefail

BC_DIR="${BC_DIR:-${RUNNER_TEMP:-/tmp}/broadcast}"
ENGINE_IMAGE="${BROADCAST_ENGINE_IMAGE:-ghcr.io/martinbjeldbak/acestream-http-proxy:3.5.1@sha256:2679f0473013d1b73ca56c77866ab77f4fd8874012d3f7c36b43c5adf6a8bdca}"
# The same static ffmpeg build the AceSwarm images use (see the Dockerfile).
FFMPEG_IMAGE="${BROADCAST_FFMPEG_IMAGE:-docker.io/mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b}"
SOURCE=aceswarm-broadcast-input
ENGINE=aceswarm-broadcast
here="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[broadcast %s] %s\n' "$(date +%T)" "$*" >&2; }

start() {
  local host="$1"
  mkdir -p "$BC_DIR/publish" "$BC_DIR/cache" "$BC_DIR/state"
  # The engine runs as uid 1000 inside its image.
  chmod 0777 "$BC_DIR/publish" "$BC_DIR/cache" "$BC_DIR/state"
  docker rm -f "$SOURCE" "$ENGINE" >/dev/null 2>&1 || true

  nohup node "$here/tracker.ts" --port 7700 --host "$host" >"$BC_DIR/tracker.log" 2>&1 &
  echo $! >"$BC_DIR/tracker.pid"

  # ffmpeg's HTTP server serves one client, then exits; Docker restarts it for the next reconnect.
  # About 1.3 Mbit/s: 960x540 H.264 at 25 fps with AAC audio.
  docker run -d --name "$SOURCE" --network host --restart always "$FFMPEG_IMAGE" \
    -hide_banner -loglevel error -re \
    -f lavfi -i "testsrc2=size=960x540:rate=25" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
    -b:v 1200k -maxrate 1200k -bufsize 600k -g 50 -c:a aac -b:a 96k \
    -f mpegts -listen 1 http://127.0.0.1:18000/live.ts >/dev/null

  # PYCRYPTODOME_INTEGER=native: the image's pycryptodome 4 rejects the negative intermediate values
  # the engine's RSA key generation (the broadcast's signing key) relies on.
  docker run -d --name "$ENGINE" --network host -e PYCRYPTODOME_INTEGER=native \
    -v "$BC_DIR:/broadcast" --entrypoint /app/start-engine "$ENGINE_IMAGE" \
    --stream-source --name test --title "AceSwarm E2E" --quality SD --category entertaining \
    --source http://127.0.0.1:18000/live.ts --bitrate 175000 \
    --skip-internal-tracker --tracker "http://$host:7700/announce" --port 7764 \
    --publish-dir /broadcast/publish --cache-dir /broadcast/cache --state-dir /broadcast/state \
    --log-stdout >/dev/null
  log "broadcast source starting (tracker http://$host:7700/announce)"
}

# The cache file is named after the broadcast's infohash: live.<infohash>.0
infohash() {
  find "$BC_DIR/cache" -maxdepth 1 -name 'live.*.0' -printf '%f\n' 2>/dev/null |
    sed -nE 's/^live\.([0-9a-f]{40})\.0$/\1/p' | head -1
}

wait_ready() {
  for _ in $(seq 1 120); do
    if [[ -s "$BC_DIR/publish/test.acelive" && -n "$(infohash)" ]] &&
      docker logs "$ENGINE" 2>&1 | grep 'stream status changed: -1->1' >/dev/null; then
      log "live: infohash $(infohash)"
      infohash
      return 0
    fi
    [[ "$(docker inspect -f '{{.State.Running}}' "$ENGINE" 2>/dev/null)" == true ]] || break
    sleep 1
  done
  logs >&2
  log "the broadcast did not start"
  return 1
}

logs() {
  echo "--- tracker"
  cat "$BC_DIR/tracker.log" 2>/dev/null || true
  echo "--- ffmpeg"
  docker logs "$SOURCE" 2>&1 | tail -20 || true
  echo "--- broadcast engine"
  # Drops noise: a disk probe that fails in containers and crash-report retries.
  docker logs "$ENGINE" 2>&1 | grep -vE 'disk/by-id|raven' | tail -80 || true
}

stop() {
  docker rm -f "$SOURCE" "$ENGINE" >/dev/null 2>&1 || true
  if [[ -f "$BC_DIR/tracker.pid" ]]; then
    kill "$(cat "$BC_DIR/tracker.pid")" 2>/dev/null || true
  fi
}

case "${1:-}" in
  start) start "$2" ;;
  wait) wait_ready ;;
  logs) logs ;;
  stop) stop ;;
  *)
    sed -n '2,17p' "$0" >&2
    exit 2
    ;;
esac
