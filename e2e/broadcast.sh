#!/usr/bin/env bash
# Broadcasts dummy live streams with real Acestream engines (the x86_64 Linux engine 3.2.11) for
# the end-to-end tests. See e2e/README.md for diagrams.
#
#  - For each broadcast N, ffmpeg makes a test pattern with a tone and serves it as HTTP MPEG-TS
#    on 127.0.0.1:1800N. Each one has its own colours and pitch, so their tiles look different.
#  - An engine per broadcast runs as a broadcast source (--stream-source) on the host network, on
#    P2P port 776(3+N). It reads its stream and writes the transport file bcN.acelive. Players find
#    a broadcast by its infohash or its content ID.
#  - The sources' built-in tracker refuses every announce ("not authorized"), so the sources and
#    the players announce to e2e/tracker.ts (port 7700) instead.
#
#   broadcast.sh start HOST [COUNT]   HOST: the address players reach this machine on (its mesh
#                                     address). COUNT broadcasts, 3 by default.
#   broadcast.sh wait                 waits until every broadcast is live and prints them as JSON:
#                                     [{"name": "bc1", "infohash": "...", "contentId": "..."}, ...]
#   broadcast.sh logs                 prints the logs of every part
#   broadcast.sh stop
#
# Writes to $BC_DIR: N/publish/bcN.acelive, N/cache, N/state and tracker.log.
set -euo pipefail

BC_DIR="${BC_DIR:-${RUNNER_TEMP:-/tmp}/broadcast}"
ENGINE_IMAGE="${BROADCAST_ENGINE_IMAGE:-ghcr.io/martinbjeldbak/acestream-http-proxy:3.5.1@sha256:2679f0473013d1b73ca56c77866ab77f4fd8874012d3f7c36b43c5adf6a8bdca}"
# The same static ffmpeg build the AceSwarm images use (see the Dockerfile).
FFMPEG_IMAGE="${BROADCAST_FFMPEG_IMAGE:-docker.io/mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b}"
SOURCE=aceswarm-broadcast-input
ENGINE=aceswarm-broadcast
here="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[broadcast %s] %s\n' "$(date +%T)" "$*" >&2; }

count() { cat "$BC_DIR/count" 2>/dev/null || echo 0; }

start() {
  local host="$1" total="${2:-3}" n
  mkdir -p "$BC_DIR"
  echo "$total" >"$BC_DIR/count"
  nohup node "$here/tracker.ts" --port 7700 --host "$host" >"$BC_DIR/tracker.log" 2>&1 &
  echo $! >"$BC_DIR/tracker.pid"
  for n in $(seq 1 "$total"); do
    start_one "$host" "$n"
  done
  log "$total broadcast sources starting (tracker http://$host:7700/announce)"
}

start_one() {
  local host="$1" n="$2" dir="$BC_DIR/$2"
  mkdir -p "$dir/publish" "$dir/cache" "$dir/state"
  # The engine runs as uid 1000 inside its image.
  chmod 0777 "$dir/publish" "$dir/cache" "$dir/state"
  docker rm -f "$SOURCE-$n" "$ENGINE-$n" >/dev/null 2>&1 || true

  # ffmpeg's HTTP server serves one client, then exits; Docker restarts it for the next reconnect.
  # About 1.3 Mbit/s: 960x540 H.264 at 25 fps with AAC audio.
  docker run -d --name "$SOURCE-$n" --network host --restart always "$FFMPEG_IMAGE" \
    -hide_banner -loglevel error -re \
    -f lavfi -i "testsrc2=size=960x540:rate=25" -f lavfi -i "sine=frequency=$((330 + 110 * n)):sample_rate=48000" \
    -vf "hue=h=$((120 * (n - 1)))" \
    -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
    -b:v 1200k -maxrate 1200k -bufsize 600k -g 50 -c:a aac -b:a 96k \
    -f mpegts -listen 1 "http://127.0.0.1:$((18000 + n))/live.ts" >/dev/null

  # PYCRYPTODOME_INTEGER=native: the image's pycryptodome 4 rejects the negative intermediate values
  # the engine's RSA key generation (the broadcast's signing key) relies on.
  docker run -d --name "$ENGINE-$n" --network host -e PYCRYPTODOME_INTEGER=native \
    -v "$dir:/broadcast" --entrypoint /app/start-engine "$ENGINE_IMAGE" \
    --stream-source --name "bc$n" --title "AceSwarm E2E $n" --quality SD --category entertaining \
    --source "http://127.0.0.1:$((18000 + n))/live.ts" --bitrate 175000 \
    --skip-internal-tracker --tracker "http://$host:7700/announce" --port "$((7763 + n))" \
    --publish-dir /broadcast/publish --cache-dir /broadcast/cache --state-dir /broadcast/state \
    --log-stdout >/dev/null
}

