import { describe, expect, it } from 'vitest';
import { foldersOf, matchFiles, mentionAt, mentionText } from '../../src/shared/file-match';

const files = ['README.md', 'package.json', 'src/main/workspace.ts', 'src/main/providers/codex.ts', 'src/renderer/components/FocusView.tsx', 'docs/my notes.md', 'tests/unit/workspace.test.ts'];

describe('@-mentions', () => {
  it('lists folders from file paths', () => {
    expect(foldersOf(['a/b/c.ts', 'a/d.ts']).sort()).toEqual(['a/', 'a/b/']);
  });

  it('ranks a name that starts with the query first, then contains it, then the path, then fuzzy', () => {
    expect(matchFiles(files, 'work').map((m) => m.path).slice(0, 2)).toEqual(['src/main/workspace.ts', 'tests/unit/workspace.test.ts']);
    expect(matchFiles(files, 'view')[0].path).toBe('src/renderer/components/FocusView.tsx');
    expect(matchFiles(files, 'providers')[0]).toEqual({ path: 'src/main/providers/', dir: true });
    expect(matchFiles(files, 'fcsvw')[0].path).toBe('src/renderer/components/FocusView.tsx');
    expect(matchFiles(files, 'zzz')).toEqual([]);
  });

  it('lists the top level, folders first, and a folder’s own entries after a /', () => {
    expect(matchFiles(files, '').map((m) => m.path)).toEqual(['docs/', 'src/', 'tests/', 'package.json', 'README.md']);
    expect(matchFiles(files, 'src/main/').map((m) => m.path)).toEqual(['src/main/providers/', 'src/main/workspace.ts']);
  });

  it('finds the mention being typed before the caret', () => {
    expect(mentionAt('look at @src/ma', 15)).toEqual({ start: 8, query: 'src/ma' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('mail me at a@b.com', 18)).toBeUndefined();
    expect(mentionAt('look at @src now', 16)).toBeUndefined();
    // A Chinese input method's punctuation after @ (or ＠) means the path's own.
    expect(mentionAt('看看 ＠。、src', 9)).toEqual({ start: 3, query: './src' });
    expect(mentionAt('@～／notes．md', 11)).toEqual({ start: 0, query: '~/notes.md' });
  });

  it('writes the chosen path as @path, quoted with spaces; a file ends the mention with a space', () => {
    expect(mentionText({ path: 'src/a.ts', dir: false })).toBe('@src/a.ts ');
    expect(mentionText({ path: 'src/', dir: true })).toBe('@src/');
    expect(mentionText({ path: 'docs/my notes.md', dir: false })).toBe('@"docs/my notes.md" ');
  });
});

describe('files in an agent’s folder', () => {
  it('git’s files (tracked and new, not ignored), or a walk that skips dependency folders', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { MockAdapter } = await import('../../src/main/providers/mock');
    const { Workspace } = await import('../../src/main/workspace');
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-fm-'));
    const ws = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock'), 5) }, backgroundModel: async () => '' });
    try {
      const repo = mkdtempSync(join(tmpdir(), 'amw-fm-repo-'));
      mkdirSync(join(repo, 'src'));
      mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
      writeFileSync(join(repo, 'src', 'checkout.ts'), '');
      writeFileSync(join(repo, 'node_modules', 'x', 'checkout.js'), '');
      writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const p = await ws.addProject(repo);
      const t = await ws.createTask({ projectId: p.projectId, provider: 'mock', isolate: false });
      expect((await ws.searchFiles(t.taskId, 'checkout')).map((m) => m.path)).toEqual(['src/checkout.ts']);
      // ./ is the same folder, written explicitly.
      expect((await ws.searchFiles(t.taskId, './')).map((m) => m.path)).toEqual(['./src/', './.gitignore']);
      expect((await ws.searchFiles(t.taskId, './src/')).map((m) => m.path)).toEqual(['./src/checkout.ts']);
      expect((await ws.searchFiles(t.taskId, './check')).map((m) => m.path)).toEqual(['./src/checkout.ts']);

      // Files dropped on its box: relative inside its folder, from ~ or / outside, folders ending in /.
      const { homedir } = await import('node:os');
      const { realpathSync } = await import('node:fs');
      const cwd = realpathSync(repo);
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'amw-fm-out-')));
      writeFileSync(join(outside, 'spec.pdf'), '');
      expect(ws.droppedFiles(t.taskId, [join(cwd, 'src', 'checkout.ts'), join(cwd, 'src'), join(outside, 'spec.pdf')])).toEqual([
        { path: 'src/checkout.ts', dir: false },
        { path: 'src/', dir: true },
        { path: join(outside, 'spec.pdf'), dir: false },
      ]);
      expect(ws.droppedFiles(t.taskId, [join(homedir(), 'Downloads', 'x.pdf')])[0].path).toBe('~/Downloads/x.pdf');
      // The main agent gets full paths (to pass on), and browses only ~/ and /.
      (ws as unknown as { store: { data: { mainAgent?: unknown } } }).store.data.mainAgent = { taskId: 't-main-x', alias: 'Main', name: 'Main', projectId: '', title: 'Main agent', provider: 'mock', status: 'idle', summary: '', cwd: cwd, createdAt: '', updatedAt: '' };
      expect(ws.droppedFiles('t-main-x', [join(cwd, 'src', 'checkout.ts')])[0].path).toBe(join(cwd, 'src', 'checkout.ts'));
      expect(await ws.searchFiles('t-main-x', 'check')).toEqual([]);
      expect((await ws.searchFiles('t-main-x', `${cwd}/src/`)).map((m) => m.path)).toEqual([`${cwd}/src/checkout.ts`]);

      const plain = mkdtempSync(join(tmpdir(), 'amw-fm-plain-'));
      mkdirSync(join(plain, 'lib'));
      mkdirSync(join(plain, 'node_modules'));
      writeFileSync(join(plain, 'lib', 'checkout.py'), '');
      writeFileSync(join(plain, 'node_modules', 'checkout.js'), '');
      const q = await ws.addProject(plain);
      const u = await ws.createTask({ projectId: q.projectId, provider: 'mock', isolate: false });
      expect((await ws.searchFiles(u.taskId, 'checkout')).map((m) => m.path)).toEqual(['lib/checkout.py']);
    } finally {
      await ws.shutdown();
    }
  });
});

