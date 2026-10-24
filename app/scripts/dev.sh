#!/usr/bin/env bash
# Vite dev server for the renderer + Electron pointed at it.
set -euo pipefail
cd "$(dirname "$0")/.."
unset ELECTRON_RUN_AS_NODE
./node_modules/.bin/vite --config vite.config.ts &
VITE_PID=$!
trap 'kill $VITE_PID 2>/dev/null || true' EXIT
sleep 2
VITE_DEV_SERVER_URL=http://localhost:5199 ./node_modules/.bin/electron . "$@"
