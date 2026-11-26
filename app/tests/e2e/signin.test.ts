// A command waiting on a browser sign-in (`gh auth login` printing a device code and a link): the agent
// needs the user, shown with the link, the code and a button that opens the link in the browser; it
// settles by itself when the command finishes. Mock provider; links are logged, no browser opens.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task, WorkspaceSnapshot } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
afterAll(async () => {
  await app?.close().catch(() => {});
});
const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

function repo(): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-signin-'))), 'shop');
  mkdirSync(dir);
  writeFileSync(join(dir, 'README.md'), '# shop\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('browser sign-in a command waits on', () => {
  it('needs the user with the link and code, opens the link, and settles when the command ends', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-signin-data-'));
    const opened = join(dataDir, 'opened-links.txt');
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_OPEN_LINKS_LOG: opened },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo(), name: 'shop' });
    // The command waits 200 × 50 ms = 10 s for the sign-in, then succeeds.
    const task = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'GitHub', name: 'GitHub', mockScript: 'signin:200', instruction: 'Sign in to GitHub.', isolate: false });
    const signIn = async () => (await snap()).attention.find((a) => a.taskId === task.taskId && a.kind === 'signin');

    // On the Overview: the agent's card shows the request with its code.
    const card = page.locator(`[data-testid="agent-card"][data-alias="${task.alias}"]`);
    await expect.poll(async () => (await card.getByTestId('signin-code').textContent().catch(() => null)) ?? '', { timeout: 30_000 }).toBe('1A2B-3C4D');
    expect(await card.getByTestId('signin-url').textContent()).toBe('https://github.com/login/device');
    expect(await card.locator('.attention-headline').textContent()).toBe('Sign in at github.com');
    expect(await card.evaluate((e) => e.classList.contains('needs'))).toBe(true);
    await page.screenshot({ path: join(shots, 'signin-01-card.png') });

    // On the agent's own page: open the link (logged instead of a browser).
    await page.locator(`[data-testid="rail-item"][data-alias="${task.alias}"]`).click();
    const item = page.locator('.focus-attention [data-testid="signin"]');
    await item.waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(shots, 'signin-02-focus.png') });
    await page.locator('.focus-attention [data-testid="signin-open"]').click();
    await expect.poll(() => (existsSync(opened) ? readFileSync(opened, 'utf8') : '')).toBe('https://github.com/login/device\n');
    expect((await signIn())?.state).toBe('open');

    // The command finished (signed in): the request settles by itself and leaves the page.
    await expect.poll(async () => (await signIn())?.state, { timeout: 30_000 }).toBe('resolved');
    expect((await signIn())?.resolution).toBe('The command finished.');
    await expect.poll(() => page.locator('[data-testid="signin"]').count()).toBe(0);
    // Only an open request's link opens.
    await expect(invoke(page, 'attention:openLink', { attentionId: (await signIn())!.id })).rejects.toThrow(/no longer open/);
  });
});
