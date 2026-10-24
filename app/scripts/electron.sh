#!/usr/bin/env bash
# Launches the built app. App data lives in app/.data (demo: app/.data-demo) unless AMW_DATA_DIR is set.
set -euo pipefail
cd "$(dirname "$0")/.."
unset ELECTRON_RUN_AS_NODE
exec ./node_modules/.bin/electron . "$@"