# The cache file is named after the broadcast's infohash: live.<infohash>.0
infohash() {
  find "$BC_DIR/$1/cache" -maxdepth 1 -name 'live.*.0' -printf '%f\n' 2>/dev/null |
    sed -nE 's/^live\.([0-9a-f]{40})\.0$/\1/p' | head -1
}

# The content ID (what acestream:// links carry) is derived from the transport file. Players
# resolve it through Acestream's lookup service, like the infohash.
content_id() {
  docker run --rm -e PYCRYPTODOME_INTEGER=native -v "$BC_DIR/$1/publish:/publish:ro" \
    --entrypoint /app/start-engine "$ENGINE_IMAGE" --get-file-info-with-id "/publish/bc$1.acelive" 2>/dev/null |
    grep -oE '"content_id": "[0-9a-f]{40}"' | grep -oE '[0-9a-f]{40}'
}

live() {
  local n="$1"
  [[ -s "$BC_DIR/$n/publish/bc$n.acelive" && -n "$(infohash "$n")" ]] &&
    docker logs "$ENGINE-$n" 2>&1 | grep 'stream status changed: -1->1' >/dev/null
}

describe() {
  local n ih cid
  for n in $(seq 1 "$(count)"); do
    ih="$(infohash "$n")"
    cid="$(content_id "$n" || true)"
    if [[ -z "$cid" ]]; then
      log "bc$n: no content ID in its transport file"
      return 1
    fi
    log "bc$n live: infohash $ih, content ID $cid"
    jq -n --arg name "bc$n" --arg infohash "$ih" --arg contentId "$cid" \
      '{name: $name, infohash: $infohash, contentId: $contentId}'
  done | jq -s .
}

wait_ready() {
  local n waiting
  for _ in $(seq 1 120); do
    waiting=0
    for n in $(seq 1 "$(count)"); do
      if ! live "$n"; then
        waiting=1
        [[ "$(docker inspect -f '{{.State.Running}}' "$ENGINE-$n" 2>/dev/null)" == true ]] || break 2
      fi
    done
    if ((waiting == 0)); then
      describe
      return 0
    fi
    sleep 1
  done
  logs >&2
  log "the broadcasts did not start"
  return 1
}

logs() {
  local n
  echo "--- tracker"
  cat "$BC_DIR/tracker.log" 2>/dev/null || true
  for n in $(seq 1 "$(count)"); do
    echo "--- ffmpeg $n"
    docker logs "$SOURCE-$n" 2>&1 | tail -20 || true
    echo "--- broadcast engine $n"
    # Drops noise: a disk probe that fails in containers and crash-report retries.
    docker logs "$ENGINE-$n" 2>&1 | grep -vE 'disk/by-id|raven' | tail -80 || true
  done
}

stop() {
  local n
  for n in $(seq 1 "$(count)"); do
    docker rm -f "$SOURCE-$n" "$ENGINE-$n" >/dev/null 2>&1 || true
  done
  if [[ -f "$BC_DIR/tracker.pid" ]]; then
    kill "$(cat "$BC_DIR/tracker.pid")" 2>/dev/null || true
  fi
}

case "${1:-}" in
  start) start "${@:2}" ;;
  wait) wait_ready ;;
  logs) logs ;;
  stop) stop ;;
  *)
    sed -n '2,20p' "$0" >&2
    exit 2
    ;;
esac
