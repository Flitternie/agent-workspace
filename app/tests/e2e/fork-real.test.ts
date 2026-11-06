// Opt-in: forks a real Claude Code conversation through the app (tiny prompts), from the Fork
// dialog and through the main agent's fork_agent.
//   AMW_E2E_REAL=1 npm run test:e2e -- fork-real
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task, TranscriptItem, WorkspaceSnapshot } from '../../src/shared/types';

const enabled = process.env.AMW_E2E_REAL === '1';
const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;

afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

describe.runIf(enabled)('fork a real Claude Code conversation', () => {
  it('a fork from before a prompt forgets that prompt; the original is unchanged', async () => {
    mkdirSync(join(appDir, '.cache'), { recursive: true });
    const root = mkdtempSync(join(appDir, '.cache', 'fork-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'README.md'), '# fork e2e\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: root });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-fork-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
    await page.waitForSelector('.app');

    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    const task = async (id: string) => (await snap()).tasks.find((t) => t.taskId === id)!;
    const settled = (id: string) => expect.poll(async () => (await task(id)).status, { timeout: 120_000, interval: 1000 }).toMatch(/done|idle|waiting_for_user/);
    const lastReply = async (id: string) => (await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: id })).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';

    const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: 'fork-e2e' });
    const a = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider: 'claude', title: 'Codewords', isolate: true, instruction: 'Remember the codeword KIWI-3. Reply with only: ok' });
    await settled(a.taskId);
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'Forget that; the codeword is now PLUM-9. Reply with only: ok', via: 'text' });
    await settled(a.taskId);

    await page.locator(`[data-testid="agent-card"][data-alias="${a.alias}"]`).getByRole('button', { name: 'Open' }).click();
    await page.getByTestId('fork-task').click();
    await page.getByTestId('fork-points').getByText(/PLUM-9/).click();
    await page.getByTestId('fork-instruction').fill('What is the codeword? Reply with only the codeword.');
    await page.screenshot({ path: join(shots, 'fork-01-dialog.png') });
    await page.getByTestId('fork-confirm').click();

    const fork = await expect
      .poll(async () => (await snap()).tasks.find((t) => t.forkedFrom?.taskId === a.taskId), { timeout: 30_000 })
      .toBeTruthy()
      .then(async () => (await snap()).tasks.find((t) => t.forkedFrom?.taskId === a.taskId)!);
    expect(fork.cwd).not.toBe(a.cwd);
    await settled(fork.taskId);
    expect(await lastReply(fork.taskId)).toMatch(/KIWI-3/);
    expect(await lastReply(fork.taskId)).not.toMatch(/PLUM-9/);
    await page.screenshot({ path: join(shots, 'fork-02-forked.png') });

    // The original still has its whole conversation.
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'What is the codeword? Reply with only the codeword.', via: 'text' });
    await settled(a.taskId);
    expect(await lastReply(a.taskId)).toMatch(/PLUM-9/);
  });

  it('the main agent branches off an agent: the fork has its context and its uncommitted files', async () => {
    mkdirSync(join(appDir, '.cache'), { recursive: true });
    const root = mkdtempSync(join(appDir, '.cache', 'fork-main-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'README.md'), '# fork e2e\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: root });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'claude', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-fork-main-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
    await page.waitForSelector('.app');

    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    const task = async (id: string) => (await snap()).tasks.find((t) => t.taskId === id)!;
    const settled = (id: string) => expect.poll(async () => (await task(id)).status, { timeout: 180_000, interval: 1000 }).toMatch(/done|idle|waiting_for_user/);
    const transcript = (id: string) => invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: id });
    const lastReply = async (id: string) => (await transcript(id)).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
    await expect.poll(async () => (await snap()).main?.provider, { timeout: 30_000 }).toBe('claude');

    const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: 'fork-main-e2e' });
    const a = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider: 'claude', title: 'Codewords', isolate: true, instruction: 'Remember the codeword KIWI-3. Reply with only: ok' });
    await settled(a.taskId);
    writeFileSync(join(a.cwd, 'notes.txt'), 'uncommitted notes');
    await invoke(page, 'settings:update', { permissionMode: 'edits' });
    // The user gave Alice more than the default; the main agent's fork must not inherit it.
    await invoke(page, 'task:setPermissionMode', { taskId: a.taskId, mode: 'auto' });

    // Not named (that would go straight to Alice): the main agent finds her and forks her.
    await page.getByTestId('dock-input').fill('Fork the agent working on the codewords task, and have the fork reply with only the codeword it was given. Use a fork, do not do it yourself.');
    await page.getByTestId('dock-input').press('Enter');
    const fork = await expect
      .poll(async () => (await snap()).tasks.find((t) => t.forkedFrom?.taskId === a.taskId), { timeout: 240_000 })
      .toBeTruthy()
      .then(async () => (await snap()).tasks.find((t) => t.forkedFrom?.taskId === a.taskId)!)
      .catch(async (e) => {
        const main = (await snap()).main;
        if (main) console.log((await transcript(main.taskId)).map((i) => `[${i.role}] ${i.text}`.slice(0, 300)).join('\n'));
        throw e;
      });
    expect(fork.cwd).not.toBe(a.cwd);
    expect(readFileSync(join(fork.cwd, 'notes.txt'), 'utf8')).toBe('uncommitted notes');
    expect(fork.permissionMode).not.toBe('auto');
    await settled(fork.taskId);
    expect(await lastReply(fork.taskId)).toMatch(/KIWI-3/);
    const main = (await snap()).main!;
    expect((await transcript(main.taskId)).some((i) => i.role === 'tool' && /fork_agent/.test(JSON.stringify(i)))).toBe(true);
    await page.screenshot({ path: join(shots, 'fork-03-main-agent.png') });
  }, 600_000);
});
