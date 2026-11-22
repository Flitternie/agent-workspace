import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAdapter } from '../../src/main/providers/mock';
import { Workspace } from '../../src/main/workspace';
import { rank, teams } from '../../src/shared/agent-order';

const DELAY = 5;
const opened: Workspace[] = [];

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amw-test-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function open(dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'))): Workspace {
  const ws = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), DELAY) } });
  opened.push(ws);
  return ws;
}

const settle = (ms = DELAY * 6) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await settle(DELAY);
  }
}

afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.shutdown();
});

async function demo(ws: Workspace) {
  const project = await ws.addProject(repo(), 'shop');
  const A = await ws.createTask({ projectId: project.projectId, provider: 'mock', name: 'backend', title: 'Backend API', isolate: true, mockScript: 'ask:Legacy tests depend on old API; keep compatibility?', instruction: 'Migrate API.' });
  const B = await ws.createTask({ projectId: project.projectId, provider: 'mock', name: 'frontend', title: 'Frontend dashboard', isolate: true, mockScript: 'work', instruction: 'Build dashboard.' });
  const C = await ws.createTask({ projectId: project.projectId, provider: 'mock', name: 'database', title: 'Database schema', isolate: true, mockScript: 'ask:Schema migration has data-loss risk; proceed?', instruction: 'Write migration.' });
  const open = (taskId: string) => ws.snapshot().attention.filter((a) => a.taskId === taskId && a.state === 'open');
  await until(() => open(A.taskId).some((a) => a.kind === 'question') && open(C.taskId).some((a) => a.kind === 'question'));
  return { ws, project, A, B, C, open };
}

describe('attention queue', () => {
  it('two pending requests survive a long dialogue with another agent', async () => {
    const { ws, A, C, open: openItems } = await demo(open());
    const cItem = openItems(C.taskId)[0];
    expect(cItem.headline).toMatch(/data-loss risk/);
    const task = (id: string) => ws.snapshot().tasks.find((t) => t.taskId === id)!;
    expect(task(A.taskId).status).toBe('waiting_for_user');
    expect(task(C.taskId).status).toBe('waiting_for_user');

    for (let i = 0; i < 10; i++) {
      await until(() => task(A.taskId).status !== 'running');
      const r = await ws.send(A.taskId, `turn ${i}: please look at case ${i}`, 'text');
      expect(r.ok).toBe(true);
      await until(() => task(A.taskId).status !== 'running');
    }
    // C's request is untouched: same id, still open, same content.
    const cNow = ws.snapshot().attention.find((a) => a.id === cItem.id)!;
    expect(cNow.state).toBe('open');
    expect(cNow.headline).toBe(cItem.headline);
    expect(task(C.taskId).status).toBe('waiting_for_user');
    // Histories are not intermixed.
    const aUser = ws.transcript(A.taskId).filter((i) => i.role === 'user');
    expect(aUser).toHaveLength(11);
    expect(ws.transcript(C.taskId).some((i) => /turn \d/.test(i.text))).toBe(false);

    // Answering C resolves only C's item.
    await ws.send(C.taskId, 'Add a backfill step first.', 'card');
    expect(ws.snapshot().attention.find((a) => a.id === cItem.id)!.state).toBe('resolved');
  });

  it('drops late events from a replaced session', async () => {
    const { ws, A } = await demo(open());
    const before = ws.transcript(A.taskId).length;
    ws.handleEvent(A.taskId, 's-old-session', { type: 'transcriptItem', itemId: 'late', role: 'assistant', text: 'late output' });
    ws.handleEvent(A.taskId, 's-old-session', { type: 'approvalRequested', requestId: 'r1', headline: 'x', details: '', options: [] });
    expect(ws.transcript(A.taskId).length).toBe(before);
    expect(ws.snapshot().attention.some((a) => a.providerRequestId === 'r1')).toBe(false);
  });

  it('deduplicates repeated native requests and transcript items', async () => {
    const { ws, A } = await demo(open());
    const local = ws.snapshot().tasks.find((t) => t.taskId === A.taskId)!.sessionLocalId!;
    const ev = { type: 'approvalRequested' as const, requestId: 'dup', headline: 'Run x', details: '', options: [{ id: 'allow', label: 'Allow' }] };
    ws.handleEvent(A.taskId, local, ev);
    ws.handleEvent(A.taskId, local, ev);
    expect(ws.snapshot().attention.filter((a) => a.providerRequestId === 'dup')).toHaveLength(1);
    ws.handleEvent(A.taskId, local, { type: 'transcriptItem', itemId: 'same', role: 'assistant', text: 'one' });
    ws.handleEvent(A.taskId, local, { type: 'transcriptItem', itemId: 'same', role: 'assistant', text: 'one' });
    expect(ws.transcript(A.taskId).filter((i) => i.id === 'same')).toHaveLength(1);
  });
});

describe('native approvals', () => {
  it('chat text never resolves an approval; an explicit deny reaches the provider', async () => {
    const ws = open();
    const project = await ws.addProject(repo());
    const t = await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'db', isolate: false, mockScript: 'approval:psql -c "DROP TABLE legacy"', instruction: 'clean up' });
    await until(() => ws.snapshot().attention.some((a) => a.taskId === t.taskId && a.kind === 'approval' && a.state === 'open'));
    const item = ws.snapshot().attention.find((a) => a.kind === 'approval')!;
    expect(item.highRisk).toBe(true);
    expect(() => ws.dismissAttention(item.id)).toThrow(/answered/);
    // "yes do it" in chat is just a message (the mock is busy waiting on the approval, so it is refused).
    await ws.send(t.taskId, 'yes please do it', 'text');
    expect(ws.snapshot().attention.find((a) => a.id === item.id)!.state).toBe('open');
    await expect(ws.respondAttention(item.id, 'yolo')).rejects.toThrow(/provider-offered/);
    await ws.respondAttention(item.id, 'deny');
    expect(ws.snapshot().attention.find((a) => a.id === item.id)!.state).toBe('resolved');
    await until(() => ws.transcript(t.taskId).some((i) => /not run/.test(i.text)));
  });
});

describe('restart and resume', () => {
  it('restores tasks, mappings and pending reports; expires native requests; resumes real context', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const ws1 = open(dataDir);
    const { A, C } = await demo(ws1);
    const p = ws1.snapshot().projects[0];
    const D = await ws1.createTask({ projectId: p.projectId, provider: 'mock', title: 'ops', isolate: false, mockScript: 'approval:deploy', instruction: 'deploy' });
    await until(() => ws1.snapshot().attention.some((a) => a.taskId === D.taskId && a.kind === 'approval'));
    const native = ws1.snapshot().sessions.find((s) => s.taskId === A.taskId)!.nativeSessionId;
    await ws1.shutdown();

    const ws2 = open(dataDir);
    const s = ws2.snapshot();
    expect(s.tasks.map((t) => t.alias)).toEqual(['Alice', 'Bob', 'Charlie', 'Diana']);
    expect(s.attention.find((a) => a.taskId === C.taskId && a.kind === 'question')!.state).toBe('open');
    expect(s.attention.find((a) => a.taskId === D.taskId && a.kind === 'approval')!.state).toBe('expired');
    expect(s.tasks.find((t) => t.taskId === D.taskId)!.status).toBe('disconnected');
    // Sending resumes the same native session with its prior context.
    await ws2.send(A.taskId, 'keep the adapter', 'text');
    await until(() => ws2.transcript(A.taskId).some((i) => /Request \d+ in this session/.test(i.text)));
    const resumed = ws2.snapshot().sessions.filter((x) => x.taskId === A.taskId).at(-1)!;
    expect(resumed.nativeSessionId).toBe(native);
    expect(resumed.integrationMode).toBe('resumed');
    expect(ws2.transcript(A.taskId).some((i) => i.role === 'system' && /Resumed native/.test(i.text))).toBe(true);
  });
});