describe('@-mentions in text', () => {
  it('splits path-like mentions out of a message, leaving people and punctuation', async () => {
    const { splitMentions, mentionBefore, browsePath } = await import('../../src/shared/file-match');
    expect(splitMentions('Fix @src/a.ts and @"docs/my notes.md", ask @Alice.')).toEqual([
      { text: 'Fix ' },
      { text: '@src/a.ts', path: 'src/a.ts' },
      { text: ' and ' },
      { text: '@"docs/my notes.md"', path: 'docs/my notes.md' },
      { text: ', ask @Alice.' },
    ]);
    expect(splitMentions('see @README.md.')).toEqual([{ text: 'see ' }, { text: '@README.md', path: 'README.md' }, { text: '.' }]);
    expect(splitMentions('mail a@b.com')).toEqual([{ text: 'mail a@b.com' }]);
    expect(mentionBefore('Fix @src/a.ts', 13)).toBe(4);
    expect(mentionBefore('Fix @src/a.ts ', 14)).toBeUndefined();
    expect(mentionBefore('hi @Alice', 9)).toBeUndefined();
    expect(browsePath('../sh')).toEqual({ parent: '../', prefix: 'sh' });
    expect(browsePath('../../lib/')).toEqual({ parent: '../../lib/', prefix: '' });
    expect(browsePath('~')).toEqual({ parent: '~/', prefix: '' });
    expect(browsePath('/etc/ho')).toEqual({ parent: '/etc/', prefix: 'ho' });
    expect(browsePath('src/')).toBeUndefined();
  });
});
