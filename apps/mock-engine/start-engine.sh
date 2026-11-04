#!/bin/sh
# Starts the mock engine in place of the real one (see engine/entrypoint.sh).
set -eu
cd /app/apps/mock-engine
exec node src/main.ts "$@"
