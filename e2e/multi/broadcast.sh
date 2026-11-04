#!/usr/bin/env bash
# Broadcasts a dummy live stream with a real Acestream engine (x86_64 Linux engine 3.2.11), for the
# multi-machine E2E tests. ffmpeg makes a test pattern with a tone and serves it as HTTP MPEG-TS;
# the engine runs as a broadcast source ("--stream-source") on the host network and writes the
# transport file (test.acelive), which is served over HTTP for players. The source's built-in
# tracker refuses every announce, so it announces to e2e/multi/tracker.ts instead.
#
#   broadcast.sh start HOST     HOST: the address players reach this machine on
#   broadcast.sh wait           waits until the source reads its input and the transport file exists
#   broadcast.sh stop
#
# Ports: 7764 (P2P), 7700 (tracker), 18000 (HTTP source, local only), 18001 (transport file).
set -euo pipefail

BC_DIR="${BC_DIR:-${RUNNER_TEMP:-/tmp}/broadcast}"
ENGINE_IMAGE="${BROADCAST_ENGINE_IMAGE:-ghcr.io/martinbjeldbak/acestream-http-proxy:3.5.1@sha256:2679f0473013d1b73ca56c77866ab77f4fd8874012d3f7c36b43c5adf6a8bdca}"
FFMPEG_IMAGE="${BROADCAST_FFMPEG_IMAGE:-}"
NAME=aceswarm-broadcast

log() { printf '[broadcast %s] %s\n' "$(date +%T)" "$*" >&2; }

source_loop() {
  # ffmpeg's HTTP server serves one client and exits, so it is restarted for the engine's reconnects.
  while true; do
    ffmpeg -hide_banner -loglevel error -re \
      -f lavfi -i "testsrc2=size=960x540:rate=25" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
      -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -b:v 1200k -maxrate 1200k -bufsize 600k \
      -g 50 -c:a aac -b:a 96k -f mpegts -listen 1 "http://127.0.0.1:18000/live.ts" || true
    sleep 0.5
  done
}

start() {
  local host="$1"
  mkdir -p "$BC_DIR/publish" "$BC_DIR/cache" "$BC_DIR/state"
  # The engine runs as uid 1000 inside its image.
  chmod 0777 "$BC_DIR/publish" "$BC_DIR/cache" "$BC_DIR/state"
  if [[ -z "$FFMPEG_IMAGE" ]] && ! command -v ffmpeg >/dev/null; then
    sudo apt-get install -y -qq ffmpeg >/dev/null
  fi
  export -f source_loop
  nohup bash -c source_loop >"$BC_DIR/source.log" 2>&1 &
  echo $! >"$BC_DIR/source.pid"
  nohup python3 -m http.server 18001 --directory "$BC_DIR/publish" >"$BC_DIR/http.log" 2>&1 &
  echo $! >"$BC_DIR/http.pid"
  nohup node "$(dirname "$0")/tracker.ts" --port 7700 >"$BC_DIR/tracker.log" 2>&1 &
  echo $! >"$BC_DIR/tracker.pid"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # PYCRYPTODOME_INTEGER=native: the image's pycryptodome 4 rejects the negative intermediate values
  # the engine's RSA key generation (for the broadcast's signing key) relies on.
  docker run -d --name "$NAME" --network host -e PYCRYPTODOME_INTEGER=native \
    -v "$BC_DIR:/broadcast" --entrypoint /app/start-engine "$ENGINE_IMAGE" \
    --stream-source --name test --title "AceSwarm E2E" --quality SD --category entertaining \
    --source http://127.0.0.1:18000/live.ts --bitrate 175000 \
    --skip-internal-tracker --tracker "http://$host:7700/announce" --port 7764 \
    --publish-dir /broadcast/publish --cache-dir /broadcast/cache --state-dir /broadcast/state \
    --log-stdout >/dev/null
  log "broadcast source starting (tracker http://$host:7700/announce)"
}

wait_ready() {
  for _ in $(seq 1 120); do
    if [[ -s "$BC_DIR/publish/test.acelive" ]] && docker logs "$NAME" 2>&1 | grep -q 'stream status changed: -1->1'; then
      log "transport file ready"
      return 0
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]]; then
      break
    fi
    sleep 1
  done
  docker logs --tail 40 "$NAME" >&2 || true
  log "broadcast did not start"
  return 1
}

stop() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  local name
  for name in source http tracker; do
    if [[ -f "$BC_DIR/$name.pid" ]]; then
      pkill -P "$(cat "$BC_DIR/$name.pid")" 2>/dev/null || true
      kill "$(cat "$BC_DIR/$name.pid")" 2>/dev/null || true
    fi
  done
  pkill -f 'ffmpeg .*127.0.0.1:18000' 2>/dev/null || true
}

case "${1:-}" in
  start) start "$2" ;;
  wait) wait_ready ;;
  stop) stop ;;
  *)
    sed -n '2,12p' "$0" >&2
    exit 2
    ;;
esac
