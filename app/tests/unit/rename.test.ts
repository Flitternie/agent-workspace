import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aliasProblem } from '../../src/shared/agent-name';
import { MockAdapter } from '../../src/main/providers/mock';
import { Workspace } from '../../src/main/workspace';

const opened: Workspace[] = [];
afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.shutdown();
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amw-test-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  return dir;
}

function open(dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-')), model?: (system: string, prompt: string) => Promise<string>): Workspace {
  const ws = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), 5) }, backgroundModel: model });
  opened.push(ws);
  return ws;
}

const task = (ws: Workspace, id: string) => ws.snapshot().tasks.find((t) => t.taskId === id)!;

describe('agent names', () => {
  const agents = [
    { taskId: 'a', alias: 'Alice' },
    { taskId: 'b', alias: '小陈' },
  ];
  it('accepts a fresh name, and an agent keeping its own', () => {
    expect(aliasProblem('Rosa', agents, 'a')).toBeNull();
    expect(aliasProblem('  阿强 ', agents, 'a')).toBeNull();
    expect(aliasProblem('alice', agents, 'a')).toBeNull();
  });
  it('refuses another agent’s name, any case', () => {
    expect(aliasProblem('ALICE', agents, 'b')).toBe('taken');
    expect(aliasProblem('小陈', agents, 'a')).toBe('taken');
  });
  it('refuses the words routing and the main agent already use', () => {
    for (const w of ['Main', 'coordinator', 'NEW', 'unsure', 'all', 'agent', '大家', '所有人', 'Claude']) expect(aliasProblem(w, agents, 'a'), w).toBe('reserved');
  });
  it('refuses empty, overlong and odd names', () => {
    expect(aliasProblem('   ', agents, 'a')).toBe('empty');
    expect(aliasProblem('x'.repeat(25), agents, 'a')).toBe('long');
    expect(aliasProblem('@bob', agents, 'a')).toBe('chars');
    expect(aliasProblem('bob\nsmith', agents, 'a')).toBeNull(); // whitespace folds to one space
    expect(aliasProblem('bob, smith', agents, 'a')).toBe('chars');
  });
});

describe('renaming', () => {
  it('renames an agent: routing, the main agent’s lookups and forks find it by its new name only', async () => {
    const ws = open();
    const p = await ws.addProject(repo(), 'shop');
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Orders API', name: 'Orders', isolate: false });
    const b = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Charts', name: 'Charts', isolate: false });
    const old = a.alias;
    ws.renameAgent(a.taskId, '  Rosa ');
    expect(task(ws, a.taskId).alias).toBe('Rosa');
    expect(task(ws, a.taskId).name).toBe('Orders');
    expect(ws.findAgent('rosa')?.taskId).toBe(a.taskId);
    expect(ws.findAgent(old)).toBeUndefined();
    const d = await ws.decideRoute('Rosa, add a test for refunds', b.taskId);
    expect(d).toMatchObject({ kind: 'existing', taskId: a.taskId, confidence: 'high' });
    const zh = await ws.decideRoute('让阿强跑一下测试', null);
    expect(zh.kind === 'existing' && zh.taskId === a.taskId).toBe(false);
    ws.renameAgent(a.taskId, '阿强');
    expect((await ws.decideRoute('让阿强跑一下测试', b.taskId)) as { taskId?: string }).toMatchObject({ kind: 'existing', taskId: a.taskId });
    // A fork points at its source by the name the source has now.
    const store = (ws as unknown as { store: { data: { tasks: Array<{ taskId: string; forkedFrom?: { taskId: string; alias: string } }> } } }).store;
    store.data.tasks.find((t) => t.taskId === b.taskId)!.forkedFrom = { taskId: a.taskId, alias: '阿强' };
    ws.renameAgent(a.taskId, 'Rosa');
    expect(task(ws, b.taskId).forkedFrom).toEqual({ taskId: a.taskId, alias: 'Rosa' });
  });

  it('refuses a name another agent has, or a reserved word; the name stays', async () => {
    const ws = open();
    const p = await ws.addProject(repo(), 'shop');
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'One', name: 'One', isolate: false });
    const b = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Two', name: 'Two', isolate: false });
    expect(() => ws.renameAgent(a.taskId, b.alias.toUpperCase())).toThrow(/already has this name/);
    expect(() => ws.renameAgent(a.taskId, 'main')).toThrow(/already means something/);
    expect(task(ws, a.taskId).alias).toBe(a.alias);
  });

  it('an agent without a label of its own: its label follows its new name', async () => {
    const ws = open();
    const p = await ws.addProject(repo(), 'shop');
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: '', isolate: false });
    expect(task(ws, a.taskId).name).toBe(a.alias);
    ws.renameAgent(a.taskId, 'Rosa');
    expect(task(ws, a.taskId).name).toBe('Rosa');
  });

  it('renames survive a restart (agent, title, project)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const ws = open(dir);
    const p = await ws.addProject(repo(), 'shop');
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', isolate: false });
    ws.renameAgent(a.taskId, 'Rosa');
    ws.rename(a.taskId, '合并发布');
    expect(ws.renameProject(p.projectId, '  Shop front ').name).toBe('Shop front');
    expect(() => ws.renameProject(p.projectId, '   ')).toThrow(/empty/);
    await ws.shutdown();
    opened.splice(opened.indexOf(ws), 1);
    const again = open(dir);
    expect(again.snapshot().projects.find((x) => x.projectId === p.projectId)!.name).toBe('Shop front');
    expect(task(again, a.taskId)).toMatchObject({ alias: 'Rosa', name: '合并发布', nameSource: 'user' });
  });

  it('a title the user set is not replaced by an automatic label', async () => {
    let asked = 0;
    const ws = open(undefined, async () => {
      asked++;
      return 'Model label';
    });
    const p = await ws.addProject(repo(), 'shop');
    // Started without a title: its first message would give it one, and a label.
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: '', isolate: false });
    ws.rename(a.taskId, 'My title');
    await ws.send(a.taskId, 'Please migrate the orders table to the new schema', 'text');
    await new Promise((r) => setTimeout(r, 100));
    expect(task(ws, a.taskId)).toMatchObject({ name: 'My title', nameSource: 'user' });
    expect(asked).toBe(0);
  });
});
