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