describe('sidebar order', () => {
  it('moves an agent only when its status group changes, and keeps the order across a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const ws = open(dataDir);
    const shop = await ws.addProject(repo(), 'shop');
    const legal = await ws.addProject(repo(), 'legal');
    const s = () => ws.snapshot();
    const task = (id: string) => s().tasks.find((t) => t.taskId === id)!;
    const openNow = () => s().attention.filter((a) => a.state === 'open');
    const order = () => rank(s().tasks, openNow()).map((t) => t.alias);
    const teamOrder = () => teams(s().tasks, s().projects, openNow(), Date.now()).map((t) => t.project.name);

    // Two long turns started one after the other, in different projects: the first stays on top.
    const A = await ws.createTask({ projectId: shop.projectId, provider: 'mock', title: 'A', isolate: false, mockScript: 'subagents', instruction: 'go' });
    await until(() => task(A.taskId).status === 'running');
    await settle();
    const B = await ws.createTask({ projectId: legal.projectId, provider: 'mock', title: 'B', isolate: false, mockScript: 'subagents', instruction: 'go' });
    await until(() => task(B.taskId).status === 'running');
    expect(order()).toEqual([A.alias, B.alias]);
    expect(teamOrder()).toEqual(['shop', 'legal']);

    // New output while running (sub-agent steps, progress) changes nothing.
    const sinceA = task(A.taskId).statusSince;
    const sinceB = task(B.taskId).statusSince;
    const updated = task(B.taskId).updatedAt;
    await until(() => task(B.taskId).updatedAt !== updated && (task(B.taskId).subtasks?.length ?? 0) >= 2);
    expect(task(A.taskId).statusSince).toBe(sinceA);
    expect(task(B.taskId).statusSince).toBe(sinceB);
    expect(order()).toEqual([A.alias, B.alias]);

    // A third agent asks for approval: it and its team go to the top.
    await settle();
    const C = await ws.createTask({ projectId: legal.projectId, provider: 'mock', title: 'C', isolate: false, mockScript: 'approval:deploy', instruction: 'deploy' });
    await until(() => openNow().some((a) => a.taskId === C.taskId && a.kind === 'approval'));
    expect(order()).toEqual([C.alias, A.alias, B.alias]);
    expect(teamOrder()).toEqual(['legal', 'shop']);

    // Answered, C works and finishes: it drops below those still working.
    await ws.respondAttention(openNow().find((a) => a.taskId === C.taskId)!.id, 'allow');
    await until(() => ['done', 'idle'].includes(task(C.taskId).status));
    expect(order()).toEqual([A.alias, B.alias, C.alias]);
    expect(teamOrder()).toEqual(['shop', 'legal']);

    // A finishes: it joins the end of the rest; B (and its team) now leads.
    await until(() => task(A.taskId).status === 'done', 5000);
    expect(order()).toEqual([B.alias, C.alias, A.alias]);
    expect(teamOrder()).toEqual(['legal', 'shop']);

    // Restart: B was cut off mid-turn (now disconnected); every stamp is kept, so is the order.
    const before = Object.fromEntries(s().tasks.map((t) => [t.taskId, t.statusSince]));
    await ws.shutdown();
    const ws2 = open(dataDir);
    const s2 = ws2.snapshot();
    expect(s2.tasks.find((t) => t.taskId === B.taskId)!.status).toBe('disconnected');
    expect(Object.fromEntries(s2.tasks.map((t) => [t.taskId, t.statusSince]))).toEqual(before);
    expect(rank(s2.tasks, s2.attention.filter((a) => a.state === 'open')).map((t) => t.alias)).toEqual([B.alias, C.alias, A.alias]);
  }, 15_000);
});

describe('sub-agents', () => {
  it('stay through turns the agent starts by itself (to report background ones)', async () => {
    const ws = open();
    const p = await ws.addProject(repo());
    const t = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'fan out', isolate: false, mockScript: 'swarm:4', instruction: 'go' });
    const task = () => ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!;
    await until(() => (task().subtasks?.length ?? 0) === 4);
    // Claude Code reports finished background sub-agents in a turn of its own.
    ws.handleEvent(t.taskId, task().sessionLocalId!, { type: 'turnStarted' });
    expect(task().subtasks).toHaveLength(4);
  });
});

describe('research', () => {
  it('shows in the snapshot once created, follows the agents linked to it, and comes with the demo', async () => {
    const ws = open();
    const p = await ws.addProject(repo(), 'shop');
    expect(ws.snapshot().research).toEqual([]);
    const doc = await ws.researchCreate(p.projectId, 'Tuning', 'Raise accuracy', false);
    expect(ws.snapshot().research).toMatchObject([{ projectId: p.projectId, title: 'Tuning', taskIds: [] }]);
    expect(ws.snapshot().research[0].updatedAt).toBe(doc.updatedAt);
    const t = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Data agent', isolate: false, mockScript: 'work', instruction: 'go' });
    ws.researchSave(p.projectId, { ...doc, nodes: [{ id: 'a1', type: 'aspect', parent: null, title: 'Data', status: 'running', taskId: t.taskId, createdAt: '' }] });
    expect(ws.snapshot().research[0].taskIds).toEqual([t.taskId]);
    expect(ws.researchGet(p.projectId)!.nodes[0].title).toBe('Data');

    const demo = open();
    await demo.seedDemo(repo());
    expect(demo.snapshot().research).toHaveLength(1);
    expect(demo.researchGet(demo.snapshot().projects[0].projectId)!.nodes.length).toBeGreaterThan(20);
  });
});

describe('several researches in a project (one per repository folder)', () => {
  it('each kept in its folder, one row each; the main agent names them by project/folder; an agent works in the one it is in', async () => {
    const ws = open();
    const root = repo();
    mkdirSync(join(root, 'hotswap'));
    mkdirSync(join(root, 'trace'));
    const p = await ws.addProject(root, 'projects');
    const { researchTools } = await import('../../src/main/research-tools');
    const main = Object.fromEntries(researchTools(ws, { kind: 'main' }).map((t) => [t.name, t]));
    expect(await main.research_create.run({ project: 'projects', folder: 'hotswap', title: 'Hot swap', goal: 'Raise the score' })).toMatch(/projects\/hotswap/);
    await ws.researchCreate(p.projectId, 'Trace', 'Better distances', false, 'trace');
    expect(existsSync(join(root, 'hotswap', '.research', 'research.json'))).toBe(true);
    expect(existsSync(join(root, '.research'))).toBe(false);
    expect(ws.snapshot().research.map((r) => [r.id, r.dir, r.title])).toEqual([
      [`${p.projectId}::hotswap`, 'hotswap', 'Hot swap'],
      [`${p.projectId}::trace`, 'trace', 'Trace'],
    ]);
    await expect(main.research_overview.run({})).rejects.toThrow(/projects\/hotswap, projects\/trace/);
    expect(await main.research_add.run({ project: 'projects/trace', type: 'aspect', title: 'Labels' })).toMatch(/Labels/);
    expect(ws.researchGet(`${p.projectId}::trace`)!.nodes.map((n) => n.title)).toEqual(['Labels']);
    // The lead of one: started in the project, told the folder; its tools work on its own research.
    const lead = await ws.researchMessage(`${p.projectId}::hotswap`, [], 'Lay it out with me.');
    expect(ws.transcript(lead.taskId).find((i) => i.role === 'user')!.text).toMatch(/folder hotswap\/ of the project/);
    expect(ws.snapshot().tasks.find((t) => t.taskId === lead.taskId)!.projectId).toBe(p.projectId);
    const asLead = Object.fromEntries(researchTools(ws, { kind: 'agent', taskId: lead.taskId }).map((t) => [t.name, t]));
    await asLead.research_add.run({ type: 'aspect', title: 'Monitor' });
    expect(ws.researchGet(`${p.projectId}::hotswap`)!.nodes.map((n) => n.title)).toEqual(['Monitor']);
    await expect(ws.researchCreate(p.projectId, 'Bad', '', false, '../x')).rejects.toThrow(/Not a folder/);
  });
});

describe('starting and ending a research from the sidebar', () => {
  it('conversations picked become a research (its lead is asked to read and attach them); more join later; dissolved, its files stay and the place is free again', async () => {
    const ws = open();
    const p = await ws.addProject(repo(), 'shop');
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Tune the cache', isolate: false, mockScript: 'work', instruction: 'go' });
    const b = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Profile it', isolate: false, mockScript: 'work', instruction: 'go' });
    const c = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Later one', isolate: false, mockScript: 'work', instruction: 'go' });
    const { researchId: rid } = await ws.researchFromTasks(p.projectId, [a.taskId, b.taskId]);
    expect(rid).toBe(p.projectId);
    const doc = ws.researchGet(rid)!;
    expect(doc.title).toBe('Tune the cache');
    const brief = ws.transcript(doc.leadTaskId!).find((i) => i.role === 'user')!.text;
    expect(brief).toMatch(new RegExp(`Bring these existing conversations into this research: ${a.alias} \\(Tune the cache\\), ${b.alias} \\(Profile it\\)[\\s\\S]*research_read[\\s\\S]*research_attach`));
    // The lead reads a conversation of its project; others may not.
    const { researchTools } = await import('../../src/main/research-tools');
    const as = (taskId: string) => Object.fromEntries(researchTools(ws, { kind: 'agent', taskId }).map((t) => [t.name, t]));
    expect(await as(doc.leadTaskId!).research_read.run({ agent: a.alias })).toMatch(/go/);
    await expect(as(c.taskId).research_read.run({ agent: a.alias })).rejects.toThrow(/lead/);
    // One more, later: the lead is asked.
    await until(() => ws.snapshot().tasks.find((t) => t.taskId === doc.leadTaskId)!.status !== 'running');
    await ws.researchAddTasks(rid, [c.taskId]);
    expect(ws.transcript(doc.leadTaskId!).filter((i) => i.role === 'user').at(-1)!.text).toMatch(new RegExp(`${c.alias} \\(Later one\\)`));
    await expect(ws.researchAddTasks(rid, [doc.leadTaskId!])).rejects.toThrow(/already in it/);
    // Dissolved: gone from the page, nothing deleted, its agents ordinary again; a new one can start there.
    const { kept } = await ws.researchDissolve(rid);
    expect(ws.snapshot().research).toEqual([]);
    expect(existsSync(join(p.rootPath, '.research'))).toBe(false);
    expect(JSON.parse(readFileSync(join(p.rootPath, kept, 'research.json'), 'utf8')).title).toBe('Tune the cache');
    await ws.researchCreate(p.projectId, 'Again', '', false);
    expect(ws.snapshot().research.map((r) => r.title)).toEqual(['Again']);
  });
});

