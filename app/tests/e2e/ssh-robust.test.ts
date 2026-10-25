// Opt-in: how Claude Code and Codex on an SSH host behave when things go wrong
// (tiny prompts, a scratch repo on the host).
//   AMW_E2E_SSH_HOST=<alias from ~/.ssh/config> npm run test:e2e -- ssh-robust
// Native approval (deny), steer and interrupt over SSH, the connection dropping mid-session
// (next message resumes the same native session), and the app being killed mid-turn
// (nothing keeps running on the host or here).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const host = process.env.AMW_E2E_SSH_HOST ?? '';
const appDir = resolve(__dirname, '../..');
mkdirSync(join(appDir, 'test-results'), { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'amw-ssh-robust-'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
const scratch = `amw-e2e-${Date.now()}`;
const controlPath = join('/tmp', `amw-ssh-${userInfo().uid}`, '%C');

const remote = (cmd: string) => execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', '--', host, cmd], { encoding: 'utf8', timeout: 60_000 }).trim();
const agentProcesses = () => Number(remote('pgrep -u "$USER" -fc "codex app-server|claude --output-format stream-json" || true') || 0);
/** The app's SSH clients for this host (not the shared control master). */
const localSsh = () => {
  try {
    return execFileSync('pgrep', ['-f', `ssh -T .*ControlPath=${controlPath.replace('%C', '')}.* -- ${host} exec`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};
/** Ends the shared connection, as a network drop or sleep would. */
const dropConnection = () => execFileSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', '--', host], { stdio: 'ignore' });

async function launch(): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
  app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.waitForSelector('.app');
  return page;
}

const invoke = (page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const);

type Attention = { id: string; taskId: string; kind: string; state: string; options?: Array<{ id: string; label: string }> };
type Snap = { tasks: Array<{ taskId: string; provider: string; status: string }>; attention: Attention[]; remoteHosts: Array<{ host: string; ssh: string }> };
const snapshot = async (page: Page) => (await invoke(page, 'workspace:snapshot', {})) as Snap;
const statusOf = async (page: Page, taskId: string) => (await snapshot(page)).tasks.find((t) => t.taskId === taskId)!.status;
const lastReply = async (page: Page, taskId: string) => ((await invoke(page, 'transcript:get', { taskId })) as Array<{ role: string; text: string }>).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
const send = async (page: Page, taskId: string, text: string, interrupt = false) =>
  (await invoke(page, 'task:send', { taskId, text, via: 'text', interrupt })) as { ok: boolean; delivery?: string; error?: string };

afterAll(async () => {
  await app?.close().catch(() => {});
  if (host) remote(`rm -rf ~/${scratch} ~/${scratch}-outside.txt`);
});

describe.runIf(host)('Claude Code and Codex on an SSH host, when things go wrong', () => {
  it('approval, steer, interrupt, a dropped connection and a killed app', async () => {
    remote(`mkdir -p ~/${scratch} && cd ~/${scratch} && git init -q && echo hi > README.md`);
    const baseline = agentProcesses();
    const outside = `~/${scratch}-outside.txt`;

    let page = await launch();
    await invoke(page, 'ssh:setEnabled', { host, enabled: true });
    await expect.poll(async () => (await snapshot(page)).remoteHosts.find((h) => h.host === host)?.ssh, { timeout: 60_000 }).toBe('ok');
    const project = (await invoke(page, 'project:add', { rootPath: `~/${scratch}`, host })) as { projectId: string };
    for (const provider of ['claude', 'codex'])
      await invoke(page, 'task:create', { projectId: project.projectId, provider, title: `Robust ${provider}`, isolate: false, instruction: 'Remember the codeword PLUM-3. Reply with only the word READY. Do not run commands.' });
    const tasks = (await snapshot(page)).tasks;
    for (const t of tasks) await expect.poll(() => lastReply(page, t.taskId), { timeout: 240_000 }).toMatch(/READY/);

    // Native approval over SSH: in "ask" mode a write outside the folder waits; deny it.
    for (const t of tasks) {
      await invoke(page, 'task:setPermissionMode', { taskId: t.taskId, mode: 'ask' });
      await send(page, t.taskId, `Use your shell tool to run exactly: touch ${outside} . If it is denied, reply DENIED and do not retry.`);
      const open = async () => (await snapshot(page)).attention.find((a) => a.taskId === t.taskId && a.kind === 'approval' && a.state === 'open');
      await expect.poll(open, { timeout: 180_000 }).toBeTruthy();
      const a = (await open())!;
      const deny = a.options?.find((o) => /deny|decline|reject|no\b/i.test(o.label)) ?? a.options?.at(-1);
      await invoke(page, 'attention:respond', { attentionId: a.id, decision: deny!.id });
      await expect.poll(() => lastReply(page, t.taskId), { timeout: 180_000 }).toMatch(/DENIED/i);
      expect(remote(`test -e ${outside} && echo yes || echo no`), t.provider).toBe('no');
      await invoke(page, 'task:setPermissionMode', { taskId: t.taskId, mode: 'auto' });
    }

    // Steer, then interrupt, a running turn on the host.
    const LONG = 'Run these shell commands one at a time, each as its own tool call: `sleep 6 && echo STEP1`, then `sleep 6 && echo STEP2`, then `sleep 6 && echo STEP3`. Then reply with the outputs.';
    for (const t of tasks) {
      await send(page, t.taskId, LONG);
      await expect.poll(() => statusOf(page, t.taskId), { timeout: 60_000 }).toBe('running');
      await page.waitForTimeout(4000);
      expect((await send(page, t.taskId, 'Change of plan: skip any remaining sleep steps and end your reply with the word BANANA.')).delivery, t.provider).toBe('steer');
      await expect.poll(() => lastReply(page, t.taskId), { timeout: 240_000 }).toMatch(/BANANA/);
      await expect.poll(() => statusOf(page, t.taskId), { timeout: 30_000 }).not.toBe('running');

      await send(page, t.taskId, LONG);
      await expect.poll(() => statusOf(page, t.taskId), { timeout: 60_000 }).toBe('running');
      await page.waitForTimeout(3000);
      expect((await send(page, t.taskId, 'Reply with only the word KIWI.', true)).delivery, t.provider).toBe('interrupt');
      await expect.poll(() => lastReply(page, t.taskId), { timeout: 180_000 }).toMatch(/KIWI/);
      await expect.poll(() => statusOf(page, t.taskId), { timeout: 30_000 }).not.toBe('running');
    }

    // The connection drops: both sessions end; the next message reconnects and resumes the same session.
    dropConnection();
    for (const t of tasks) await expect.poll(() => statusOf(page, t.taskId), { timeout: 60_000 }).toMatch(/disconnected|failed/);
    await expect.poll(agentProcesses, { timeout: 60_000, interval: 2000 }).toBe(baseline);
    for (const t of tasks) {
      const r = await send(page, t.taskId, 'What codeword did I ask you to remember? Reply with only the codeword.');
      expect(r.ok, `${t.provider}: ${r.error}`).toBe(true);
      await expect.poll(() => lastReply(page, t.taskId), { timeout: 240_000 }).toMatch(/PLUM-3/);
    }

    // The app is killed mid-turn: nothing is left running on the host, and no SSH client here.
    for (const t of tasks) await send(page, t.taskId, 'Run the shell command `sleep 25 && echo DONE`, then reply DONE.');
    for (const t of tasks) await expect.poll(() => statusOf(page, t.taskId), { timeout: 60_000 }).toBe('running');
    await page.waitForTimeout(3000);
    app!.process().kill('SIGKILL');
    app = undefined;
    await expect.poll(agentProcesses, { timeout: 90_000, interval: 3000 }).toBe(baseline);
    await expect.poll(localSsh, { timeout: 30_000, interval: 2000 }).toBe(0);

    // And it comes back: relaunch, resume.
    page = await launch();
    await expect.poll(async () => (await snapshot(page)).remoteHosts.find((h) => h.host === host)?.ssh, { timeout: 60_000 }).toBe('ok');
    for (const t of tasks) {
      await send(page, t.taskId, 'Reply with only the codeword from earlier.');
      await expect.poll(() => lastReply(page, t.taskId), { timeout: 240_000 }).toMatch(/PLUM-3/);
      await invoke(page, 'task:stop', { taskId: t.taskId });
    }
    await app!.close();
    app = undefined;
    await expect.poll(agentProcesses, { timeout: 30_000, interval: 2000 }).toBe(baseline);
  }, 1_800_000);
});
