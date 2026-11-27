// An ACP agent (the fake one) in the workspace, on an SSH "host" (a local shell): it resumes its
// conversation there with session/load, and when the connection is gone for good the workspace waits
// quietly and reconnects by itself once the host answers, as it does for Codex.
import { execFileSync, spawnSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteHostStatus } from '../../src/shared/types';
import type { RemoteRunner } from '../../src/main/util/detached';

let probe: { state: RemoteHostStatus['ssh']; error?: string } = { state: 'ok' };
vi.mock('../../src/main/util/ssh', async (orig) => ({
  ...(await orig<typeof import('../../src/main/util/ssh')>()),
  sshHosts: () => ['devbox'],
  sshProbe: async () => probe,
  loadKeychainKeys: async () => {},
}));
const { AcpAdapter } = await import('../../src/main/providers/acp');
const { acpAgent } = await import('../../src/shared/acp-agents');
const { Workspace } = await import('../../src/main/workspace');

const FAKE = join(__dirname, '../fixtures/fake-acp-agent.mjs');
const opened: InstanceType<typeof Workspace>[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.shutdown();
  // A run the transport gave up on stays on the "host" until its lease ends (hours): stopped here.
  for (const h of homes.splice(0)) {
    spawnSync('sh', ['-c', `for f in "${h}"/.cache/agent-workspace/run/*/pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done; true`]);
    spawnSync('pkill', ['-f', h]);
  }
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

it('runs on the host, resumes there, and reconnects by itself after the connection is lost', async () => {
  const home = mkdtempSync(join(tmpdir(), 'amw-acpws-home-'));
  homes.push(home);
  process.env.FAKE_ACP_DIR = join(home, 'store');
  delete process.env.FAKE_ACP_LOG;
  // The CLI as installed on the host (its installer's folder), for the host check.
  mkdirSync(join(home, '.opencode/bin'), { recursive: true });
  writeFileSync(join(home, '.opencode/bin/opencode'), '#!/bin/sh\necho "opencode v2.4.2"\n');
  chmodSync(join(home, '.opencode/bin/opencode'), 0o755);
  const env = { ...process.env, HOME: home };
  let offline = false;
  const attachments: ChildProcessWithoutNullStreams[] = [];
  const down = `echo "Connection closed by remote host" >&2; exit 255`;
  const runner: RemoteRunner = {
    spawn(command) {
      const p = spawn('sh', ['-c', offline ? down : command], { env, stdio: 'pipe' });
      attachments.push(p);
      return p;
    },
    run(command) {
      return new Promise((resolve) => {
        const p = spawn('sh', ['-c', offline ? down : command], { env, stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (d) => (stdout += d));
        p.stderr.on('data', (d) => (stderr += d));
        p.on('close', (code) => resolve({ code: code ?? 255, stdout, stderr }));
      });
    },
  };
  const adapter = new AcpAdapter(acpAgent('opencode')!, { command: ['node', FAKE], runner: () => runner, backoff: [100], giveUpMs: 600 });
  const dataDir = mkdtempSync(join(tmpdir(), 'amw-acpws-data-'));
  const ws = new Workspace({ dataDir, adapters: { opencode: adapter }, reconnectMs: [150] });
  opened.push(ws);
  ws.updateSettings({ remoteHosts: ['devbox'], permissionMode: 'ask' });
  await ws.refreshCapabilities({ localOnly: true });
  expect(ws.snapshot().capabilities.find((c) => c.provider === 'opencode')).toMatchObject({ available: true, importHistory: true, sideQuestions: true, fork: true });
  expect((await ws.checkHost('devbox')).capabilities.find((c) => c.provider === 'opencode')).toMatchObject({ available: true, version: 'opencode v2.4.2' });

  const repo = mkdtempSync(join(tmpdir(), 'amw-acpws-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# shop\n');
  const project = await ws.addProject(repo, 'shop');
  const t = await ws.createTask({ projectId: project.projectId, provider: 'opencode', title: 'remote', isolate: false, instruction: 'hello' });
  const task = () => ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!;
  const said = (text: string) => ws.transcript(t.taskId).some((i) => i.role === 'assistant' && i.text === text);
  await until(() => said('Echo: hello') && task().status === 'done', 10_000, 'first reply');
  expect(task().activeModel).toBe('fake-small');

  // From here it runs on the host (stands in for an agent created there): it resumes its conversation there.
  await ws.stop(t.taskId);
  (ws as unknown as { store: { data: { tasks: Array<{ taskId: string; host?: string }> } } }).store.data.tasks.find((x) => x.taskId === t.taskId)!.host = 'devbox';
  await ws.send(t.taskId, 'second', 'text');
  await until(() => said('Echo: second') && task().status === 'done', 15_000, 'reply on the host');
  expect(ws.transcript(t.taskId).filter((i) => i.role === 'user' && i.text === 'hello')).toHaveLength(1);

  // The connection goes for good: the transport gives up, the workspace waits without an error to dismiss.
  probe = { state: 'unreachable', error: 'Network is unreachable' };
  offline = true;
  attachments.at(-1)!.stdin.end();
  await until(() => task().status === 'disconnected', 10_000, 'disconnected');
  expect(task().summary).toMatch(/reconnecting/);
  expect(ws.snapshot().attention.filter((a) => a.taskId === t.taskId && a.state === 'open' && a.kind === 'error')).toEqual([]);

  // Back: reconnected by itself (the conversation reloaded), and it answers again.
  offline = false;
  probe = { state: 'ok' };
  await until(() => ws.transcript(t.taskId).some((i) => i.role === 'system' && i.text === 'Reconnected to devbox.'), 15_000, 'reconnected');
  await ws.send(t.taskId, 'third', 'text');
  await until(() => said('Echo: third'), 15_000, 'reply after reconnecting');
}, 60_000);

it('lists an agent’s models before its first message (its session started quietly for it)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'amw-acpws-home-'));
  homes.push(home);
  process.env.FAKE_ACP_DIR = join(home, 'store');
  const adapter = new AcpAdapter(acpAgent('opencode')!, { command: ['node', FAKE] });
  const ws = new Workspace({ dataDir: mkdtempSync(join(tmpdir(), 'amw-acpws-data-')), adapters: { opencode: adapter } });
  opened.push(ws);
  const repo = mkdtempSync(join(tmpdir(), 'amw-acpws-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const project = await ws.addProject(repo, 'shop');
  const t = await ws.createTask({ projectId: project.projectId, provider: 'opencode', title: 'models', isolate: false });
  const before = ws.transcript(t.taskId).filter((i) => i.role === 'user').length;
  const models = await ws.listModels(t.taskId);
  expect(models.length).toBeGreaterThan(0);
  // Nothing was sent to it.
  expect(ws.transcript(t.taskId).filter((i) => i.role === 'user')).toHaveLength(before);
}, 30_000);
