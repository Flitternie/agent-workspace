// Green = a result you have not looked at; grey once seen (still listed); "set aside" folds it until it acts again.
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
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-aside-'))), 'shop');
  mkdirSync(dir);
  writeFileSync(join(dir, 'README.md'), '# shop\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('seen and set aside', () => {
  it('greys a result once seen without folding it; set aside folds it until it is messaged', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-aside-data-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo(), name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', mockScript: 'work', instruction: 'Do orders.', isolate: false });
    const b = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Charts', name: 'Charts', mockScript: 'work', instruction: 'Do charts.', isolate: false });
    // By alias: text matching is case-insensitive and both agents' reports mention orders.
    const alias = (name: string) => (name === 'Orders' ? a.alias : b.alias);
    const row = (name: string) => page.locator(`[data-testid="rail-item"][data-alias="${alias(name)}"]`);
    const dot = (name: string) => row(name).getByTestId('row-dot').getAttribute('data-dot');
    const card = (name: string) => page.locator(`[data-testid="agent-card"][data-alias="${alias(name)}"]`);

    // Finished, not looked at: green.
    await expect.poll(() => dot('Orders'), { timeout: 30_000 }).toBe('done');
    await expect.poll(() => dot('Charts'), { timeout: 30_000 }).toBe('done');
    // Opened: grey, still in its place and on the Overview.
    await row('Orders').click();
    await expect.poll(() => dot('Orders')).toBe('seen');
    expect(await row('Orders').locator('[data-testid="row-dot"] .dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(133, 141, 154)');
    expect(await dot('Charts')).toBe('done');
    await page.getByRole('button', { name: /^Overview/ }).click();
    expect(await row('Orders').count()).toBe(1);
    await expect.poll(() => card('Orders').count()).toBe(1);
    await page.screenshot({ path: join(shots, 'aside-01-seen.png') });

    // Set aside from its header: folded under idle (hollow dot there) and off the Overview; still running.
    await row('Orders').click();
    // Every button in the header row has a one-word label that shows on hover (not a slow title).
    const tips = await page.locator('.focus-actions').evaluate((bar) =>
      [...bar.querySelectorAll('button, .perm')].filter((b) => !b.closest('.remote-pop, .open-in-menu') && !b.matches('.perm select') && (b as HTMLElement).offsetParent).map((b) => b.getAttribute('data-tip') ?? b.closest('[data-tip]')?.getAttribute('data-tip') ?? null),
    );
    expect(tips.length).toBeGreaterThan(6);
    expect(tips.filter((x) => !x)).toEqual([]);
    expect(tips.every((x) => x!.split(' ').length <= 3)).toBe(true);
    await page.getByTestId('set-aside').hover();
    await expect.poll(() => page.getByTestId('set-aside').evaluate((b) => getComputedStyle(b, '::after').opacity)).toBe('1');
    expect(await page.getByTestId('set-aside').evaluate((b) => getComputedStyle(b, '::after').content)).toBe('"Set aside"');
    await page.screenshot({ path: join(shots, 'aside-00-tip.png') });
    await page.getByTestId('set-aside').click();
    await expect.poll(() => page.getByTestId('set-aside').getAttribute('aria-pressed')).toBe('true');
    await page.getByRole('button', { name: /^Overview/ }).click();
    await expect.poll(() => row('Orders').count()).toBe(0);
    await expect.poll(() => card('Orders').count()).toBe(0);
    await expect.poll(() => page.getByTestId('team-idle').innerText()).toContain('1');
    expect((await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).connectedTaskIds).toContain(a.taskId);
    await page.getByTestId('team-idle').click();
    await expect.poll(() => dot('Orders')).toBe('idle');
    // Painted hollow (not green): the row's own status class must not colour the dot.
    const paint = (name: string) => row(name).locator('[data-testid="row-dot"] .dot').evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(await paint('Orders')).toBe('rgba(0, 0, 0, 0)');
    await page.screenshot({ path: join(shots, 'aside-02-set-aside.png') });

    // Messaged: back among the active, by itself.
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'One more thing.', via: 'text' });
    await expect.poll(async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.find((t) => t.taskId === a.taskId)?.setAside ?? false).toBe(false);
    await expect.poll(() => card('Orders').count(), { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => !['running', 'starting'].includes((await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.find((t) => t.taskId === a.taskId)!.status), { timeout: 30_000 }).toBe(true);

    // Opened from its tile (the pointer over the Overview as it goes) and set aside there: back on the
    // Overview it is gone (the Overview is not left holding still under a pointer that has moved on).
    await card('Orders').locator('.tile-head').dblclick();
    await page.getByTestId('set-aside').click();
    await expect.poll(() => page.getByTestId('set-aside').getAttribute('aria-pressed')).toBe('true');
    await page.getByRole('button', { name: /^Overview/ }).click();
    await expect.poll(() => card('Orders').count()).toBe(0);
    // Set aside while the pointer rests on the Overview (tiles hold still): it still leaves.
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'Back again.', via: 'text' });
    await expect.poll(() => card('Orders').count(), { timeout: 30_000 }).toBe(1);
    await card('Orders').hover();
    await invoke(page, 'task:setAside', { taskId: a.taskId, on: true });
    await expect.poll(() => card('Orders').count()).toBe(0);
    await page.mouse.move(5, 5);
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'And back.', via: 'text' });
    await expect.poll(() => card('Orders').count(), { timeout: 30_000 }).toBe(1);

    // One that ended its turn on a question (waiting on you): set aside, it leaves "Needs you", its
    // team and every count too; the question it ended on is hidden with it.
    const q = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Research', name: 'Research', mockScript: 'ask:Should I keep going?', instruction: 'Look into it.', isolate: false });
    const needs = () => page.locator(`[data-testid="needs-item"][data-alias="${q.alias}"]`);
    await expect.poll(() => needs().count(), { timeout: 30_000 }).toBe(1);
    const needCount = async () => Number(/(\d+) need/.exec(await page.getByTestId('topbar-summary').innerText())?.[1] ?? 0);
    await expect.poll(needCount).toBeGreaterThan(0);
    const before = await needCount();
    await needs().click();
    await page.getByTestId('set-aside').click();
    await page.getByRole('button', { name: /^Overview/ }).click();
    await expect.poll(() => needs().count()).toBe(0);
    // Listed only under its team's idle row (unfolded earlier in this test), after the idle toggle.
    await expect
      .poll(() =>
        page.evaluate((al) => {
          const row = document.querySelector(`[data-testid="rail-item"][data-alias="${al}"]`);
          const toggle = document.querySelector('[data-testid="team-idle"]');
          return !!row && !!toggle && !!(toggle.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
        }, q.alias),
      )
      .toBe(true);
    await expect.poll(() => page.locator(`[data-testid="agent-card"][data-alias="${q.alias}"]`).count()).toBe(0);
    await expect.poll(needCount).toBe(before - 1);
    await page.screenshot({ path: join(shots, 'aside-03-question-hidden.png') });
    // Messaged, it is back (and its new turn is under way).
    await invoke(page, 'task:send', { taskId: q.taskId, text: 'Yes, keep going.', via: 'text' });
    await expect.poll(() => page.locator(`[data-testid="agent-card"][data-alias="${q.alias}"]`).count(), { timeout: 30_000 }).toBe(1);
  }, 120_000);
});