describe('research managed by talking', () => {
  async function setup() {
    const ws = open();
    const p = await ws.addProject(repo(), 'shop');
    await ws.researchCreate(p.projectId, 'Tuning', 'Raise accuracy', false);
    const { researchTools } = await import('../../src/main/research-tools');
    const as = (caller: { kind: 'main' } | { kind: 'agent'; taskId: string }) => Object.fromEntries(researchTools(ws, caller).map((t) => [t.name, t]));
    const main = as({ kind: 'main' });
    await main.research_add.run({ type: 'aspect', title: 'Data', metric: 'quality', higher_is_better: true, baseline: 70 });
    await main.research_add.run({ type: 'aspect', title: 'Model', metric: 'loss', higher_is_better: false, baseline: 3.4 });
    const doc = () => ws.researchGet(p.projectId)!;
    const node = (title: string) => doc().nodes.find((n) => n.title === title)!;
    return { ws, p, as, main, doc, node };
  }

  it('views: the lead writes what the page shows (from a template or its own), results by dataset feed live tables; an aspect agent writes only its own', async () => {
    const { ws, p, as, main, node } = await setup();
    expect(await main.research_view.run({ template: 'tracker' })).toMatch(/view of the goal/);
    expect(ws.researchNotes(p.projectId).views!.goal.text).toMatch(/research:table/);
    await expect(main.research_view.run({ markdown: '```research:wat\n```' })).rejects.toThrow(/No block/);
    await main.research_try.run({ method_id: (await main.research_add.run({ type: 'method', parent_id: node('Data').id, title: 'Dedup' }), node('Dedup').id), variants: [{ title: 'v1' }] });
    const v1 = node('v1');
    await main.research_record.run({ experiment_id: v1.id, results: [{ metric: 'quality', dataset: 'A', value: 72 }, { metric: 'quality', dataset: 'B', value: 70 }] });
    await main.research_record.run({ experiment_id: v1.id, results: [{ metric: 'quality', dataset: 'B', value: 71 }] });
    expect(node('v1').results).toEqual([{ metric: 'quality', dataset: 'A', value: 72 }, { metric: 'quality', dataset: 'B', value: 71 }]);
    const first = await ws.researchMessage(p.projectId, [node('Data').id], 'hi');
    const data = as({ kind: 'agent', taskId: first.taskId });
    await expect(data.research_view.run({ node_id: 'goal', markdown: 'x' })).rejects.toThrow(/lead/);
    await expect(data.research_view.run({ node_id: node('Model').id, markdown: 'x' })).rejects.toThrow();
    expect(await data.research_view.run({ markdown: '## Data\n\n```research:table\n{"metrics":["quality"]}\n```' })).toMatch(/"Data"/);
    expect(ws.researchNotes(p.projectId).views![node('Data').id].text).toMatch(/## Data/);
    // One-line takeaways (what the graph shows on a node): with a result; an aspect's own agent keeps its aspect's.
    await main.research_record.run({ experiment_id: v1.id, takeaway: 'Dedup helps on A only' });
    expect(node('v1').takeaway).toBe('Dedup helps on A only');
    await data.research_update.run({ node_id: node('Data').id, takeaway: 'Cleaning matters more than size' });
    expect(node('Data').takeaway).toBe('Cleaning matters more than size');
    await expect(data.research_update.run({ node_id: node('Data').id, title: 'Renamed' })).rejects.toThrow(/lead/);
    await expect(data.research_update.run({ node_id: node('Model').id, takeaway: 'x' })).rejects.toThrow();
    // The page's own settings: the lead's, kept in .research/ui.json, each change undoable; what is not understood is said.
    expect(await main.research_ui.run({ set: { labels: { aspect: 'Question' }, header: [{ label: 'Spent', metric: 'cost', how: 'sum', unit: '$' }] } })).toMatch(/Applied[\s\S]*Question/);
    expect(JSON.parse(readFileSync(join(p.rootPath, '.research', 'ui.json'), 'utf8'))).toMatchObject({ labels: { aspect: 'Question' }, history: [{ ui: {} }] });
    await expect(main.research_ui.run({ set: { colours: { a: 1 } } })).rejects.toThrow(/Not understood: colours/);
    await expect(data.research_ui.run({ set: { labels: { aspect: 'X' } } })).rejects.toThrow(/lead/);
    expect(await data.research_ui.run({})).toMatch(/Settings now: \{"labels":\{"aspect":"Question"\}/);
    expect(await main.research_ui.run({ undo: true })).toMatch(/Undone[\s\S]*Settings: \{\}/);
    await expect(main.research_ui.run({ undo: true })).rejects.toThrow(/Nothing to undo/);
  });

  it('the box: an aspect without an agent starts one with its brief; then the same agent, told what it is about; across aspects, the research lead (started by its first message)', async () => {
    const { ws, p, doc, node } = await setup();
    const first = await ws.researchMessage(p.projectId, [node('Data').id], 'Which methods would you try?');
    expect(node('Data').taskId).toBe(first.taskId);
    const brief = ws.transcript(first.taskId).find((i) => i.role === 'user')!.text;
    expect(brief).toMatch(/You own the "Data" aspect of the research "Tuning"[\s\S]*research_try[\s\S]*Which methods would you try\?/);
    await until(() => ws.snapshot().tasks.find((t) => t.taskId === first.taskId)!.status !== 'running');
    const { doc: withMethod } = await import('../../src/shared/research').then((r) => r.addNode(doc(), { type: 'method', parent: node('Data').id, title: 'Dedup', status: 'idea' }));
    ws.researchSave(p.projectId, withMethod);
    const again = await ws.researchMessage(p.projectId, [node('Dedup').id], 'Try 0.8 and 0.9');
    expect(again.taskId).toBe(first.taskId);
    expect(ws.transcript(first.taskId).filter((i) => i.role === 'user').at(-1)!.text).toBe(`About "Dedup" [${node('Dedup').id}] in the research "Tuning": Try 0.8 and 0.9`);
    // Its agent lives on the research page.
    expect(ws.snapshot().research[0].taskIds).toEqual([first.taskId]);
    const lead = await ws.researchMessage(p.projectId, [node('Data').id, node('Model').id], 'Compare');
    expect(doc().leadTaskId).toBe(lead.taskId);
    expect(ws.transcript(lead.taskId).find((i) => i.role === 'user')!.text).toMatch(/You lead the research "Tuning"[\s\S]*research_settings[\s\S]*review first[\s\S]*About "Data" \[[^\]]+\], "Model" \[[^\]]+\] in the research "Tuning": Compare/);
    // Its agents are on the research page (the lead too), not in the team.
    expect(ws.snapshot().research[0].taskIds).toEqual(expect.arrayContaining([first.taskId, lead.taskId]));
    // Then the same lead, about the whole research.
    expect((await ws.researchMessage(p.projectId, [], 'Where do things stand?')).taskId).toBe(lead.taskId);
  });

  it('each agent changes only its part: an aspect’s agent its aspect, an experiment’s agent its own result; the main agent anything', async () => {
    const { ws, p, as, main, doc, node } = await setup();
    const dataAgent = await ws.researchStartAgent(p.projectId, node('Data').id, { isolate: false });
    const data = as({ kind: 'agent', taskId: dataAgent.taskId });
    expect(await data.research_add.run({ type: 'method', title: 'Dedup', design: 'MinHash' })).toMatch(/Added method/);
    await expect(data.research_add.run({ type: 'method', parent_id: node('Model').id, title: 'GQA' })).rejects.toThrow(/Only this aspect’s agent/);
    await expect(data.research_add.run({ type: 'aspect', title: 'Training' })).rejects.toThrow(/research’s lead/);
    // Variants in parallel: one agent each, in its own worktree, linked to its experiment.
    const tried = await data.research_try.run({ method_id: node('Dedup').id, variants: [{ title: '0.8' }, { title: '0.9', config: 'threshold 0.9' }] });
    expect(tried).toMatch(/Started 2 variants/);
    const exps = doc().nodes.filter((n) => n.type === 'experiment');
    expect(exps.map((e) => [e.title, !!e.taskId])).toEqual([['0.8', true], ['0.9', true]]);
    for (const e of exps) expect(ws.snapshot().tasks.find((t) => t.taskId === e.taskId)!.worktree).toBeTruthy();
    expect(ws.transcript(exps[1].taskId!).find((i) => i.role === 'user')!.text).toMatch(/Try this variant: threshold 0\.9[\s\S]*research_record/);
    // An experiment's agent records its own result, judged against the aspect's start; not another's.
    const e08 = as({ kind: 'agent', taskId: exps[0].taskId! });
    expect(await e08.research_record.run({ value: 74.2, finding: 'keeps code samples' })).toMatch(/pass \(74\.2\)/);
    await expect(e08.research_record.run({ experiment_id: exps[1].id, value: 60 })).rejects.toThrow(/its aspect’s agent/);
    expect(doc().nodes.find((n) => n.id === exps[0].id)).toMatchObject({ status: 'pass', value: 74.2, findings: [{ text: 'keeps code samples' }] });
    // Across aspects: the main agent's, under the cross-aspect row.
    await main.research_add.run({ type: 'method', parent_id: node('Model').id, title: 'GQA' });
    await expect(data.research_derive.run({ kind: 'combine', from_ids: [node('Dedup').id, node('GQA').id], title: 'Dedup + GQA' })).rejects.toThrow(/research lead’s/);
    expect(await main.research_derive.run({ kind: 'combine', from_ids: [node('Dedup').id, node('GQA').id], title: 'Dedup + GQA' })).toMatch(/Across aspects/);
    expect(node('Dedup + GQA').links!.map((l) => l.kind)).toEqual(['combine', 'combine']);
    expect(await main.research_overview.run({})).toMatch(new RegExp(`\\[${node('Dedup').id}\\] method "Dedup"[\\s\\S]*finding: keeps code samples`));
  });

  it('keeps markdown notes: each aspect’s by its agent, the summary by the main agent; new agents start from them; finished batches ask for them', async () => {
    const { ws, p, as, main, doc, node } = await setup();
    const dataAgent = await ws.researchStartAgent(p.projectId, node('Data').id, { isolate: false });
    const data = as({ kind: 'agent', taskId: dataAgent.taskId });
    expect(await data.research_notes.run({ markdown: '## Tried\n- dedup 0.85 works' })).toMatch(/Notes for "Data" updated/);
    expect(readFileSync(join(p.rootPath, '.research', 'notes', `${node('Data').id}.md`), 'utf8')).toBe('## Tried\n- dedup 0.85 works\n');
    await expect(data.research_notes.run({ scope: node('Model').id, markdown: 'x' })).rejects.toThrow(/its own aspect/);
    await expect(data.research_notes.run({ scope: 'summary', markdown: 'x' })).rejects.toThrow(/lead’s/);
    expect(await main.research_notes.run({ scope: 'summary', markdown: '# Where things stand\nData helps.' })).toBe('Summary updated.');
    expect(ws.researchNotes(p.projectId).summary!.text).toMatch(/Data helps/);
    expect(ws.snapshot().research[0].notesAt).toBeTruthy();
    expect(await main.research_overview.run({})).toMatch(/--- summary\.md \(0 results since it was written\)[\s\S]*Data helps[\s\S]*--- notes for "Data"[\s\S]*dedup 0\.85 works/);

    // A new experiment's agent starts from what is known: its aspect's notes and the summary.
    await data.research_add.run({ type: 'method', title: 'Dedup' });
    await data.research_try.run({ method_id: node('Dedup').id, variants: [{ title: '0.86' }] });
    const e = doc().nodes.find((n) => n.title === '0.86')!;
    expect(ws.transcript(e.taskId!).find((i) => i.role === 'user')!.text).toMatch(/notes\):\n## Tried\n- dedup 0\.85 works[\s\S]*summary\):\n# Where things stand/);

    // Its result closes the batch: the aspect's agent is asked to update its notes.
    await until(() => ws.snapshot().tasks.find((t) => t.taskId === dataAgent.taskId)!.status !== 'running');
    const asked = () => ws.transcript(dataAgent.taskId).filter((i) => i.role === 'user' && /You may want to update the notes for "Data"/.test(i.text)).length;
    expect(asked()).toBe(0);
    await as({ kind: 'agent', taskId: e.taskId! }).research_record.run({ value: 75 });
    expect(asked()).toBe(1);
    expect(doc().nodes.find((n) => n.id === e.id)!.resultAt).toBeTruthy();

    // With a research lead: an aspect's new notes ask it for the summary, as often as the research's settings allow.
    const lead = await ws.researchStartLead(p.projectId, 'Hello');
    await until(() => ws.snapshot().tasks.find((t) => t.taskId === lead.taskId)!.status !== 'running');
    const askedSummary = () => ws.transcript(lead.taskId).filter((i) => i.role === 'user' && /The notes for "Data" changed[\s\S]*scope "summary"/.test(i.text)).length;
    await data.research_notes.run({ markdown: '## Tried\n- dedup 0.86: 75' });
    await data.research_notes.run({ markdown: '## Tried\n- dedup 0.86: 75 (again)' });
    expect(askedSummary()).toBe(1);

    // How the research runs is the user's, set with its lead: an aspect's agent cannot; the lead can.
    const asLead = as({ kind: 'agent', taskId: lead.taskId });
    await expect(data.research_settings.run({ mode: 'auto' })).rejects.toThrow(/with its lead/);
    expect(await asLead.research_settings.run({ mode: 'auto', auto_notes: false, summary_every_minutes: 0 })).toMatch(/mode auto, notes reminders off, summary every 0 min \(never\)/);
    expect(doc().policy).toEqual({ mode: 'auto', autoNotes: false, summaryEvery: 0 });
    // A new aspect agent is told the mode (an experiment's agent runs one variant; the mode is not its concern).
    const modelAgent = await ws.researchStartAgent(p.projectId, node('Model').id, { isolate: false });
    expect(ws.transcript(modelAgent.taskId).find((i) => i.role === 'user')!.text).toMatch(/on its own/);
    await data.research_try.run({ method_id: node('Dedup').id, variants: [{ title: '0.87' }] });
    const e87 = doc().nodes.find((n) => n.title === '0.87')!;
    // Reminders off: no summary request, no notes request when this batch has its results.
    (ws as unknown as { summaryAsked: Map<string, number> }).summaryAsked.clear();
    await data.research_notes.run({ markdown: 'x' });
    expect(askedSummary()).toBe(1);
    const before = asked();
    await as({ kind: 'agent', taskId: e87.taskId! }).research_record.run({ value: 76 });
    expect(asked()).toBe(before);
  });

  it('turns existing conversations into the tree: attached as they are, with what they found; not twice, not from another project', async () => {
    const { ws, p, main, doc, node } = await setup();
    const earlier = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Dedup at 0.85', isolate: false, mockScript: 'work', instruction: 'try it' });
    await main.research_add.run({ type: 'method', parent_id: node('Data').id, title: 'Dedup' });
    const r = await main.research_attach.run({ agent: earlier.alias, as: 'experiment', node_id: node('Dedup').id, outcome: 'works', value: 76.4, finding: '0.85 is the turning point' });
    expect(r).toMatch(/Attached Alice as experiment/);
    expect(doc().nodes.find((n) => n.taskId === earlier.taskId)).toMatchObject({ type: 'experiment', title: 'Dedup at 0.85', status: 'pass', value: 76.4, findings: [{ text: '0.85 is the turning point', by: 'Alice' }] });
    expect(ws.snapshot().research[0].taskIds).toContain(earlier.taskId);
    await expect(main.research_attach.run({ agent: earlier.alias, as: 'aspect_agent', node_id: node('Model').id })).rejects.toThrow(/already in the research/);
    const elsewhere = await ws.addProject(repo(), 'other');
    const stranger = await ws.createTask({ projectId: elsewhere.projectId, provider: 'mock', title: 'x', isolate: false, mockScript: 'work', instruction: 'go' });
    await expect(main.research_attach.run({ agent: stranger.alias, as: 'aspect_agent', node_id: node('Model').id })).rejects.toThrow(/another project/);
  });
});

