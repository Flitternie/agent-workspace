import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../../src/main/providers/mock';
import { Workspace } from '../../src/main/workspace';

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

  it('warns when tasks share a writable directory', async () => {
    const ws = open();
    const p = await ws.addProject(repo());
    await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'one', isolate: false });
    const two = await ws.createTask({ projectId: p.projectId, provider: 'mock', title: 'two', isolate: false });
    expect(two.sharedCwdWarning).toMatch(/not isolated/);
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

    const list = await tools.list_agents.run({});
    expect(list).toContain('Alice (role: backend)');
    expect(list).toContain('Bob (role: frontend)');
    expect(ws.findAgent('alice')?.taskId).toBe(A.taskId);
    expect(ws.findAgent('frontend')?.taskId).toBe(B.taskId);
    expect(ws.findAgent('Frontend Bob')?.taskId).toBe(B.taskId);

    expect(await tools.send_to_agent.run({ agent: 'Bob', message: 'Use the shared Button component.' })).toMatch(/Sent to Bob/);
    const msg = ws.transcript(B.taskId).find((i) => i.role === 'user' && i.text === 'Use the shared Button component.');
    expect(msg?.via).toBe('main');
    expect(ws.transcript(A.taskId).some((i) => i.text === 'Use the shared Button component.')).toBe(false);

    expect(await tools.read_agent.run({ agent: 'Alice', limit: 5 })).toContain('[user] Migrate API.');
    await expect(tools.send_to_agent.run({ agent: 'Zed', message: 'hi' })).rejects.toThrow(/No agent named "Zed"/);
    expect(await tools.create_agent.run({ project: 'nope', title: 'x', instruction: 'y' })).toMatch(/Unknown project/);
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
