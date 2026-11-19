// Opt-in: a message with @path reaches real Claude Code and Codex agents, which read the file.
// With AMW_E2E_SSH_HOST also lists the files of a scratch folder on that host (no model calls there).
//   AMW_E2E_REAL=1 [AMW_E2E_SSH_HOST=<alias>] npm run test:e2e -- mentions-real
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Task, TranscriptItem, WorkspaceSnapshot } from '../../src/shared/types';

const enabled = process.env.AMW_E2E_REAL === '1';
const host = process.env.AMW_E2E_SSH_HOST ?? '';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
const scratch = `amw-at-e2e-${Date.now().toString(36)}`;
const remote = (cmd: string) => execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', '--', host, cmd], { encoding: 'utf8', timeout: 60_000 }).trim();

afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});
afterAll(() => {
  if (host && enabled) remote(`rm -rf ~/${scratch}`);
});

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

async function launch() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
  app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-atr-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
  const page = await app.firstWindow();
  await page.waitForSelector('.app');
  await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
  return page;
}

describe.runIf(enabled)('@-mentions with real agents', () => {
  for (const provider of ['claude', 'codex'] as const) {
    it(`${provider} reads a file mentioned with @`, async () => {
      mkdirSync(join(appDir, '.cache'), { recursive: true });
      const root = mkdtempSync(join(appDir, '.cache', 'at-repo-'));
      mkdirSync(join(root, 'notes'));
      writeFileSync(join(root, 'notes', 'secret.txt'), 'The codeword is MANGO-71.\n');
      execFileSync('git', ['init', '-q'], { cwd: root });
      const page = await launch();
      const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
      const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: 'at-e2e' });
      const t = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider, title: 'Read a file', isolate: false });
      expect((await invoke<Array<{ path: string }>>(page, 'files:search', { taskId: t.taskId, query: 'secr' }))[0].path).toBe('notes/secret.txt');
      await invoke(page, 'task:send', { taskId: t.taskId, text: 'What is the codeword in @notes/secret.txt? Reply with only the codeword.', via: 'text' });
      await expect.poll(async () => (await snap()).tasks.find((x) => x.taskId === t.taskId)!.status, { timeout: 180_000, interval: 1000 }).toMatch(/done|idle|waiting_for_user/);
      const items = await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: t.taskId });
      const reply = items.filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
      console.log(`[${provider}] reply: ${reply} | tools: ${items.filter((i) => i.role === 'tool').map((i) => i.tool?.title ?? i.toolLabel).join(', ') || 'none'}`);
      expect(reply).toContain('MANGO-71');
    }, 300_000);
  }

  it.runIf(host)('lists the files of an agent’s folder on an SSH host', async () => {
    remote(`mkdir -p ~/${scratch}/src/checkout ~/${scratch}/node_modules/x && cd ~/${scratch} && touch src/checkout/Button.tsx src/index.ts node_modules/x/Button.js README.md`);
    const page = await launch();
    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    await invoke(page, 'ssh:setEnabled', { host, enabled: true });
    await expect.poll(async () => ((await snap()) as unknown as { remoteHosts: Array<{ host: string; ssh: string }> }).remoteHosts.find((h) => h.host === host)?.ssh, { timeout: 60_000 }).toBe('ok');
    const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: `~/${scratch}`, host });
    const t = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider: 'claude', title: 'Files there', isolate: false });
    // Not a git repository: the walk, without node_modules.
    expect((await invoke<Array<{ path: string }>>(page, 'files:search', { taskId: t.taskId, query: 'button' })).map((m) => m.path)).toEqual(['src/checkout/Button.tsx']);
    expect((await invoke<Array<{ path: string }>>(page, 'files:search', { taskId: t.taskId, query: '' })).map((m) => m.path)).toEqual(['src/', 'README.md']);
    // ../ and ~/ browse folders there, one level at a time.
    expect((await invoke<Array<{ path: string }>>(page, 'files:search', { taskId: t.taskId, query: `../${scratch.slice(0, 10)}` })).map((m) => m.path)).toContain(`../${scratch}/`);
    expect((await invoke<Array<{ path: string }>>(page, 'files:search', { taskId: t.taskId, query: `~/${scratch}/src/` })).map((m) => m.path)).toEqual([`~/${scratch}/src/checkout/`, `~/${scratch}/src/index.ts`]);
  }, 120_000);
});