describe('voice dispatch', () => {
  it('off-focus dispatch reaches only the target; the focused task history is unchanged', async () => {
    const { ws, A, B } = await demo(open());
    const bBefore = ws.transcript(B.taskId).length;
    const decision = await ws.decideRoute('Alice, add a regression test', B.taskId);
    expect(decision).toMatchObject({ kind: 'existing', taskId: A.taskId, confidence: 'high' });
    const r = await ws.dispatch('Alice, add a regression test', { kind: 'existing', taskId: A.taskId }, B.taskId);
    expect(r.ok).toBe(true);
    expect(ws.transcript(A.taskId).some((i) => i.via === 'voice' && /regression/.test(i.text))).toBe(true);
    expect(ws.transcript(B.taskId).length).toBe(bBefore);
  });

  it('ambiguous route asks and sends nothing', async () => {
    const ws = open();
    const p = await ws.addProject(repo());
    const A = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Backend API v2', isolate: false });
    const D = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'Backend API rate limiting', isolate: false });
    const d = await ws.decideRoute('fix that API', null);
    expect(d.kind).toBe('clarify');
    expect(ws.transcript(A.taskId)).toHaveLength(0);
    expect(ws.transcript(D.taskId)).toHaveLength(0);
  });

  it('coordinator questions are answered without touching worker transcripts', async () => {
    const { ws, A, C } = await demo(open());
    const before = ws.transcript(A.taskId).length;
    const r = await ws.dispatch('哪些在等我', { kind: 'coordinator' });
    expect(r.reply).toMatch(/Alice/);
    expect(r.reply).toMatch(/data-loss/);
    expect(ws.transcript(A.taskId).length).toBe(before);
    expect(ws.transcript(C.taskId).some((i) => /哪些/.test(i.text))).toBe(false);
  });
});

