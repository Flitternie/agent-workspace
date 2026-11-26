import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MockAdapter } from '../../src/main/providers/mock';
import { Workspace } from '../../src/main/workspace';

describe('Claude in Chrome', () => {
  it('agents on this Mac start with Chrome unless it is turned off in Settings', async () => {
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
      expect(spy.mock.calls.at(-1)![0].chrome).toBe(true);
      ws.updateSettings({ claudeChrome: false });
      const b = await ws.createTask({ projectId: p.projectId, provider: 'mock', isolate: false });
      await ws.send(b.taskId, 'hi', 'text');
      expect(spy.mock.calls.at(-1)![0].chrome).toBe(false);
    } finally {
      await ws.shutdown();
    }
  });
});
