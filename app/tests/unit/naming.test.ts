import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../../src/main/providers/mock';
import type { ProviderAdapter, ProviderEvent } from '../../src/main/providers/types';
import type { Task } from '../../src/shared/types';
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

function open(opts: { model?: (system: string, prompt: string) => Promise<string>; said?: string[]; dataDir?: string } = {}): Workspace {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'amw-test-data-'));
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

describe('agent labels', () => {
  it('an imported session is named from its conversation by the user’s own CLI, with no OpenAI key', async () => {
    const prompts: string[] = [];
    const ws = open({
      said: ['Go through this contract and list every clause with a deadline or time limit.', 'Add the notice periods too.'],
      model: async (_system, prompt) => (prompts.push(prompt), 'Contracts'),
    });
    const folder = repo();
    const p = await ws.addProject(folder, 'legal');
    const t = await ws.importSession({ projectId: p.projectId, provider: 'claude', nativeSessionId: 's1', cwd: folder, title: '合同时效条款' });
    // At once: the session's title, shortened; the model then names the work.
    expect(t.name).toBe('合同时效条款');
    await until(() => nameOf(ws, t.taskId) === 'Contracts');
    // The model read the conversation, not only the title.
    expect(prompts[0]).toContain('合同时效条款');
    expect(prompts[0]).toContain('list every clause with a deadline');
    expect(prompts[0]).toContain('notice periods');
    expect(ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!.nameSource).toBe('auto');
  });

  it('asks once more when the answer is too long to show, and a name the user sets always wins', async () => {
    const answers = ['Going through the whole contract to list every clause with a deadline', 'Contracts'];
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

  it('with no model at all, an agent is labelled with its title, shortened', async () => {
    const ws = open();
    const p = await ws.addProject(repo(), 'agent_workspace');
    const t = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Please think about the roadmap for next quarter', isolate: false });
    expect(t.name).toBe('Think about the…');
    expect(t.nameSource).toBe('auto');
    const named = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Roadmap', name: 'Planner', isolate: false });
    expect(named.nameSource).toBe('user');
  });

  it('an agent made before any model can be asked (right after launch) is named once one can', async () => {
    const ws = open();
    const p = await ws.addProject(repo(), 'shop');
    const t = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: '读一下 total.js，用一句话说明它做什么。不要修改文件。', isolate: false });
    // The stopgap for now (no model yet), marked to be named later.
    expect(nameOf(ws, t.taskId)).toMatch(/…$/);
    expect(ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!.labelStale).toBe(true);
    // The CLIs are detected: the agent gets a name for its work.
    (ws as unknown as { opts: { backgroundModel?: (s: string, p: string) => Promise<string> } }).opts.backgroundModel = async () => '解释 total 函数';
    await ws.refreshCapabilities({ localOnly: true });
    await until(() => nameOf(ws, t.taskId) === '解释 total 函数');
    expect(ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!.labelStale).toBeFalsy();
  });

  it('on updating, renames every agent from an older version once by its work; only names the user set stay', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const old = open({ dataDir });
    const p = await old.addProject(repo(), 'agent_workspace');
    const mk = (title: string) => old.createTask({ projectId: p.projectId, provider: 'mock', title, isolate: false });
    const keyword = await mk('Migrate the orders API to v2');
    const fallback = await mk('Think about the roadmap');
    const unnamed = await mk('Contract deadlines');
    const custom = await mk('Legal review');
    const chosen = await mk('Docs site');
    const recentOrder = [keyword, fallback, unnamed, custom, chosen];
    // As an older version saved them: keyword roles, the project-name fallback, no name, an unmarked
    // custom name, and a name the user set.
    const store = (old as unknown as { store: { data: { labelsVersion?: number; tasks: Array<Record<string, unknown>> }; save(): void } }).store;
    const set = (id: string, name: string, nameSource?: 'user') => Object.assign(store.data.tasks.find((t) => t.taskId === id)!, { name, nameSource, labelStale: undefined });
    set(keyword.taskId, 'Backend');
    set(fallback.taskId, 'AgentWorkspace');
    set(unnamed.taskId, unnamed.alias);
    set(custom.taskId, 'Paralegal');
    set(chosen.taskId, 'Docs', 'user');
    recentOrder.forEach((t, i) => (store.data.tasks.find((x) => x.taskId === t.taskId)!.lastUserActivityAt = new Date(Date.now() - i * 60_000).toISOString()));
    delete store.data.labelsVersion;
    store.save();
    await old.shutdown();
    opened.splice(opened.indexOf(old), 1);

    const asked: string[] = [];
    const ws = open({ dataDir, model: async (_s, prompt) => (asked.push(prompt), `Label ${/<task>\n(?:Project[^\n]*\n)?(\S+)/.exec(prompt)![1]}`) });
    const name = (id: string) => ws.snapshot().tasks.find((t) => t.taskId === id)!.name;
    // Every older name (unmarked ones included: older versions did not record who chose them).
    await until(() => name(keyword.taskId) === 'Label Migrate');
    await until(() => name(fallback.taskId) === 'Label Think');
    await until(() => name(unnamed.taskId) === 'Label Contract');
    await until(() => name(custom.taskId) === 'Label Legal');
    // A name the user set since names were marked stays.
    expect(name(chosen.taskId)).toBe('Docs');
    expect(ws.snapshot().tasks.find((t) => t.taskId === keyword.taskId)!.labelStale).toBeUndefined();
    // Once: a later start does not rename anything again.
    const before = asked.length;
    await ws.shutdown();
    opened.splice(opened.indexOf(ws), 1);
    open({ dataDir, model: async (_s, prompt) => (asked.push(prompt), 'Again') });
    await new Promise((r) => setTimeout(r, 50));
    expect(asked.length).toBe(before);
  });

  it('relabels them all in the background, one at a time, most recently used first', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const old = open({ dataDir });
    const p = await old.addProject(repo(), 'shop');
    const tasks: Task[] = [];
    for (let i = 0; i < 10; i++) tasks.push(await old.createTask({ projectId: p.projectId, provider: 'mock', title: `Task number ${i}`, isolate: false }));
    const store = (old as unknown as { store: { data: { labelsVersion?: number; tasks: Array<Record<string, unknown>> }; save(): void } }).store;
    tasks.forEach((t, i) => Object.assign(store.data.tasks.find((x) => x.taskId === t.taskId)!, { name: 'Frontend', nameSource: undefined, lastUserActivityAt: new Date(Date.now() - i * 60_000).toISOString() }));
    delete store.data.labelsVersion;
    store.save();
    await old.shutdown();
    opened.splice(opened.indexOf(old), 1);

    const order: number[] = [];
    let running = 0;
    let most = 0;
    const ws = open({
      dataDir,
      model: async (_s, prompt) => {
        const n = Number(/Task number (\d)/.exec(prompt)![1]);
        order.push(n);
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return `Work ${n}`;
      },
    });
    const name = (i: number) => ws.snapshot().tasks.find((t) => t.taskId === tasks[i].taskId)!.name;
    await until(() => tasks.every((_t, i) => name(i) === `Work ${i}`));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(most).toBe(1);
  });

  it('keeps a label current: after new messages and a while, the latest work is labelled', async () => {
    const asked: string[] = [];
    const answers = ['Orders API', 'Pagination fix'];
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const ws = new Workspace({
      dataDir,
      adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), 5) },
      backgroundModel: async (_s, prompt) => (asked.push(prompt), answers.shift() ?? 'Pagination fix'),
      labelRefreshMs: 0,
    });
    opened.push(ws);
    const p = await ws.addProject(repo(), 'shop');
    const t = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Migrate the orders API', mockScript: 'work', instruction: 'Migrate the orders API to v2.', isolate: false });
    const idle = () => ['done', 'idle', 'waiting_for_user'].includes(ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!.status);
    await until(() => nameOf(ws, t.taskId) === 'Orders API' && idle());
    // One more message is not enough to rewrite it…
    await ws.send(t.taskId, 'Now fix the cursor pagination bug.', 'text');
    await until(idle);
    expect(nameOf(ws, t.taskId)).toBe('Orders API');
    // …two are: the label follows the latest work.
    await ws.send(t.taskId, 'And add tests for the cursor pagination.', 'text');
    await until(() => nameOf(ws, t.taskId) === 'Pagination fix');
    expect(asked.at(-1)).toContain('cursor pagination');
    // A name the user set is never rewritten.
    ws.rename(t.taskId, 'Orders');
    await ws.send(t.taskId, 'Keep going.', 'text');
    await ws.send(t.taskId, 'Almost there.', 'text');
    await until(idle);
    await new Promise((r) => setTimeout(r, 30));
    expect(nameOf(ws, t.taskId)).toBe('Orders');
  });

  it('an old name that failed to relabel (no model reachable yet) is tried again when the agent is opened', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const old = open({ dataDir });
    const p = await old.addProject(repo(), 'shop');
    const t = await old.createTask({ projectId: p.projectId, provider: 'mock', title: 'Contract deadlines', isolate: false });
    const store = (old as unknown as { store: { data: { labelsVersion?: number; tasks: Array<Record<string, unknown>> }; save(): void } }).store;
    Object.assign(store.data.tasks[0], { name: '文档', nameSource: undefined });
    delete store.data.labelsVersion;
    store.save();
    await old.shutdown();
    opened.splice(opened.indexOf(old), 1);

    let up = false;
    const ws = open({
      dataDir,
      model: async () => {
        if (!up) throw new Error('not signed in yet');
        return 'Deadline clauses';
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(nameOf(ws, t.taskId)).toBe('Contract deadlines');
    up = true;
    ws.markViewed(t.taskId);
    await until(() => nameOf(ws, t.taskId) === 'Deadline clauses');
  });
});
