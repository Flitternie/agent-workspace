#!/usr/bin/env bash
# Packages the app with electron-builder (DMG on macOS, NSIS installer on Windows).
# Every cache stays inside app/.cache, as with setup.sh. Extra args go to electron-builder,
# e.g. `--publish always` in CI.
set -euo pipefail
cd "$(dirname "$0")/.."
export npm_config_cache="$PWD/.cache/npm"
export ELECTRON_CACHE="$PWD/.cache/electron"
export electron_config_cache="$PWD/.cache/electron"
export ELECTRON_BUILDER_CACHE="$PWD/.cache/electron-builder"
# No Apple Developer ID here: build unsigned (ad-hoc on Apple Silicon) unless CSC_* is provided.
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"
npm run build
./node_modules/.bin/electron-builder "$@"

# The mounted volume already shows the app icon (.VolumeIcon.icns); also give the .dmg file
# itself the icon in Finder. It is kept when the file is copied or AirDropped, but browsers
# drop it on download, as for any .dmg.
if [[ "$(uname)" == Darwin ]]; then
  for dmg in release/*.dmg; do
    [[ -e "$dmg" ]] || continue
    /usr/bin/osascript -l JavaScript - "$PWD/build/icon.icns" "$PWD/$dmg" <<'JXA' >/dev/null
ObjC.import('AppKit');
function run(argv) {
  const image = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  return $.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[1], 0);
}
JXA
  done
fi
