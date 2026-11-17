// Remote Control for Claude agents (mock provider standing in for Claude Code's SDK control request).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-rc-'))), 'shop');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# shop\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

describe('remote control', () => {
  it('turns on from the header, shows the link, turns off, and goes with the session', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-rc-data-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo(), name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', mockScript: 'work', instruction: 'Do orders.', isolate: false });
    const b = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Keys', name: 'Keys', mockScript: 'rc-fail', instruction: 'Hi.', isolate: false });
    const row = (name: string) => page.locator('[data-testid="rail-item"],[data-testid="needs-item"]').filter({ hasText: name }).first();
    const links = async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).remoteControl;
    await expect.poll(() => page.getByTestId('agent-card').count(), { timeout: 30_000 }).toBe(2);

    // On: the button lights up (green dot) and the popover gives the link and where to find it.
    await row('Orders').click();
    await page.getByTestId('remote-control').click();
    await expect.poll(() => page.getByTestId('remote-control').getAttribute('aria-pressed')).toBe('true');
    await expect.poll(() => page.getByTestId('remote-pop').innerText()).toContain('https://claude.ai/code/session_mock_Orders');
    expect((await links())[a.taskId]).toBe('https://claude.ai/code/session_mock_Orders');
    await page.screenshot({ path: join(shots, 'remote-01-on.png') });
    // Closing the popover (a click elsewhere, or Esc) leaves the button lit: Remote Control is still on.
    await page.locator('.focus-thread').click({ position: { x: 20, y: 200 } });
    await expect.poll(() => page.getByTestId('remote-pop').count()).toBe(0);
    const lit = () => page.getByTestId('remote-control').evaluate((b) => ({ pressed: b.getAttribute('aria-pressed'), dot: !!b.querySelector('.remote-dot'), visible: (() => { const d = b.querySelector('.remote-dot'); if (!d) return false; const r = d.getBoundingClientRect(); return r.width > 0 && getComputedStyle(d).visibility !== 'hidden' && getComputedStyle(d).display !== 'none'; })() }));
    expect(await lit()).toEqual({ pressed: 'true', dot: true, visible: true });
    await page.screenshot({ path: join(shots, 'remote-01b-closed.png') });
    // Its × closes it too, and Remote Control stays on; only "Turn off Remote Control" turns it off.
    await page.getByTestId('remote-control').click();
    await page.getByTestId('remote-pop-close').click();
    await expect.poll(() => page.getByTestId('remote-pop').count()).toBe(0);
    expect(await lit()).toEqual({ pressed: 'true', dot: true, visible: true });
    expect((await links())[a.taskId]).toBeTruthy();
    await page.getByTestId('remote-control').click();
    expect(await page.getByTestId('remote-off').innerText()).toBe('Turn off Remote Control');
    // Off from the popover: the session keeps running here.
    await page.getByTestId('remote-off').click();
    await expect.poll(() => page.getByTestId('remote-control').getAttribute('aria-pressed')).toBe('false');
    expect((await links())[a.taskId]).toBeUndefined();
    expect((await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).connectedTaskIds).toContain(a.taskId);

    // On again, then the session stops: Remote Control goes with it.
    await page.getByTestId('remote-control').click();
    await expect.poll(async () => (await links())[a.taskId]).toBeTruthy();
    await invoke(page, 'task:stop', { taskId: a.taskId });
    await expect.poll(async () => (await links())[a.taskId]).toBeUndefined();
    await expect.poll(() => page.getByTestId('remote-control').getAttribute('aria-pressed')).toBe('false');
    // Off and not connected: turning it on starts the session first.
    await page.getByTestId('remote-control').click();
    await expect.poll(async () => (await links())[a.taskId]).toBeTruthy();
    expect((await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).connectedTaskIds).toContain(a.taskId);

    // Refused (a key login): the reason and what it needs, nothing turned on.
    await row('Keys').click();
    await page.getByTestId('remote-control').click();
    await expect.poll(() => page.getByTestId('remote-pop').innerText()).toContain('API keys are not supported');
    expect((await links())[b.taskId]).toBeUndefined();
    expect(await page.getByTestId('remote-control').getAttribute('aria-pressed')).toBe('false');
    await page.screenshot({ path: join(shots, 'remote-02-refused.png') });
  }, 120_000);
});
