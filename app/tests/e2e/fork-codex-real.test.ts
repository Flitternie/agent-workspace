// Opt-in: forks a real Codex conversation through the app (tiny prompts, app-server thread/fork),
// from the Fork dialog, with the user's own signed-in Codex CLI.
//   AMW_E2E_REAL=1 npm run test:e2e -- fork-codex-real
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/main/providers/codex';
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

describe.runIf(enabled)('fork a real Codex conversation', () => {
  it('a fork from before a prompt forgets that prompt; the original is unchanged', async () => {
    mkdirSync(join(appDir, '.cache'), { recursive: true });
    const root = mkdtempSync(join(appDir, '.cache', 'fork-codex-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'README.md'), '# fork e2e\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: root });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-fork-codex-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
    await page.waitForSelector('.app');
    // Not about the first-run guide: skip it, as a returning user has.
    await page.evaluate(() => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke('settings:update', { onboarding: { dismissed: true } }));

    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    const task = async (id: string) => (await snap()).tasks.find((t) => t.taskId === id)!;
    const settled = (id: string) =>
      expect
        .poll(async () => (await task(id)).status, { timeout: 180_000, interval: 1000 })
        .toMatch(/done|idle|waiting_for_user/)
        .catch(async (e) => {
          // What happened instead: the agent's summary and conversation.
          const t = await task(id);
          console.log(`[${t.alias} ${t.status}] ${t.summary ?? ''}`);
          console.log((await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: id })).map((i) => `[${i.role}] ${i.text}`.slice(0, 400)).join('\n'));
          throw e;
        });
    const lastReply = async (id: string) => (await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: id })).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';

    const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: 'fork-e2e' });
    const a = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider: 'codex', title: 'Codewords', isolate: true, instruction: 'Remember the codeword KIWI-3. Reply with only: ok' });
    await settled(a.taskId);
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'Forget that; the codeword is now PLUM-9. Reply with only: ok', via: 'text' });
    await settled(a.taskId);

    await page.locator(`[data-testid="agent-card"][data-alias="${a.alias}"]`).getByRole('button', { name: 'Open' }).click();
    await page.getByTestId('fork-task').click();
    await page.getByTestId('fork-points').getByText(/PLUM-9/).click();
    await page.screenshot({ path: join(shots, 'fork-codex-01-dialog.png') });
    await page.getByTestId('fork-confirm').click();

    const fork = await expect
      .poll(async () => (await snap()).tasks.find((t) => t.forkedFrom?.taskId === a.taskId), { timeout: 30_000 })
      .toBeTruthy()
      .then(async () => (await snap()).tasks.find((t) => t.forkedFrom?.taskId === a.taskId)!);
    // The message it was forked back before waits in its reply box; this test asks something else instead.
    await invoke(page, 'task:send', { taskId: fork.taskId, text: 'What is the codeword? Reply with only the codeword.', via: 'text' });
    expect(fork.cwd).not.toBe(a.cwd);
    await settled(fork.taskId);
    expect(await lastReply(fork.taskId)).toMatch(/KIWI-3/);
    expect(await lastReply(fork.taskId)).not.toMatch(/PLUM-9/);
    await page.screenshot({ path: join(shots, 'fork-codex-02-forked.png') });
    // The forked thread is a new Codex thread recorded in the fork's worktree.
    const forkThread = (await snap()).sessions.find((s) => s.localId === fork.sessionLocalId)!.nativeSessionId!;
    const origThread = (await snap()).sessions.find((s) => s.localId === a.sessionLocalId)!.nativeSessionId!;
    expect(forkThread).not.toBe(origThread);
    expect((await new CodexAdapter().discoverSessions({ cwd: fork.cwd })).map((s) => s.nativeSessionId)).toContain(forkThread);

    // The original still has its whole conversation.
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'What is the codeword? Reply with only the codeword.', via: 'text' });
    await settled(a.taskId);
    expect(await lastReply(a.taskId)).toMatch(/PLUM-9/);
  }, 600_000);
});
