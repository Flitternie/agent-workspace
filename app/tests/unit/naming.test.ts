import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../../src/main/providers/mock';
import type { ProviderAdapter, ProviderEvent } from '../../src/main/providers/types';
import { Workspace } from '../../src/main/workspace';

const opened: Workspace[] = [];
afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.shutdown();
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amw-test-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

/** A Claude adapter that only has a saved conversation to show (what an imported session needs). */
function savedClaude(said: string[]): ProviderAdapter {
  const history: ProviderEvent[] = said.flatMap((text, i) => [
    { type: 'transcriptItem', itemId: `u${i}`, role: 'user', text, history: true },
    { type: 'transcriptItem', itemId: `a${i}`, role: 'assistant', text: 'Done.', history: true },
  ]);
  return {
    provider: 'claude',
    capabilities: async () => ({ provider: 'claude', available: false }),
    readHistory: async () => history,
    createSession: () => {
      throw new Error('not in this test');
    },
  } as unknown as ProviderAdapter;
}

function open(opts: { model?: (system: string, prompt: string) => Promise<string>; said?: string[] } = {}): Workspace {
  const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
  const ws = new Workspace({
    dataDir,
    adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), 5), claude: savedClaude(opts.said ?? []) },
    backgroundModel: opts.model,
  });
  opened.push(ws);
  return ws;
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const nameOf = (ws: Workspace, taskId: string) => ws.snapshot().tasks.find((t) => t.taskId === taskId)!.name;

describe('agent names', () => {
  it('an imported session is named from its conversation by the user’s own CLI, with no OpenAI key', async () => {
    const prompts: string[] = [];
    const ws = open({
      said: ['Go through this contract and list every clause with a deadline or time limit.', 'Add the notice periods too.'],
      model: async (_system, prompt) => (prompts.push(prompt), 'Contracts'),
    });
    const folder = repo();
    const p = await ws.addProject(folder, 'legal');
    const t = await ws.importSession({ projectId: p.projectId, provider: 'claude', nativeSessionId: 's1', cwd: folder, title: '合同时效条款' });
    // At once: no keyword in the title, so the project's name.
    expect(t.name).toBe('Legal');
    await until(() => nameOf(ws, t.taskId) === 'Contracts');
    // The model read the conversation, not only the title.
    expect(prompts[0]).toContain('合同时效条款');
    expect(prompts[0]).toContain('list every clause with a deadline');
    expect(prompts[0]).toContain('notice periods');
    expect(ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!.nameSource).toBe('auto');
  });

  it('asks once more when the answer is not one short word, and a name the user sets always wins', async () => {
    const answers = ['Contract review specialist', 'Contracts'];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const ws = open({
      said: ['List the deadlines in this contract.'],
      model: async () => {
        calls++;
        if (calls === 3) await gate;
        return answers.shift() ?? 'Legal';
      },
    });
    const folder = repo();
    const p = await ws.addProject(folder, 'notes');
    const a = await ws.importSession({ projectId: p.projectId, provider: 'claude', nativeSessionId: 's1', cwd: folder, title: 'Deadlines' });
    await until(() => nameOf(ws, a.taskId) === 'Contracts');
    expect(calls).toBe(2);

    // The user renames while a suggestion is on its way: theirs stays.
    const b = await ws.importSession({ projectId: p.projectId, provider: 'claude', nativeSessionId: 's2', cwd: folder, title: 'More deadlines' });
    await until(() => calls === 3);
    ws.rename(b.taskId, 'Paralegal');
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(nameOf(ws, b.taskId)).toBe('Paralegal');
    expect(ws.snapshot().tasks.find((x) => x.taskId === b.taskId)!.nameSource).toBe('user');
  });

  it('runs background jobs one at a time', async () => {
    let running = 0;
    let most = 0;
    const ws = open({
      said: ['Write the release notes.'],
      model: async () => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return 'Docs';
      },
    });
    const folder = repo();
    const p = await ws.addProject(folder, 'site');
    const tasks = await Promise.all([1, 2, 3].map((i) => ws.importSession({ projectId: p.projectId, provider: 'claude', nativeSessionId: `s${i}`, cwd: folder, title: `Notes ${i}` })));
    await until(() => tasks.every((t) => nameOf(ws, t.taskId) === 'Docs'));
    expect(most).toBe(1);
  });

  it('with no model at all, an agent without a keyword in its task is named after its project', async () => {
    const ws = open();
    const p = await ws.addProject(repo(), 'agent_workspace');
    const t = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Think about the roadmap', isolate: false });
    expect(t.name).toBe('AgentWorkspace');
    expect(t.nameSource).toBe('auto');
    const named = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Roadmap', name: 'Planner', isolate: false });
    expect(named.nameSource).toBe('user');
  });
});