describe('scoped memory', () => {
  it('project memory reaches new tasks in that project only; task notes stay private', async () => {
    const ws = open();
    const p1 = await ws.addProject(repo(), 'shop');
    const p2 = await ws.addProject(repo(), 'other');
    const a = await ws.createTask({ projectId: p1.projectId, provider: 'mock', title: 'api', isolate: false });
    ws.addMemory({ scope: 'task', scopeId: a.taskId, body: 'PRIVATE: staging password is in vault X', originTaskId: a.taskId, approvedForReuse: false, source: 'test' });
    const conv = ws.addMemory({ scope: 'project', scopeId: p1.projectId, body: 'Always run integration tests', originTaskId: a.taskId, approvedForReuse: true, source: 'test' });
    ws.addMemory({ scope: 'project', scopeId: p1.projectId, body: 'unapproved draft', approvedForReuse: false, source: 'test' });

    const same = await ws.createTask({ projectId: p1.projectId, provider: 'mock', title: 'ui', isolate: false, instruction: 'go' });
    const other = await ws.createTask({ projectId: p2.projectId, provider: 'mock', title: 'x', isolate: false, instruction: 'go' });
    const injected = (id: string) => ws.snapshot().tasks.find((t) => t.taskId === id)!.injectedMemoryIds ?? [];
    expect(injected(same.taskId)).toEqual([conv.id]);
    expect(injected(other.taskId)).toEqual([]);
    await until(() => ws.transcript(same.taskId).some((i) => i.role === 'assistant'));
    await until(() => ws.transcript(other.taskId).some((i) => i.role === 'assistant'));
    const sameText = ws.transcript(same.taskId).map((i) => i.text).join('\n');
    const otherText = ws.transcript(other.taskId).map((i) => i.text).join('\n');
    expect(sameText).toMatch(/integration tests/);
    expect(sameText).not.toMatch(/PRIVATE|unapproved/);
    expect(otherText).not.toMatch(/integration tests|PRIVATE/);

    // Promotion to global is explicit and visible to new tasks everywhere.
    const g = ws.promoteMemory(conv.id, 'global');
    expect(g).toMatchObject({ scope: 'global', approvedForReuse: true });
    const later = await ws.createTask({ projectId: p2.projectId, provider: 'mock', title: 'y', isolate: false, instruction: 'go' });
    expect(injected(later.taskId)).toEqual([g.id]);
  });

  it('voice "remember … for this project" saves to the focused project scope', async () => {
    const { ws, A, project } = await demo(open());
    const r = await ws.dispatch('记住：这个项目总是先跑集成测试', { kind: 'coordinator' }, A.taskId);
    expect(r.reply).toMatch(/Saved to project/);
    expect(ws.snapshot().memory.find((m) => m.scope === 'project')).toMatchObject({ scopeId: project.projectId, approvedForReuse: true });
  });
});

