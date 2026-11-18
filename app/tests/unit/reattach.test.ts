import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ProviderAdapter } from '../../src/main/providers/types';
import { Workspace } from '../../src/main/workspace';

const opened: Workspace[] = [];
afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.shutdown();
});

it('a removed agent’s session can be continued again', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'amw-reattach-'));
  execFileSync('git', ['init', '-q'], { cwd: folder });
  writeFileSync(join(folder, 'README.md'), 'x');
  const session = { provider: 'claude' as const, nativeSessionId: 's1', cwd: folder, title: 'Contract deadlines', updatedAt: new Date().toISOString() };
  const claude = {
    provider: 'claude',
    capabilities: async () => ({ provider: 'claude', available: false }),
    readHistory: async () => [],
    discoverSessions: async () => [session],
    createSession: () => {
      throw new Error('not in this test');
    },
  } as unknown as ProviderAdapter;
  const ws = new Workspace({ dataDir: mkdtempSync(join(tmpdir(), 'amw-reattach-data-')), adapters: { claude } });
  opened.push(ws);
  const p = await ws.addProject(folder, 'legal');
  const ids = async () => (await ws.discoverSessions(p.projectId, 'claude')).map((s) => s.nativeSessionId);

  expect(await ids()).toEqual(['s1']);
  const t = await ws.importSession({ projectId: p.projectId, provider: 'claude', nativeSessionId: 's1', cwd: folder, title: session.title });
  expect(await ids()).toEqual([]); // in the workspace: not offered twice
  await ws.remove(t.taskId);
  expect(await ids()).toEqual(['s1']); // removed: offered again
});
