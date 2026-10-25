// Opt-in: Claude Code and Codex on an SSH host through the app (tiny prompts, a scratch
// repo on the host).
//   AMW_E2E_SSH_HOST=<alias from ~/.ssh/config> npm run test:e2e -- ssh-remote
// The host needs both CLIs installed and signed in, and your key in the SSH agent.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const host = process.env.AMW_E2E_SSH_HOST ?? '';
const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'amw-ssh-'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
const scratch = `amw-e2e-${Date.now()}`;

const remote = (cmd: string) => execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', '--', host, cmd], { encoding: 'utf8', timeout: 60_000 }).trim();
/** Agent processes on the host (other clients' are counted in the baseline). */
const agentProcesses = () => Number(remote('pgrep -u "$USER" -fc "codex app-server|claude --output-format stream-json" || true') || 0);

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

type Task = { taskId: string; alias: string; provider: string; status: string; host?: string; cwd: string; worktree?: unknown; sharedCwdWarning?: string };
type Snap = { tasks: Task[]; remoteHosts: Array<{ host: string; ssh: string; capabilities: Array<{ provider: string; available: boolean; auth?: { loggedIn: boolean } }> }> };
const snapshot = async (page: Page) => (await invoke(page, 'workspace:snapshot', {})) as Snap;
const lastReply = async (page: Page, taskId: string) => ((await invoke(page, 'transcript:get', { taskId })) as Array<{ role: string; text: string }>).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
const transcript = async (page: Page, taskId: string) => ((await invoke(page, 'transcript:get', { taskId })) as Array<{ text: string }>).map((i) => i.text).join('\n');

afterAll(async () => {
  await app?.close().catch(() => {});
  if (host) remote(`rm -rf ~/${scratch}`);
});

describe.runIf(host)('Claude Code and Codex on an SSH host', () => {
  it('enables a host, runs and resumes both agents there, imports remote sessions, leaves no process behind', async () => {
    const home = remote(`mkdir -p ~/${scratch} && cd ~/${scratch} && git init -q && echo hi > README.md && git add . && git -c user.email=a@b -c user.name=e2e commit -qm init && echo "$HOME"`).split('\n').pop()!;
    const hostname = remote('hostname');
    const baseline = agentProcesses();

    let page = await launch();
    expect(((await invoke(page, 'ssh:hosts', {})) as Array<{ host: string }>).map((h) => h.host)).toContain(host);
    // Remote folders need the host turned on in Settings first.
    await expect(invoke(page, 'project:add', { rootPath: `~/${scratch}`, host })).rejects.toThrow(/not enabled/);
    await invoke(page, 'ssh:setEnabled', { host, enabled: true });
    await expect.poll(async () => (await snapshot(page)).remoteHosts.find((h) => h.host === host)?.ssh, { timeout: 60_000 }).toBe('ok');
    const status = (await snapshot(page)).remoteHosts.find((h) => h.host === host)!;
    for (const p of ['claude', 'codex']) expect(status.capabilities.find((c) => c.provider === p), p).toMatchObject({ available: true, auth: { loggedIn: true } });

    await page.getByRole('button', { name: /Settings/ }).first().click();
    await page.locator(`[data-testid="host-${host}"]`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'ssh-01-settings.png') });
    await page.keyboard.press('Escape');

    const project = (await invoke(page, 'project:add', { rootPath: `~/${scratch}`, host })) as { projectId: string; host?: string; rootPath: string; isGitRepo: boolean };
    expect(project).toMatchObject({ host, rootPath: `${home}/${scratch}`, isGitRepo: true });

    const ask = 'Run the command `hostname`, then reply with one short sentence that contains its output and the word READY.';
    for (const provider of ['claude', 'codex']) await invoke(page, 'task:create', { projectId: project.projectId, provider, title: `Remote ${provider}`, isolate: true, instruction: ask });
    const tasks = (await snapshot(page)).tasks;
    for (const task of tasks) {
      await expect.poll(() => lastReply(page, task.taskId), { timeout: 240_000 }).toMatch(/READY/);
      expect(await lastReply(page, task.taskId), task.provider).toContain(hostname);
      expect(task).toMatchObject({ host, cwd: `${home}/${scratch}` });
      expect(task.worktree).toBeUndefined();
    }
    await page.screenshot({ path: join(shots, 'ssh-02-remote-tasks.png') });

    // Restart: each native session on the host resumes with its context.
    await app!.close();
    page = await launch();
    await expect.poll(async () => (await snapshot(page)).remoteHosts.find((h) => h.host === host)?.ssh, { timeout: 60_000 }).toBe('ok');
    for (const task of tasks) {
      await invoke(page, 'task:send', { taskId: task.taskId, text: 'What hostname did you report? Reply with only the hostname.', via: 'text' });
      await expect.poll(() => transcript(page, task.taskId), { timeout: 240_000 }).toMatch(new RegExp(`Resumed native ${task.provider} session`));
      await expect.poll(() => lastReply(page, task.taskId), { timeout: 240_000 }).toMatch(new RegExp(`^\\W*${hostname}\\W*$`, 'i'));
    }

    // Sessions saved on the host, from both CLIs, can be listed and imported with their history.
    const found = (await invoke(page, 'sessions:discoverHost', { host })) as Array<{ provider: string; nativeSessionId: string; cwd: string; host?: string; title: string }>;
    expect(found.every((s) => s.host === host)).toBe(true);
    for (const provider of ['claude', 'codex']) {
      // Sessions from earlier runs of this test point at deleted scratch folders.
      const s = found.find((x) => x.provider === provider && !x.cwd.includes('/amw-e2e-'));
      if (!s) throw new Error(`No ${provider} session on ${host} outside this test's scratch folders to import.`);
      const imported = (await invoke(page, 'task:importSession', { provider, nativeSessionId: s.nativeSessionId, cwd: s.cwd, host, title: s.title.slice(0, 500) || s.nativeSessionId })) as { taskId: string; host?: string };
      expect(imported.host).toBe(host);
      await expect.poll(async () => ((await invoke(page, 'transcript:get', { taskId: imported.taskId })) as unknown[]).length, { timeout: 120_000 }).toBeGreaterThan(0);
      // Removing the task only forgets it here; the session stays on the host.
      await invoke(page, 'task:remove', { taskId: imported.taskId });
    }

    await page.getByRole('button', { name: /Continue a session/ }).click();
    await page.getByTestId('session-host').selectOption('all');
    await expect.poll(() => page.locator('[data-testid="session-row"]').filter({ hasText: `${host}:` }).count(), { timeout: 120_000 }).toBeGreaterThan(0);
    await page.locator('.modal').screenshot({ path: join(shots, 'ssh-03-import.png') });
    await page.keyboard.press('Escape');

    for (const task of tasks) await invoke(page, 'task:stop', { taskId: task.taskId });
    await app!.close();
    app = undefined;
    await expect.poll(agentProcesses, { timeout: 30_000, interval: 2000 }).toBe(baseline);
  });
});