describe('worktrees', () => {
  it('isolated tasks get separate worktrees; dirty worktrees are never removed', async () => {
    const ws = open();
    const p = await ws.addProject(repo());
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'A work', isolate: true });
    const b = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'B work', isolate: true });
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.worktree?.branch).toMatch(/^amw\//);
    writeFileSync(join(a.cwd, 'only-in-a.txt'), 'x');
    expect(existsSync(join(b.cwd, 'only-in-a.txt'))).toBe(false);
    expect(existsSync(join(p.rootPath, 'only-in-a.txt'))).toBe(false);
    const note = await ws.remove(a.taskId);
    expect(note).toMatch(/kept/);
    expect(existsSync(join(a.cwd, 'only-in-a.txt'))).toBe(true);
    const clean = await ws.remove(b.taskId);
    expect(clean).toMatch(/deleted/);
    expect(existsSync(b.cwd)).toBe(false);
  });

  it('a fork continues a copy of the conversation, now or from an earlier prompt, in its own worktree', async () => {
    const ws = open();
    const p = await ws.addProject(repo());
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', name: 'backend', title: 'API', isolate: true, mockScript: 'work', instruction: 'First request.' });
    const idle = (id: string) => () => ['done', 'idle', 'waiting_for_user'].includes(ws.snapshot().tasks.find((t) => t.taskId === id)!.status);
    await until(idle(a.taskId));
    await ws.send(a.taskId, 'Second request.', 'text');
    await until(idle(a.taskId));
    const said = (id: string) => ws.transcript(id).filter((i) => i.role === 'user').map((i) => i.text);
    const commit = (cwd: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
    writeFileSync(join(a.cwd, 'old.txt'), 'to be deleted');
    git(a.cwd, 'add', 'old.txt');
    git(a.cwd, 'commit', '-qm', 'work by A');
    // A's uncommitted work: an edit, a deletion, a staged new file and an untracked one in a new folder.
    writeFileSync(join(a.cwd, 'README.md'), '# test\nedited by A\n');
    git(a.cwd, 'rm', '-q', 'old.txt');
    writeFileSync(join(a.cwd, 'staged.txt'), 'staged');
    git(a.cwd, 'add', 'staged.txt');
    mkdirSync(join(a.cwd, 'notes'));
    writeFileSync(join(a.cwd, 'notes', 'draft.txt'), 'uncommitted');
    const aStatus = git(a.cwd, 'status', '--porcelain', '-uall');

    const points = await ws.forkPoints(a.taskId);
    expect(points.map((x) => x.prompt)).toEqual(['Second request.']);

    // From before the second request, with that request sent again in other words.
    const b = await ws.forkTask(a.taskId, { upToMessageId: points[0].upToMessageId, isolate: true, instruction: 'Second request, but smaller.' });
    expect(b.forkedFrom).toEqual({ taskId: a.taskId, alias: a.alias });
    // Its own voice handle, not a second "backend".
    expect(b.name).toBe('backend fork');
    expect(b.cwd).not.toBe(a.cwd);
    expect(commit(b.cwd)).toBe(commit(a.cwd));
    // Its files match what its conversation remembers: A's uncommitted work came along, and A is untouched.
    expect(readFileSync(join(b.cwd, 'README.md'), 'utf8')).toBe('# test\nedited by A\n');
    expect(existsSync(join(b.cwd, 'old.txt'))).toBe(false);
    expect(readFileSync(join(b.cwd, 'staged.txt'), 'utf8')).toBe('staged');
    expect(readFileSync(join(b.cwd, 'notes', 'draft.txt'), 'utf8')).toBe('uncommitted');
    expect(git(a.cwd, 'status', '--porcelain', '-uall')).toBe(aStatus);
    expect(ws.snapshot().coordinator.some((m) => /uncommitted changes were copied too \(4 files\)/.test(m.text))).toBe(true);
    await until(idle(b.taskId));
    expect(said(b.taskId)).toEqual(['First request.', 'Second request, but smaller.']);

    // The whole conversation; the original keeps its own.
    const c = await ws.forkTask(a.taskId, { isolate: false });
    expect(c.sharedCwdWarning).toMatch(/not isolated/);
    expect(c.name).toBe('backend fork 2');
    await ws.send(c.taskId, 'Third request.', 'text');
    await until(idle(c.taskId));
    expect(said(c.taskId)).toEqual(['First request.', 'Second request.', 'Third request.']);
    expect(said(a.taskId)).toEqual(['First request.', 'Second request.']);

    const fresh = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'never started', isolate: false });
    await expect(ws.forkTask(fresh.taskId, { isolate: false })).rejects.toThrow(/no saved conversation/);

    // A clean fork's branch is deleted with its worktree, though it started ahead of the project's HEAD.
    const branches = () => execFileSync('git', ['branch', '--list', b.worktree!.branch], { cwd: p.rootPath, encoding: 'utf8' }).trim();
    expect(branches()).not.toBe('');
    git(b.cwd, 'reset', '-q', '--hard');
    git(b.cwd, 'clean', '-qfd');
    expect(await ws.remove(b.taskId)).toMatch(/clean worktree was deleted/);
    expect(branches()).toBe('');
  });

  it('a fork is created for its own worktree, and fork support shows as a provider capability', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const mock = new MockAdapter(join(dataDir, 'mock-sessions'), DELAY);
    const ws = new Workspace({ dataDir, adapters: { mock } });
    opened.push(ws);
    await ws.refreshCapabilities({ localOnly: true });
    expect(ws.snapshot().capabilities.find((c) => c.provider === 'mock')?.fork).toBe(true);
    const p = await ws.addProject(repo());
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'API', isolate: true, mockScript: 'work', instruction: 'First request.' });
    await until(() => ['done', 'idle', 'waiting_for_user'].includes(ws.snapshot().tasks.find((t) => t.taskId === a.taskId)!.status));
    const forkSession = vi.spyOn(mock, 'forkSession');
    const b = await ws.forkTask(a.taskId, { isolate: true });
    // Found where the original is; recorded where the fork works (Codex keeps a thread's folder).
    expect(forkSession).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cwd: a.cwd, targetCwd: b.cwd }));
    expect(b.cwd).not.toBe(a.cwd);
  });

  it('a fork of an agent working in a subfolder works in the same subfolder, with all the uncommitted work', async () => {
    const ws = open();
    const root = repo();
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app', 'main.ts'), 'v1');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'app'], { cwd: root });
    const p = await ws.addProject(root);
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'App', isolate: true, mockScript: 'work', instruction: 'Work on the app.' });
    await until(() => ['done', 'idle', 'waiting_for_user'].includes(ws.snapshot().tasks.find((t) => t.taskId === a.taskId)!.status));
    // As an imported session can: the agent works in the app/ subfolder of its checkout.
    const top = a.cwd;
    const sub = join(top, 'app');
    (ws as unknown as { store: { data: { tasks: Array<{ taskId: string; cwd: string }> } } }).store.data.tasks.find((t) => t.taskId === a.taskId)!.cwd = sub;
    writeFileSync(join(sub, 'main.ts'), 'v2');
    writeFileSync(join(sub, 'new.ts'), 'new');
    writeFileSync(join(top, 'TODO.md'), 'outside the subfolder');

    const b = await ws.forkTask(a.taskId, { isolate: true });
    expect(b.cwd).toBe(join(b.worktree!.path, 'app'));
    expect(readFileSync(join(b.cwd, 'main.ts'), 'utf8')).toBe('v2');
    expect(readFileSync(join(b.cwd, 'new.ts'), 'utf8')).toBe('new');
    expect(readFileSync(join(b.worktree!.path, 'TODO.md'), 'utf8')).toBe('outside the subfolder');
    expect(existsSync(join(b.worktree!.path, 'new.ts'))).toBe(false);
  });

  it('a fork waits for the current turn to end', async () => {
    const ws = open();
    const p = await ws.addProject(repo());
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'ops', isolate: false, mockScript: 'approval:deploy', instruction: 'deploy' });
    await until(() => ws.snapshot().attention.some((x) => x.taskId === a.taskId && x.kind === 'approval' && x.state === 'open'));
    await expect(ws.forkTask(a.taskId, { isolate: false })).rejects.toThrow(/still working/);
    expect(ws.snapshot().tasks.filter((t) => t.forkedFrom)).toEqual([]);
    await ws.respondAttention(ws.snapshot().attention.find((x) => x.kind === 'approval')!.id, 'deny');
    await until(() => ['done', 'idle', 'waiting_for_user'].includes(ws.snapshot().tasks.find((t) => t.taskId === a.taskId)!.status));
    expect((await ws.forkTask(a.taskId, { isolate: false })).forkedFrom?.taskId).toBe(a.taskId);
  });

  it('a first instruction that cannot be delivered is kept on the fork to resend', async () => {
    const ws = open();
    const p = await ws.addProject(repo());
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'API', isolate: false, mockScript: 'work', instruction: 'First request.' });
    await until(() => ['done', 'idle', 'waiting_for_user'].includes(ws.snapshot().tasks.find((t) => t.taskId === a.taskId)!.status));
    vi.spyOn(ws, 'send').mockImplementationOnce(async (taskId) => ({ ok: false, taskId, error: 'claude not found' }));
    const b = await ws.forkTask(a.taskId, { isolate: false, instruction: 'Try the smaller change.' });
    expect(ws.transcript(b.taskId).at(-1)?.text).toMatch(/not sent[\s\S]*Try the smaller change\./);
    expect(ws.snapshot().coordinator.at(-1)?.text).toMatch(/not delivered: claude not found/);
  });

  it('warns when tasks share a writable directory', async () => {
    const ws = open();
    const p = await ws.addProject(repo());
    await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'one', isolate: false });
    const two = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'two', isolate: false });
    expect(two.sharedCwdWarning).toMatch(/not isolated/);
  });

  it('every agent in a shared folder names all the others, an imported session included, and a removed one drops out', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const ws = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), DELAY) }, backgroundModel: async () => '' });
    opened.push(ws);
    const p = await ws.addProject(repo());
    const one = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'one', isolate: false });
    const two = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'two', isolate: false });
    const warning = (taskId: string) => ws.snapshot().tasks.find((t) => t.taskId === taskId)!.sharedCwdWarning;
    const shares = (...names: string[]) => `Shares a writable directory with ${names.join(', ')} — edits are not isolated.`;
    expect(warning(two.taskId)).toBe(shares(one.alias));
    expect(warning(one.taskId)).toBe(shares(two.alias));

    const imported = await ws.importSession({ projectId: p.projectId, provider: 'claude', nativeSessionId: 's1', cwd: p.rootPath, title: 'Old session' });
    expect(imported.sessionLocalId).toBeTruthy();
    expect(warning(imported.taskId)).toBe(`Uses its original directory, shared with ${one.alias}, ${two.alias} — not isolated.`);
    expect(warning(one.taskId)).toBe(shares(two.alias, imported.alias));
    expect(warning(two.taskId)).toBe(shares(one.alias, imported.alias));

    await ws.remove(two.taskId);
    expect(warning(one.taskId)).toBe(shares(imported.alias));
    await ws.remove(imported.taskId);
    expect(warning(one.taskId)).toBeUndefined();
  });

  it('warnings saved by an older version are rewritten on start, keeping an agent’s reason for having no worktree', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const first = open(dataDir);
    const p = await first.addProject(repo());
    const one = await first.createTask({ projectId: p.projectId, provider: 'mock', title: 'one', isolate: false });
    const two = await first.createTask({ projectId: p.projectId, provider: 'mock', title: 'two', isolate: false });
    const three = await first.createTask({ projectId: p.projectId, provider: 'mock', title: 'three', isolate: false });
    // As older versions saved them: no cwdNote, the reason in the text, and stale or partial names.
    const reason = `Worktree not created (boom); this task edits ${p.rootPath} directly.`;
    const data = (first as unknown as { store: { data: { tasks: Record<string, unknown>[] } } }).store.data;
    let tasks = data.tasks;
    for (const t of tasks) {
      delete t.cwdNote;
      delete t.keptOriginalFolder;
    }
    tasks[0].sharedCwdWarning = `Shares a writable directory with ${three.alias} — edits are not isolated.`;
    tasks[1].sharedCwdWarning = `Shares a writable directory with ${three.alias} — edits are not isolated.`;
    tasks[2].sharedCwdWarning = reason;
    await first.remove(three.taskId);
    tasks = data.tasks;
    tasks.push({ ...tasks[0], taskId: 't-elsewhere', alias: 'Z', cwd: '/elsewhere', sharedCwdWarning: reason });
    await first.shutdown();
    opened.splice(opened.indexOf(first), 1);

    const ws = open(dataDir);
    const warning = (taskId: string) => ws.snapshot().tasks.find((t) => t.taskId === taskId)!.sharedCwdWarning;
    expect(warning(one.taskId)).toBe(`Shares a writable directory with ${two.alias} — edits are not isolated.`);
    expect(warning('t-elsewhere')).toBe(reason);
  });
});

