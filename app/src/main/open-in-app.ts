// "Open with…": a folder or a file in an application the user has installed (editors, Git apps,
// terminals, Finder), the way DeepSeek Harness's open-in-app does it. A fixed catalog, each entry
// shown only when its app is actually there; launched with `open -a`, or with the editor's own
// command-line tool from inside its bundle when a line should be shown (no PATH setup needed).

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AppKind = 'editor' | 'git' | 'terminal' | 'files';

interface CatalogEntry {
  id: string;
  name: string;
  kind: AppKind;
  /** Bundle names to look for, in order. */
  bundles: string[];
  /** The editor's CLI inside its bundle and how it opens file:line. */
  line?: { cli: string; args: (file: string, line: number) => string[] };
}

const vscodeLike = (cli: string) => ({ cli, args: (f: string, l: number) => ['-g', `${f}:${l}`] });

export const CATALOG: CatalogEntry[] = [
  { id: 'cursor', name: 'Cursor', kind: 'editor', bundles: ['Cursor.app'], line: vscodeLike('Contents/Resources/app/bin/cursor') },
  { id: 'vscode', name: 'VS Code', kind: 'editor', bundles: ['Visual Studio Code.app'], line: vscodeLike('Contents/Resources/app/bin/code') },
  { id: 'vscode-insiders', name: 'VS Code Insiders', kind: 'editor', bundles: ['Visual Studio Code - Insiders.app'], line: vscodeLike('Contents/Resources/app/bin/code-insiders') },
  { id: 'windsurf', name: 'Windsurf', kind: 'editor', bundles: ['Windsurf.app'], line: vscodeLike('Contents/Resources/app/bin/windsurf') },
  { id: 'zed', name: 'Zed', kind: 'editor', bundles: ['Zed.app', 'Zed Preview.app'], line: { cli: 'Contents/MacOS/cli', args: (f, l) => [`${f}:${l}`] } },
  { id: 'sublime', name: 'Sublime Text', kind: 'editor', bundles: ['Sublime Text.app'], line: { cli: 'Contents/SharedSupport/bin/subl', args: (f, l) => [`${f}:${l}`] } },
  { id: 'xcode', name: 'Xcode', kind: 'editor', bundles: ['Xcode.app', 'Xcode-beta.app'] },
  { id: 'idea', name: 'IntelliJ IDEA', kind: 'editor', bundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app', 'IntelliJ IDEA Ultimate.app'] },
  { id: 'pycharm', name: 'PyCharm', kind: 'editor', bundles: ['PyCharm.app', 'PyCharm CE.app', 'PyCharm Professional Edition.app'] },
  { id: 'webstorm', name: 'WebStorm', kind: 'editor', bundles: ['WebStorm.app'] },
  { id: 'goland', name: 'GoLand', kind: 'editor', bundles: ['GoLand.app'] },
  { id: 'rustrover', name: 'RustRover', kind: 'editor', bundles: ['RustRover.app'] },
  { id: 'android-studio', name: 'Android Studio', kind: 'editor', bundles: ['Android Studio.app'] },
  { id: 'fork', name: 'Fork', kind: 'git', bundles: ['Fork.app'] },
  { id: 'tower', name: 'Tower', kind: 'git', bundles: ['Tower.app'] },
  { id: 'github-desktop', name: 'GitHub Desktop', kind: 'git', bundles: ['GitHub Desktop.app'] },
  { id: 'sourcetree', name: 'Sourcetree', kind: 'git', bundles: ['Sourcetree.app'] },
  { id: 'gitkraken', name: 'GitKraken', kind: 'git', bundles: ['GitKraken.app'] },
  { id: 'sublime-merge', name: 'Sublime Merge', kind: 'git', bundles: ['Sublime Merge.app'] },
  { id: 'ghostty', name: 'Ghostty', kind: 'terminal', bundles: ['Ghostty.app'] },
  { id: 'warp', name: 'Warp', kind: 'terminal', bundles: ['Warp.app'] },
  { id: 'iterm', name: 'iTerm2', kind: 'terminal', bundles: ['iTerm.app'] },
  { id: 'terminal', name: 'Terminal', kind: 'terminal', bundles: ['Utilities/Terminal.app', 'Terminal.app'] },
  { id: 'finder', name: 'Finder', kind: 'files', bundles: ['Finder.app'] },
];

/** Where apps live; tests point it elsewhere (AMW_APPS_DIRS). */
function appDirs(): string[] {
  const env = process.env.AMW_APPS_DIRS;
  if (env) return env.split(':').filter(Boolean);
  return ['/Applications', join(homedir(), 'Applications'), '/System/Applications', '/System/Library/CoreServices'];
}

export interface InstalledApp {
  id: string;
  name: string;
  kind: AppKind;
  path: string;
  /** Can open a file at a line. */
  lines: boolean;
}

/** The catalog entries installed here (Finder always, on macOS). */
export function installedApps(dirs = appDirs()): InstalledApp[] {
  if (process.platform !== 'darwin' && !process.env.AMW_APPS_DIRS) return [];
  const out: InstalledApp[] = [];
  for (const e of CATALOG) {
    const path = e.bundles.flatMap((b) => dirs.map((d) => join(d, b))).find((p) => existsSync(p));
    if (path) out.push({ id: e.id, name: e.name, kind: e.kind, path, lines: !!e.line && existsSync(join(path, e.line.cli)) });
  }
  return out;
}

/** What to run: the editor's CLI for a file at a line, `open -R` to reveal a file in Finder, else `open -a`. */
export function launchCommand(app: InstalledApp, target: string, opts: { isFile: boolean; line?: number }): { cmd: string; args: string[] } {
  const entry = CATALOG.find((e) => e.id === app.id)!;
  if (opts.isFile && opts.line && entry.line && app.lines) return { cmd: join(app.path, entry.line.cli), args: entry.line.args(target, opts.line) };
  if (app.kind === 'files') return { cmd: 'open', args: opts.isFile ? ['-R', target] : [target] };
  return { cmd: 'open', args: ['-a', app.path, target] };
}

/** Starts it detached (the app outlives this one); tests record it instead (AMW_OPEN_RECORD). */
export function launch(command: { cmd: string; args: string[] }): void {
  const record = process.env.AMW_OPEN_RECORD;
  if (record) {
    appendFileSync(record, `${JSON.stringify(command)}\n`);
    return;
  }
  const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

const run = promisify(execFile);

/**
 * An app's own icon as a PNG data URL: the bundle's .icns (Info.plist CFBundleIconFile), converted with
 * the system's sips and cached on disk by bundle path and change time. Undefined when there is none.
 */
export async function bundleIcon(appPath: string, cacheDir: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const plist = join(appPath, 'Contents', 'Info.plist');
    let name = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', plist])).stdout.trim();
    if (!name) return undefined;
    if (!/\.icns$/i.test(name)) name += '.icns';
    const icns = join(appPath, 'Contents', 'Resources', name);
    if (!existsSync(icns)) return undefined;
    mkdirSync(cacheDir, { recursive: true });
    const key = `${appPath}:${statSync(icns).mtimeMs}`.replace(/[^\w.-]+/g, '_').slice(-180);
    const png = join(cacheDir, `${key}.png`);
    if (!existsSync(png)) await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', png]);
    return `data:image/png;base64,${readFileSync(png).toString('base64')}`;
  } catch {
    return undefined;
  }
}
