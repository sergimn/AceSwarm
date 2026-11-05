#!/usr/bin/env bash
# Temporary probe (removed before review): does a private broadcast get a content ID that a fresh
# engine can resolve?
set -uo pipefail
cd "$(dirname "$0")/../.."
IMAGE="ghcr.io/martinbjeldbak/acestream-http-proxy:3.5.1@sha256:2679f0473013d1b73ca56c77866ab77f4fd8874012d3f7c36b43c5adf6a8bdca"
BC="$RUNNER_TEMP/broadcast"
api() {
  echo "== $1"
  curl -s -m 30 "$1" | head -c 3000
  echo
}

host="$(hostname -I | awk '{print $1}')"
e2e/multi/broadcast.sh start "$host"
ih="$(e2e/multi/broadcast.sh wait)"
echo "### infohash $ih"
ls -la "$BC/publish" "$BC/cache" "$BC/state"
sha1sum "$BC/publish/test.acelive"
xxd "$BC/publish/test.acelive" | head -60
echo "### source logs"
docker logs aceswarm-broadcast 2>&1 | grep -vE 'disk/by-id|raven' | head -150

echo "### file info"
for flag in --get-infohash --get-file-info --get-file-info-with-id; do
  echo "== $flag"
  docker run --rm -e PYCRYPTODOME_INTEGER=native -v "$BC/publish:/p:ro" --entrypoint /app/start-engine "$IMAGE" \
    "$flag" /p/test.acelive 2>&1 | grep -vE 'disk/by-id|raven' | tail -30
done

echo "### player"
docker run -d --name player --network host -e PYCRYPTODOME_INTEGER=native --entrypoint /app/start-engine "$IMAGE" \
  --client-console --bind-all --log-stdout --cache-dir /tmp/player-cache >/dev/null
P=http://127.0.0.1:6878
for _ in $(seq 1 30); do
  curl -sf -m 3 "$P/webui/api/service?method=get_version&format=json" >/dev/null && break
  sleep 2
done
api "$P/webui/api/service?method=get_version&format=json"
for m in get_content_id get_media_files; do
  api "$P/server/api?api_version=3&method=$m&infohash=$ih"
done
api "$P/ace/getstream?infohash=$ih&format=json"
candidates="$(sha1sum "$BC/publish/test.acelive" | cut -c1-40)"
found="$(curl -s -m 30 "$P/server/api?api_version=3&method=get_content_id&infohash=$ih" | grep -oE '[0-9a-f]{40}' | sort -u)"
found_src="$(for flag in --get-file-info --get-file-info-with-id; do docker run --rm -e PYCRYPTODOME_INTEGER=native -v "$BC/publish:/p:ro" --entrypoint /app/start-engine "$IMAGE" "$flag" /p/test.acelive 2>&1; done | grep -oE '[0-9a-f]{40}' | sort -u)"
logs_ids="$(docker logs aceswarm-broadcast 2>&1 | grep -iE 'content|cid' | grep -oE '[0-9a-f]{40}' | sort -u)"
for cid in $candidates $found $found_src $logs_ids; do
  [[ "$cid" == "$ih" ]] && continue
  echo "### try content id $cid"
  api "$P/ace/getstream?id=$cid&format=json"
done
sleep 20
echo "### player logs"
docker logs player 2>&1 | grep -vE 'disk/by-id|raven' | tail -120
