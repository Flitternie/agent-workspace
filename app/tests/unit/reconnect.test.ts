// An agent on an SSH host whose connection goes: no error to dismiss, it reconnects by itself once the
// host answers (and carries on with a turn it was in); a host only the user can let in gets one note.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteHostStatus } from '../../src/shared/types';

let probe: { state: RemoteHostStatus['ssh']; error?: string } = { state: 'unreachable', error: 'ssh: connect to host devbox: Network is unreachable' };
vi.mock('../../src/main/util/ssh', async (orig) => ({
  ...(await orig<typeof import('../../src/main/util/ssh')>()),
  sshHosts: () => ['devbox'],
  sshProbe: async () => probe,
  loadKeychainKeys: async () => {},
}));
const { MockAdapter } = await import('../../src/main/providers/mock');
const { Workspace } = await import('../../src/main/workspace');

const opened: InstanceType<typeof Workspace>[] = [];
afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.shutdown();
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(10);
  }
}
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amw-test-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  return dir;
}
const LOST = 'Claude Code on devbox ended unexpectedly: it was stopped on devbox, or the SSH connection closed.';

async function setup(delay = 5, giveUpMs?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
  const ws = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), delay) }, reconnectMs: [80], reconnectGiveUpMs: giveUpMs });
  opened.push(ws);
  ws.updateSettings({ remoteHosts: ['devbox'] });
  const project = await ws.addProject(repo(), 'shop');
  const t = await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'remote', isolate: false, mockScript: 'work', instruction: 'Start.' });
  const task = () => ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!;
  await until(() => task().status === 'done');
  // Stands in for an agent on the host (the mock runs here; what matters is the task's host).
  (ws as unknown as { store: { data: { tasks: Array<{ taskId: string; host?: string }> } } }).store.data.tasks.find((x) => x.taskId === t.taskId)!.host = 'devbox';
  const errors = () => ws.snapshot().attention.filter((a) => a.taskId === t.taskId && a.state === 'open' && a.kind === 'error');
  const drop = () => ws.handleEvent(t.taskId, task().sessionLocalId!, { type: 'sessionFailed', error: LOST });
  return { ws, t, task, errors, drop };
}

describe('reconnecting agents on a host', () => {
  it('waits quietly while the host is out of reach, then reconnects and carries on with the turn it was in', async () => {
    probe = { state: 'unreachable', error: 'Network is unreachable' };
    const { ws, t, task, errors, drop } = await setup(60);
    await ws.send(t.taskId, 'Next step.', 'text');
    await until(() => task().status === 'running');
    drop();
    expect(task().status).toBe('disconnected');
    expect(task().summary).toMatch(/reconnecting/);
    expect(errors()).toEqual([]);
    // Still out of reach after a few tries: still quiet.
    await wait(300);
    expect(task().status).toBe('disconnected');
    expect(errors()).toEqual([]);
    // Back: connected again, and the cut-short turn goes on (a hidden "carry on", not the instruction again).
    probe = { state: 'ok' };
    // (The "carry on" itself is hidden from the conversation; the agent's answer to it is not.)
    const answered = () => {
      const items = ws.transcript(t.taskId);
      const back = items.findIndex((i) => i.role === 'system' && i.text === 'Reconnected to devbox.');
      return back >= 0 && items.slice(back).some((i) => i.role === 'assistant' && i.text.includes('connection to this machine was lost'));
    };
    await until(answered, 5000);
    await until(() => task().status === 'done', 5000);
    expect(ws.transcript(t.taskId).filter((i) => i.role === 'user' && i.text === 'Next step.')).toHaveLength(1);
    expect(ws.transcript(t.taskId).some((i) => i.role === 'system' && i.text === 'Reconnected to devbox.')).toBe(true);
    expect(errors()).toEqual([]);
  }, 20_000);

  it('an idle agent just reconnects, nothing sent', async () => {
    probe = { state: 'ok' };
    const { ws, t, task, errors, drop } = await setup();
    const before = ws.transcript(t.taskId).filter((i) => i.role === 'user').length;
    drop();
    await until(() => task().summary === 'Reconnected.');
    expect(task().status).not.toBe('failed');
    expect(ws.transcript(t.taskId).filter((i) => i.role === 'user')).toHaveLength(before);
    expect(errors()).toEqual([]);
  });

  it('a host that needs a login gets one note, not one per try', async () => {
    probe = { state: 'needs_login', error: 'SSH to devbox needs a login or an unlocked key.' };
    const { ws, task, errors, drop } = await setup();
    drop();
    await until(() => errors().length === 1);
    await wait(300);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].headline).toMatch(/Cannot reconnect to devbox/);
    expect(task().status).toBe('disconnected');
    void ws;
  });

  it('stops trying after a while without an answer, quietly; waking up starts again', async () => {
    probe = { state: 'unreachable' };
    const { ws, task, errors, drop } = await setup(5, 250);
    drop();
    await until(() => /Cannot reach devbox/.test(task().summary));
    expect(task().status).toBe('disconnected');
    expect(errors()).toEqual([]);
    // No more tries meanwhile: the summary stays.
    await wait(300);
    expect(task().summary).toMatch(/Cannot reach devbox/);
    // The computer wakes and the machine is back: reconnected.
    probe = { state: 'ok' };
    ws.reconnectNow();
    await until(() => task().summary === 'Reconnected.', 8000);
  }, 15_000);

  it('after a restart, earlier connection errors leave the waiting list', async () => {
    probe = { state: 'unreachable' };
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const ws1 = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), 5) } });
    ws1.updateSettings({ remoteHosts: ['devbox'] });
    const project = await ws1.addProject(repo(), 'shop');
    const t = await ws1.createTask({ projectId: project.projectId, provider: 'mock', title: 'remote', isolate: false, mockScript: 'work', instruction: 'Start.' });
    await until(() => ws1.snapshot().tasks.find((x) => x.taskId === t.taskId)!.status === 'done');
    // As an older version left it: failed, with an error about the connection waiting on the user.
    const data = (ws1 as unknown as { store: { data: { tasks: Array<Record<string, unknown>>; attention: Array<Record<string, unknown>> } } }).store.data;
    Object.assign(data.tasks.find((x) => x.taskId === t.taskId)!, { host: 'devbox', status: 'failed', lastError: LOST, summary: `Session failed: ${LOST}` });
    data.attention.push({ id: 'a-old', taskId: t.taskId, kind: 'error', state: 'open', headline: `Session failed: ${LOST}`, details: LOST, createdAt: new Date().toISOString() });
    await ws1.shutdown();
    const ws2 = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), 5) } });
    opened.push(ws2);
    const after = ws2.snapshot();
    // (Its report from the first turn may stay; that is not waiting on anyone.)
    expect(after.attention.filter((a) => a.taskId === t.taskId && a.state === 'open' && a.kind !== 'completion')).toEqual([]);
    expect(after.tasks.find((x) => x.taskId === t.taskId)!.status).toBe('disconnected');
  });

  it('stopping an agent ends its waiting', async () => {
    probe = { state: 'unreachable' };
    const { ws, t, task, drop } = await setup();
    drop();
    await ws.stop(t.taskId);
    probe = { state: 'ok' };
    await wait(300);
    expect(task().summary).not.toMatch(/Reconnected/);
  });
});
