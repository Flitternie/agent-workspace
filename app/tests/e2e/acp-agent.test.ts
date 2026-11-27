// An agent on a CLI reached through ACP (OpenCode's registry entry, pointed at the fake ACP agent):
// created from the New agent dialog, a streamed reply, a tool call with its diff, a permission
// request answered on its card, and the CLI listed in Settings › Coding agents.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
const FAKE = join(appDir, 'tests/fixtures/fake-acp-agent.mjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
afterAll(async () => {
  await app?.close().catch(() => {});
});
const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;
const snapshot = (page: Page) => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});

describe('ACP agent', () => {
  it('creates an OpenCode agent, streams its reply, and answers its permission request', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-acp-e2e-')));
    const repo = join(scratch, 'shop');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const home = join(scratch, 'home');
    mkdirSync(home);
    const fake = JSON.stringify([process.execPath, FAKE]); // this test's own node
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: {
        ...env,
        HOME: home,
        AMW_DATA_DIR: join(scratch, 'data'),
        AMW_BACKGROUND: '1',
        AMW_MAIN_AGENT: 'off',
        AMW_NO_OPENAI: '1',
        AMW_NO_AUTOLISTEN: '1',
        AMW_NO_SHELL_PATH: '1',
        // Both ACP entries run the fake agent: never a real CLI.
        AMW_ACP_COMMAND_OPENCODE: fake,
        AMW_ACP_COMMAND_ANTIGRAVITY: fake,
        FAKE_ACP_DIR: join(scratch, 'fake-store'),
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true }, permissionMode: 'ask', language: 'en' });
    await invoke(page, 'project:add', { rootPath: repo, name: 'shop' });
    await expect.poll(async () => (await snapshot(page)).capabilities.find((c) => c.provider === 'opencode')?.available, { timeout: 30_000 }).toBe(true);

    await page.getByTestId('new-task').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('OpenCode', { exact: true }).click();
    await dialog.getByTestId('create-agent').click();
    await expect.poll(async () => (await snapshot(page)).tasks.find((t) => t.provider === 'opencode')?.status, { timeout: 30_000 }).toBeTruthy();
    const task = (await snapshot(page)).tasks.find((t) => t.provider === 'opencode')!;

    const input = page.getByTestId('composer-input');
    await input.fill('hello there');
    await input.press('Enter');
    const transcript = page.getByTestId('transcript');
    await transcript.getByText('Echo: hello there').waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await snapshot(page)).tasks.find((t) => t.taskId === task.taskId)?.activeModel, { timeout: 10_000 }).toBe('fake-small');

    // A tool call that needs permission: its diff on the card, answered there.
    await input.fill('now make a tool call');
    await input.press('Enter');
    const card = page.getByTestId('attention-item').filter({ hasText: 'Apply changes to src/app.ts' });
    await card.waitFor({ timeout: 30_000 });
    expect(await card.textContent()).toContain('const b = 3;');
    await transcript.getByTestId('tool-call').filter({ hasText: 'Edit src/app.ts' }).first().waitFor();
    await page.screenshot({ path: join(shots, 'acp-agent-permission.png') });
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await transcript.getByText('Edited src/app.ts.').waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await snapshot(page)).tasks.find((t) => t.taskId === task.taskId)?.status, { timeout: 10_000 }).toBe('done');
    const tool = await transcript.locator('[data-testid="tool-call"][data-kind="edit"]').first();
    expect(await tool.getAttribute('class')).toContain('tool-completed');
    // Side questions and forks, as for Claude Code and Codex.
    const caps = (await snapshot(page)).capabilities.find((c) => c.provider === 'opencode')!;
    expect(caps).toMatchObject({ fork: true, sideQuestions: true });

    // Settings › Coding agents lists the ACP CLIs.
    await invoke(page, 'capabilities:refresh', { localOnly: true });
    await page.keyboard.press('Meta+,');
    const row = page.getByTestId('provider-opencode');
    if (!(await row.count())) await page.getByRole('button', { name: 'Settings' }).first().click();
    await row.waitFor({ timeout: 10_000 });
    expect(await row.textContent()).toContain('OpenCode');
    await page.getByTestId('provider-antigravity').waitFor();
    await page.screenshot({ path: join(shots, 'acp-agent-settings.png') });
  }, 120_000);

  it('reads each CLI’s sign-in with its own commands and signs in from the app', async () => {
    await app?.close().catch(() => {});
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-acp-e2e-auth-')));
    const repo = join(scratch, 'shop');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const home = join(scratch, 'home');
    mkdirSync(home);
    // Each CLI signed out (its own sign-in file missing); Antigravity's browser sign-in never finishes here.
    const ocAuth = join(scratch, 'opencode-signed-in');
    const agyAuth = join(scratch, 'agy-signed-in');
    const terminal = join(scratch, 'terminal.log');
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: {
        ...env,
        HOME: home,
        AMW_DATA_DIR: join(scratch, 'data'),
        AMW_BACKGROUND: '1',
        AMW_MAIN_AGENT: 'off',
        AMW_NO_OPENAI: '1',
        AMW_NO_AUTOLISTEN: '1',
        AMW_NO_SHELL_PATH: '1',
        AMW_TERMINAL_LOG: terminal,
        AMW_ACP_COMMAND_OPENCODE: JSON.stringify(['/usr/bin/env', `FAKE_ACP_AUTH_FILE=${ocAuth}`, process.execPath, FAKE]),
        AMW_ACP_COMMAND_ANTIGRAVITY: JSON.stringify(['/usr/bin/env', `FAKE_ACP_AUTH_FILE=${agyAuth}`, 'FAKE_ACP_AUTH_HANG=1', process.execPath, FAKE]),
        FAKE_ACP_DIR: join(scratch, 'fake-store'),
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true }, language: 'en' });
    await invoke(page, 'project:add', { rootPath: repo, name: 'shop' });
    const auth = async (p: string) => (await snapshot(page)).capabilities.find((c) => c.provider === p)?.auth;
    await expect.poll(() => auth('opencode'), { timeout: 30_000 }).toEqual({ loggedIn: false });
    expect(await auth('antigravity')).toEqual({ loggedIn: false });
    // The empty workspace's checklist says so.
    const check = page.getByTestId('setup-check');
    await expect.poll(async () => (await check.textContent()) ?? '', { timeout: 10_000 }).toMatch(/OpenCode.*Not signed in.*Antigravity.*Not signed in/);
    // So does the New agent dialog.
    await page.getByTestId('new-task').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('OpenCode', { exact: true }).click();
    await dialog.getByText('OpenCode is installed but not signed in. Open Settings for how to sign in.').waitFor({ timeout: 10_000 });
    await page.keyboard.press('Escape');

    await page.keyboard.press('Meta+,');
    const agy = page.getByTestId('provider-antigravity');
    if (!(await agy.count())) await page.getByRole('button', { name: 'Settings' }).first().click();
    await agy.waitFor({ timeout: 10_000 });
    // Antigravity: the browser sign-in (ACP authenticate); when the browser does not come, a link and a code.
    await agy.getByTestId('acp-signin-start').click();
    await agy.getByTestId('acp-signing').getByText('Finish signing in in your browser; this updates by itself.').waitFor({ timeout: 10_000 });
    await agy.getByTestId('acp-signin-use-code').click();
    const link = agy.getByTestId('acp-signin-link');
    await link.waitFor({ timeout: 10_000 });
    expect(await link.getAttribute('href')).toBe('https://example.test/oauth?state=fake');
    await agy.getByTestId('acp-signin-code').fill('bad-code');
    await agy.getByRole('button', { name: 'Send' }).click();
    await agy.getByTestId('acp-signin-error').getByText(/invalid_grant/).waitFor({ timeout: 10_000 });
    await agy.getByTestId('acp-signin-start').click();
    await agy.getByTestId('acp-signin-use-code').click();
    await agy.getByTestId('acp-signin-code').fill('good-code');
    await page.screenshot({ path: join(shots, 'acp-signin-code.png') });
    await agy.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => auth('antigravity'), { timeout: 60_000 }).toEqual({ loggedIn: true });
    await agy.getByTestId('readiness').and(page.locator('[data-state="ready"]')).waitFor({ timeout: 10_000 });

    // OpenCode: its interactive login in a Terminal window, then Recheck.
    const oc = page.getByTestId('provider-opencode');
    await oc.getByTestId('acp-signin-start').click();
    await oc.getByTestId('acp-signin-terminal').waitFor({ timeout: 10_000 });
    expect(readFileSync(terminal, 'utf8')).toContain(`FAKE_ACP_AUTH_FILE=${ocAuth}`);
    expect(readFileSync(terminal, 'utf8').trim()).toMatch(/ auth login$/);
    writeFileSync(ocAuth, 'ok'); // as if signed in there
    await oc.getByTestId('acp-signin-recheck').click();
    // (The recheck asks every CLI here again, Claude Code's and Codex's real ones included: it may take a while.)
    await expect.poll(() => auth('opencode'), { timeout: 60_000 }).toEqual({ loggedIn: true, method: 'FakeCo' });
    await oc.getByText('Signed in · FakeCo').waitFor({ timeout: 10_000 });
    expect(existsSync(agyAuth)).toBe(true);
    await page.screenshot({ path: join(shots, 'acp-signin-done.png') });
  }, 240_000);
});
