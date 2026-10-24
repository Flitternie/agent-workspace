#!/usr/bin/env bash
# Installs dependencies with every cache kept inside this app folder so nothing
# leaks into the user's global npm / Electron caches.
set -euo pipefail
cd "$(dirname "$0")/.."
export npm_config_cache="$PWD/.cache/npm"
export ELECTRON_CACHE="$PWD/.cache/electron"
export electron_config_cache="$PWD/.cache/electron"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --no-audit --no-fund "$@"
./node_modules/.bin/install-electron