describe('main agent tools', () => {
  it('see every agent, find them by name or role, and message them on the user’s behalf', async () => {
    const ws = open();
    const project = await ws.addProject(repo(), 'shop');
    const A = await ws.createTask({ projectId: project.projectId, provider: 'mock', name: 'backend', title: 'Backend API', isolate: true, instruction: 'Migrate API.' });
    const B = await ws.createTask({ projectId: project.projectId, provider: 'mock', name: 'frontend', title: 'Dashboard', isolate: true, instruction: 'Build cards.' });
    await until(() => ws.snapshot().tasks.every((t) => t.status === 'done' || t.status === 'waiting_for_user'));
    const { workspaceTools } = await import('../../src/main/main-agent');
    const tools = Object.fromEntries(workspaceTools(ws).map((t) => [t.name, t]));

    const list = await tools.list_workspace_agents.run({});
    expect(list).toContain('Alice (working on: backend)');
    expect(list).toContain('Bob (working on: frontend)');
    expect(ws.findAgent('alice')?.taskId).toBe(A.taskId);
    expect(ws.findAgent('frontend')?.taskId).toBe(B.taskId);
    expect(ws.findAgent('Frontend Bob')?.taskId).toBe(B.taskId);

    expect(await tools.send_to_agent.run({ agent: 'Bob', message: 'Use the shared Button component.' })).toMatch(/Sent to Bob/);
    const msg = ws.transcript(B.taskId).find((i) => i.role === 'user' && i.text === 'Use the shared Button component.');
    expect(msg?.via).toBe('main');
    expect(ws.transcript(A.taskId).some((i) => i.text === 'Use the shared Button component.')).toBe(false);

    expect(await tools.read_agent.run({ agent: 'Alice', limit: 6 })).toContain('[user] Migrate API.');
    await expect(tools.send_to_agent.run({ agent: 'Zed', message: 'hi' })).rejects.toThrow(/No agent named "Zed"/);
    expect(await tools.create_agent.run({ project: 'nope', title: 'x', instruction: 'y' })).toMatch(/Unknown project/);
  });

  it('branch off an agent with its context, never with more permissions than the default', async () => {
    const ws = open();
    const project = await ws.addProject(repo(), 'shop');
    const A = await ws.createTask({ projectId: project.projectId, provider: 'mock', name: 'backend', title: 'Bug', isolate: true, mockScript: 'work', instruction: 'Investigate the bug.' });
    const idle = (id: string) => () => ['done', 'idle', 'waiting_for_user'].includes(ws.snapshot().tasks.find((t) => t.taskId === id)!.status);
    await until(idle(A.taskId));
    await ws.send(A.taskId, 'Try the\n  cache fix.', 'text');
    await until(idle(A.taskId));
    writeFileSync(join(A.cwd, 'findings.md'), 'the bug is in the cache');
    // The user gave Alice more than the workspace default; a fork the main agent makes does not inherit that.
    ws.updateSettings({ permissionMode: 'edits' });
    await ws.setPermissionMode(A.taskId, 'auto');
    const { workspaceTools, MAX_FORKS_PER_TURN } = await import('../../src/main/main-agent');
    const tools = Object.fromEntries(workspaceTools(ws).map((t) => [t.name, t]));

    // Matched with whitespace collapsed, as read_agent shows it.
    const r = await tools.fork_agent.run({ agent: 'Alice', instruction: 'Try the index fix instead.', before_prompt: 'try the CACHE', label: 'Approach B' });
    expect(r).toMatch(/^Forked Alice as \S+ in its own worktree \(amw\/.+\); it is working on its instruction\.$/);
    const B = ws.snapshot().tasks.find((t) => t.forkedFrom?.taskId === A.taskId)!;
    expect(B.name).toBe('Approach B');
    expect(B.cwd).not.toBe(A.cwd);
    expect(readFileSync(join(B.cwd, 'findings.md'), 'utf8')).toBe('the bug is in the cache');
    expect(ws.permissionModeOf(B)).toBe('edits');
    await until(idle(B.taskId));
    const said = ws.transcript(B.taskId).filter((i) => i.role === 'user');
    expect(said.map((i) => i.text)).toEqual(['Investigate the bug.', 'Try the index fix instead.']);
    expect(said.at(-1)?.via).toBe('main');

    // A stricter mode the user chose is kept.
    await ws.setPermissionMode(A.taskId, 'ask');
    await tools.fork_agent.run({ agent: 'Alice', instruction: 'Write a failing test first.' });
    expect(ws.permissionModeOf(ws.snapshot().tasks.at(-1)!)).toBe('ask');

    await expect(tools.fork_agent.run({ agent: 'Alice', instruction: 'x', before_prompt: 'nope' })).rejects.toThrow(/None of Alice's earlier prompts start with "nope". Its earlier prompts: "Try the cache fix."/);
    // Calls made in parallel cannot all pass the per-message limit.
    const parallel = await Promise.all([1, 2, 3].map((i) => tools.fork_agent.run({ agent: 'Alice', instruction: `Branch ${i}.` })));
    expect(parallel.filter((x) => x.startsWith('Not forked: at most 3 forks')).length).toBe(2);
    expect(ws.snapshot().tasks.filter((t) => t.forkedFrom).length).toBe(MAX_FORKS_PER_TURN);
  });

  it('fork_agent says when the fork shares the folder, outside a git repository', async () => {
    const ws = open();
    const folder = mkdtempSync(join(tmpdir(), 'amw-test-plain-'));
    const project = await ws.addProject(folder, 'notes');
    const A = await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'Notes', isolate: true, mockScript: 'work', instruction: 'Tidy the notes.' });
    await until(() => ['done', 'idle', 'waiting_for_user'].includes(ws.snapshot().tasks.find((t) => t.taskId === A.taskId)!.status));
    const { workspaceTools } = await import('../../src/main/main-agent');
    const tools = Object.fromEntries(workspaceTools(ws).map((t) => [t.name, t]));
    expect(await tools.fork_agent.run({ agent: A.alias, instruction: 'Try a shorter layout.' })).toMatch(/sharing Alice's folder \(the project is not a git repository, so their edits are not isolated\)/);
  });

  it('give a quick look at a project and at what an agent changed, without the files themselves', async () => {
    const ws = open();
    const root = repo();
    writeFileSync(join(root, 'README.md'), '# Shop\nOrders and payments service.\n');
    const project = await ws.addProject(root, 'shop');
    const A = await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'Docs', isolate: true });
    const { workspaceTools } = await import('../../src/main/main-agent');
    const tools = Object.fromEntries(workspaceTools(ws).map((t) => [t.name, t]));

    const overview = await tools.project_overview.run({ project: 'shop' });
    expect(overview).toMatch(/branch \S+; 1 uncommitted file/);
    expect(overview).toContain('README.md');
    expect(overview).toContain('Orders and payments service.');
    expect(overview).toMatch(/recent commits:\n\w+ init/);

    expect(await tools.agent_changes.run({ agent: 'Alice' })).toMatch(/has not changed any files/);
    writeFileSync(join(A.cwd, 'NOTES.md'), 'new\n');
    writeFileSync(join(A.cwd, 'README.md'), 'changed\n');
    const changes = await tools.agent_changes.run({ agent: 'Alice' });
    expect(changes).toContain(`branch ${A.worktree!.branch}`);
    expect(changes).toMatch(/README\.md \| +\d+ [+-]+/);
    expect(changes).toContain('new files: NOTES.md');
  });

  it('stop a loop: the same call again and again is refused within one user message', async () => {
    const ws = open();
    await ws.addProject(repo(), 'shop');
    const { workspaceTools } = await import('../../src/main/main-agent');
    const tools = Object.fromEntries(workspaceTools(ws).map((t) => [t.name, t]));
    for (let i = 0; i < 3; i++) expect(await tools.list_projects.run({})).toContain('shop');
    expect(await tools.list_projects.run({})).toMatch(/^Not run: you already have this/);
    // A new message from the user starts over.
    (ws as unknown as { mainTurns: number }).mainTurns++;
    expect(await tools.list_projects.run({})).toContain('shop');
  });
});

