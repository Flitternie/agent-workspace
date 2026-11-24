// Opt-in: a Claude Code agent on an SSH host keeps working through a dropped connection (the local ssh
// killed outright mid-turn, as when the laptop sleeps): the turn finishes, its answer arrives, and the
// conversation goes on. Works in a scratch folder on the host, removed afterwards with its session.
//   AMW_E2E_SSH_HOST=<alias from ~/.ssh/config> npm run test:e2e -- ssh-drop
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task, TranscriptItem, WorkspaceSnapshot } from '../../src/shared/types';

const host = process.env.AMW_E2E_SSH_HOST ?? '';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
const scratch = `amw-drop-e2e-${Date.now().toString(36)}`;
const remote = (cmd: string) => execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', '--', host, cmd], { encoding: 'utf8', timeout: 60_000 }).trim();
/** This app's connections to its detached CLIs (the attachment script names the run folder). */
const attachments = () => {
  try {
    return execFileSync('pgrep', ['-f', `agent-workspace/run.*tail -c`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
let app: ElectronApplication | undefined;

afterAll(async () => {
  await app?.close().catch(() => {});
  if (!host) return;
  remote(`rm -rf ~/${scratch} ~/.claude/projects/*${scratch}`);
});

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

describe.runIf(host)('an agent on an SSH host through a dropped connection', () => {
  it('Claude Code finishes the turn it was in, and the conversation goes on', async () => {
    remote(`mkdir -p ~/${scratch} && cd ~/${scratch} && git init -q && echo hi > README.md`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-sshdrop-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
    const page = await app.firstWindow();
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true }, permissionMode: 'auto' });
    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    await invoke(page, 'ssh:setEnabled', { host, enabled: true });
    await expect.poll(async () => ((await snap()) as unknown as { remoteHosts: Array<{ host: string; ssh: string }> }).remoteHosts.find((h) => h.host === host)?.ssh, { timeout: 60_000 }).toBe('ok');
    const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: `~/${scratch}`, host });
    const t = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider: 'claude', title: `Drop on ${host}`, isolate: false });
    const status = async () => (await snap()).tasks.find((x) => x.taskId === t.taskId)!.status;
    const reply = async () => (await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: t.taskId })).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';

    const r = await invoke<{ ok: boolean; error?: string }>(page, 'task:send', { taskId: t.taskId, text: 'Run exactly this shell command with the Bash tool, in the foreground (not in the background), and wait for it: `python3 -c "import time; time.sleep(25); print(\\"OTTER-\\" + str(40 + 43))"`. Then reply with only its output.', via: 'text' });
    expect(r).toMatchObject({ ok: true });
    // Mid-command: the connection goes (every attachment of this app killed outright).
    try {
      await expect.poll(async () => (await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: t.taskId })).some((i) => i.role === 'tool' && i.toolStatus === 'running'), { timeout: 120_000, interval: 500 }).toBe(true);
    } catch (e) {
      const task = (await snap()).tasks.find((x) => x.taskId === t.taskId)!;
      console.log('[diag] status', task.status, 'summary', task.summary);
      console.log('[diag] transcript', JSON.stringify((await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: t.taskId })).map((i) => [i.role, i.toolStatus, i.text.slice(0, 160)])));
      throw e;
    }
    await new Promise((res) => setTimeout(res, 4000));
    const killed = attachments();
    expect(killed.length).toBeGreaterThan(0);
    execFileSync('kill', ['-9', ...killed]);
    // It comes back on its own and the turn ends with the command's output.
    await expect.poll(status, { timeout: 240_000, interval: 1000 }).toMatch(/done|idle|waiting_for_user/);
    console.log(`[claude on ${host}] reply after the drop:`, await reply());
    expect(await reply()).toContain('OTTER-83');
    expect(attachments().some((pid) => !killed.includes(pid))).toBe(true);
    // The same CLI goes on with the conversation.
    await invoke(page, 'task:send', { taskId: t.taskId, text: 'Reply with only the word KESTREL. Do not use any tools.', via: 'text' });
    await expect.poll(reply, { timeout: 240_000, interval: 1000 }).toContain('KESTREL');

    // Quitting stops it on the host: nothing of this app left running there.
    await app.close();
    app = undefined;
    const left = () => remote(`ps -u "$(id -u)" -o pid=,ppid=,etime=,args= | grep -F "agent-workspace/run" | grep -v grep | cut -c1-300 || true`);
    try {
      await expect.poll(left, { timeout: 10_000, interval: 1000 }).toBe('');
    } catch (e) {
      console.log('[diag] left on the host:\n' + left());
      throw e;
    }
  }, 600_000);
});
