// electron-builder 26 builds DMGs with dmgbuild and, whenever a background image is set, ignores
// `dmg.window`: the window takes the image's size as its frame (so the title bar hides the bottom of
// the image) and opens at y = (1440 - height) / 2, below the bottom edge of a laptop screen. This makes
// it honour `dmg.window` (position and frame size). It fails loudly if dmg-builder changed, rather
// than silently building the old window again.
const fs = require('node:fs');
const file = require.resolve('dmg-builder/out/dmgUtil.js', { paths: [require('node:path').join(__dirname, '..')] });
const MARK = '/* amw: honour dmg.window */';
const OLD = 'settings.window = { position: { x: 400, y: Math.round((1440 - size.height) / 2) }, size, ...settings.window };';
const NEW = `${MARK} const w = specification.window || {}; settings.window = { position: { x: w.x ?? 400, y: w.y ?? 100 }, size: { width: w.width ?? size.width, height: w.height ?? size.height } };`;
const src = fs.readFileSync(file, 'utf8');
if (src.includes(MARK)) process.exit(0);
if (!src.includes(OLD)) {
  console.error(`patch-dmg-builder: ${file} no longer has the line this patches; check whether dmg.window is honoured now and update or drop this patch.`);
  process.exit(1);
}
fs.writeFileSync(file, src.replace(OLD, NEW));
console.log('patch-dmg-builder: dmg.window is honoured');
