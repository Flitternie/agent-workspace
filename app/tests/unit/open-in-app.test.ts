import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installedApps, launchCommand } from '../../src/main/open-in-app';
import { fileHref, fileLine, parseFileHref, remarkFilePaths } from '../../src/renderer/components/filePaths';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fakeApps(bundles: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'amw-apps-'));
  dirs.push(root);
  for (const [bundle, files] of Object.entries(bundles)) {
    mkdirSync(join(root, bundle), { recursive: true });
    for (const f of files) {
      mkdirSync(join(root, bundle, f, '..'), { recursive: true });
      writeFileSync(join(root, bundle, f), '#!/bin/sh\n');
    }
  }
  return root;
}

describe('open with…', () => {
  it('lists only the catalog apps that are installed, in catalog order', () => {
    const root = fakeApps({ 'Zed.app': ['Contents/MacOS/cli'], 'Visual Studio Code.app': [], 'Fork.app': [], 'Utilities/Terminal.app': [], 'Unknown.app': [] });
    const apps = installedApps([root]);
    expect(apps.map((a) => a.id)).toEqual(['vscode', 'zed', 'fork', 'terminal']);
    // VS Code's bundled CLI is missing in this fake bundle, so no line jumps for it; Zed has its CLI.
    expect(apps.find((a) => a.id === 'vscode')?.lines).toBe(false);
    expect(apps.find((a) => a.id === 'zed')).toMatchObject({ kind: 'editor', lines: true, path: join(root, 'Zed.app') });
    expect(apps.find((a) => a.id === 'terminal')?.path).toBe(join(root, 'Utilities/Terminal.app'));
  });

  it('opens a file at its line with the editor’s own CLI, folders and other apps with open -a', () => {
    const root = fakeApps({ 'Cursor.app': ['Contents/Resources/app/bin/cursor'], 'Sublime Text.app': ['Contents/SharedSupport/bin/subl'], 'Fork.app': [], 'Finder.app': [] });
    const [cursor, sublime, fork, finder] = installedApps([root]);
    expect(launchCommand(cursor, '/p/a.ts', { isFile: true, line: 12 })).toEqual({ cmd: join(cursor.path, 'Contents/Resources/app/bin/cursor'), args: ['-g', '/p/a.ts:12'] });
    expect(launchCommand(sublime, '/p/a.ts', { isFile: true, line: 3 })).toEqual({ cmd: join(sublime.path, 'Contents/SharedSupport/bin/subl'), args: ['/p/a.ts:3'] });
    expect(launchCommand(cursor, '/p/a.ts', { isFile: true })).toEqual({ cmd: 'open', args: ['-a', cursor.path, '/p/a.ts'] });
    expect(launchCommand(cursor, '/p', { isFile: false, line: 5 })).toEqual({ cmd: 'open', args: ['-a', cursor.path, '/p'] });
    expect(launchCommand(fork, '/p', { isFile: false })).toEqual({ cmd: 'open', args: ['-a', fork.path, '/p'] });
    // Finder reveals a file (selected in its folder) and opens a folder.
    expect(launchCommand(finder, '/p/a.ts', { isFile: true, line: 9 })).toEqual({ cmd: 'open', args: ['-R', '/p/a.ts'] });
    expect(launchCommand(finder, '/p', { isFile: false })).toEqual({ cmd: 'open', args: ['/p'] });
  });
});

describe('file lines in agent messages', () => {
  it('reads a line from path:line, path:line:col and #L anchors', () => {
    expect(fileLine('src/a.ts:42')).toBe(42);
    expect(fileLine('src/a.ts:42:7')).toBe(42);
    expect(fileLine('README.md#L10')).toBe(10);
    expect(fileLine('README.md#L10-L20')).toBe(10);
    expect(fileLine('README.md')).toBeUndefined();
    expect(fileLine('a.ts:0')).toBeUndefined();
  });

  it('round-trips path and line through the link', () => {
    expect(parseFileHref(fileHref('/p/a b#c.md', 7))).toEqual({ path: '/p/a b#c.md', line: 7 });
    expect(parseFileHref(fileHref('/p/x.ts'))).toEqual({ path: '/p/x.ts' });
  });

  it('links code spans and link targets with their line', () => {
    const tree: any = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'inlineCode', value: 'src/app.ts:12' }, { type: 'text', value: ' and lib/b.py:3:1, ' }, { type: 'link', url: 'docs/x.md#L4', children: [{ type: 'text', value: 'x' }] }] }],
    };
    remarkFilePaths()(tree);
    const links = tree.children[0].children.filter((c: any) => c.type === 'link').map((c: any) => parseFileHref(c.url));
    expect(links).toEqual([
      { path: 'src/app.ts', line: 12 },
      { path: 'lib/b.py', line: 3 },
      { path: 'docs/x.md', line: 4 },
    ]);
  });
});
