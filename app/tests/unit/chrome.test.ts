import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MockAdapter } from '../../src/main/providers/mock';
import { Workspace } from '../../src/main/workspace';

describe('Claude in Chrome', () => {
  it('agents start with Chrome and Artifacts, as in the CLI; the main agent does not', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-chrome-'));
    const adapter = new MockAdapter(join(dataDir, 'mock'), 5);
    const spy = vi.spyOn(adapter, 'createSession');
    const ws = new Workspace({ dataDir, adapters: { mock: adapter }, backgroundModel: async () => '' });
    try {
      const repo = mkdtempSync(join(tmpdir(), 'amw-chrome-repo-'));
      writeFileSync(join(repo, 'README.md'), 'x');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const p = await ws.addProject(repo);
      const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', isolate: false });
      await ws.send(a.taskId, 'hi', 'text');
      expect(spy.mock.calls.at(-1)![0]).toMatchObject({ chrome: true, artifacts: true });
      // Not the main agent, which only coordinates.
      (ws as unknown as { store: { data: { mainAgent?: unknown } } }).store.data.mainAgent = { taskId: 't-main-c', alias: 'Main', name: 'Main', projectId: '', title: 'Main agent', provider: 'mock', status: 'idle', summary: '', cwd: repo, createdAt: '', updatedAt: '' };
      await ws.send('t-main-c', 'hi', 'text');
      expect(spy.mock.calls.at(-1)![0]).toMatchObject({ chrome: false, artifacts: false });
    } finally {
      await ws.shutdown();
    }
  });
});