describe('main agent answering requests', () => {
  it('passes on answers, but approves a permission request only with the user’s own words', async () => {
    const ws = open();
    const project = await ws.addProject(repo(), 'shop');
    const A = await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'Cleanup', isolate: true, mockScript: 'approval:rm -rf build', instruction: 'Clean the build.' });
    await until(() => ws.listRequests().length === 1);
    const req = ws.listRequests()[0].item;
    const { workspaceTools } = await import('../../src/main/main-agent');
    const tools = Object.fromEntries(workspaceTools(ws).map((t) => [t.name, t]));
    expect(await tools.list_requests.run({})).toContain(`request_id ${req.id} · Alice · PERMISSION REQUEST`);

    // A main agent conversation where the user has said something.
    const internal = ws as unknown as { store: { data: { mainAgent?: unknown } }; upsertTranscript(id: string, item: unknown): void };
    internal.store.data.mainAgent = { taskId: 't-main-x', alias: 'Main', name: 'Main', projectId: '', title: 'Main agent', provider: 'mock', status: 'idle', summary: '', cwd: '/tmp', createdAt: '', updatedAt: '' };
    const userSays = (text: string) => internal.upsertTranscript('t-main-x', { id: `u-${text}`, taskId: 't-main-x', role: 'user', text, via: 'text', createdAt: '' });

    userSays('what does Alice need?');
    expect(await tools.answer_request.run({ request_id: req.id, choice: 'allow' })).toMatch(/Not allowed/);
    expect(await tools.answer_request.run({ request_id: req.id, choice: 'allow', user_words: 'yes go ahead' })).toMatch(/Not allowed/); // not what the user said
    userSays('不行，先别删');
    expect(await tools.answer_request.run({ request_id: req.id, choice: 'allow', user_words: '不行，先别删' })).toMatch(/do not clearly approve/);
    userSays('好的，批准 Alice 删 build');
    expect(await tools.answer_request.run({ request_id: req.id, choice: 'allow', user_words: '批准 Alice 删 build' })).toMatch(/Allow once — sent to Alice/);
    expect(ws.listRequests()).toHaveLength(0);
    await until(() => ws.transcript(A.taskId).some((i) => /command executed/.test(i.text)));
  });

  it('can always refuse, and answers a question the agent asked in its reply', async () => {
    const ws = open();
    const project = await ws.addProject(repo(), 'shop');
    await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'Deploy', isolate: true, mockScript: 'approval:git push --force', instruction: 'Ship it.' });
    const B = await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'API', isolate: true, mockScript: 'ask:Keep the v1 adapter?', instruction: 'Migrate.' });
    await until(() => ws.listRequests().length === 2);
    const { workspaceTools } = await import('../../src/main/main-agent');
    const tools = Object.fromEntries(workspaceTools(ws).map((t) => [t.name, t]));
    const [perm, question] = [ws.listRequests().find((r) => r.item.kind === 'approval')!.item, ws.listRequests().find((r) => r.item.kind === 'question')!.item];
    expect(await tools.answer_request.run({ request_id: perm.id, choice: 'deny' })).toMatch(/Deny — sent to Alice/);
    expect(await tools.answer_request.run({ request_id: question.id, answer: 'Yes, keep it for one release.' })).toMatch(/Replied to Bob/);
    expect(ws.transcript(B.taskId).some((i) => i.role === 'user' && i.via === 'main' && /keep it for one release/.test(i.text))).toBe(true);
  });
});

describe('the request the user has unfolded', () => {
  it('goes to the main agent as a hint of what the message answers, never shown, never an approval', async () => {
    const ws = open();
    const project = await ws.addProject(repo(), 'shop');
    await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'Deploy', isolate: true, mockScript: 'approval:git push --force', instruction: 'Ship it.' });
    await until(() => ws.listRequests().length === 1);
    const req = ws.listRequests()[0].item;
    const internal = ws as unknown as { store: { data: { mainAgent?: unknown } }; connect(id: string): Promise<unknown> };
    internal.store.data.mainAgent = { taskId: 't-main-z', alias: 'Main', name: 'Main', projectId: '', title: 'Main agent', provider: 'mock', status: 'idle', summary: '', cwd: '/tmp', createdAt: '', updatedAt: '' };
    // What reaches the main agent's session.
    const sent: string[] = [];
    internal.connect = async () => ({ turnActive: false, session: { send: async (t: string) => (sent.push(t), 'turn') } });

    await ws.send('t-main-z', 'not yet, wait for the review', 'text', { openRequest: req.id });
    expect(sent[0]).toMatch(new RegExp(`^\\[Open request: .*request_id ${req.id} · Alice · permission request: Run command: git push --force\\..*not an approval\\.\\]\\n\\nnot yet, wait for the review$`));
    // The conversation shows what the user wrote, nothing more.
    expect(ws.transcript('t-main-z').filter((i) => i.role === 'user').map((i) => i.text)).toEqual(['not yet, wait for the review']);
    // The request is still open: the hint answers nothing by itself.
    expect(ws.listRequests()).toHaveLength(1);
    const { workspaceTools } = await import('../../src/main/main-agent');
    const tools = Object.fromEntries(workspaceTools(ws).map((t) => [t.name, t]));
    // Nor can the note be quoted as the user's approval.
    expect(await tools.answer_request.run({ request_id: req.id, choice: 'allow', user_words: 'Their message is most likely about it' })).toMatch(/Not allowed/);

    // Nothing unfolded, or a request no longer open: no note.
    await ws.send('t-main-z', 'how is it going?', 'text');
    await ws.send('t-main-z', 'and now?', 'text', { openRequest: 'a-gone' });
    expect(sent.slice(1)).toEqual(['how is it going?', 'and now?']);
  });
});

describe('one pending state for every view', () => {
  it('a question answered directly on the agent disappears from the main agent’s list and is noted there', async () => {
    const ws = open();
    const project = await ws.addProject(repo(), 'shop');
    const internal = ws as unknown as { store: { data: { mainAgent?: unknown } } };
    internal.store.data.mainAgent = { taskId: 't-main-y', alias: 'Main', name: 'Main', projectId: '', title: 'Main agent', provider: 'mock', status: 'idle', summary: '', cwd: '/tmp', createdAt: '', updatedAt: '' };
    const A = await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'API', isolate: true, mockScript: 'ask:Keep the v1 adapter?', instruction: 'Migrate.' });
    await until(() => ws.listRequests().length === 1);
    expect(ws.transcript('t-main-y').some((i) => /Alice is waiting on you \(question\): .*Keep the v1 adapter\?/.test(i.text))).toBe(true);

    await ws.send(A.taskId, 'Keep it for one release.', 'text'); // straight to Alice, not via the main agent
    expect(ws.listRequests()).toHaveLength(0);
    expect(ws.transcript('t-main-y').some((i) => /Alice's request is settled: Replied: Keep it for one release\./.test(i.text))).toBe(true);
  });
});

describe('user activity (orders the sidebar)', () => {
  it('counts messages and answers to an agent; neither opening it nor its own output reorders anything', async () => {
    const ws = open();
    const p = await ws.addProject(repo());
    const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'ops', isolate: false, mockScript: 'approval:deploy', instruction: 'deploy' });
    const at = () => ws.snapshot().tasks.find((t) => t.taskId === a.taskId)!.lastUserActivityAt;
    // The first instruction is the user's.
    expect(at()).toBeTruthy();
    await until(() => ws.snapshot().attention.some((x) => x.taskId === a.taskId && x.kind === 'approval' && x.state === 'open'));
    const afterSend = at();
    // The agent working and asking is not the user's doing.
    ws.handleEvent(a.taskId, ws.snapshot().tasks.find((t) => t.taskId === a.taskId)!.sessionLocalId!, { type: 'progress', text: 'still deploying' });
    expect(at()).toBe(afterSend);
    // Opening it (a click in the list) is looking, not working with it: the order stays.
    await new Promise((r) => setTimeout(r, 5));
    ws.markViewed(a.taskId);
    expect(at()).toBe(afterSend);
    const store = (ws as unknown as { store: { data: { tasks: Array<{ taskId: string; lastUserActivityAt?: string }> } } }).store;
    // Answering its request.
    store.data.tasks.find((t) => t.taskId === a.taskId)!.lastUserActivityAt = new Date(Date.now() - 120_000).toISOString();
    await ws.respondAttention(ws.snapshot().attention.find((x) => x.kind === 'approval')!.id, 'deny');
    expect(Date.now() - Date.parse(at()!)).toBeLessThan(5_000);
  });
});
