// New agent: no title or name to make up; created empty, its first message says what it is for.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '../../src/shared/types';

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

describe('new agent', () => {
  it('creates an agent with nothing filled in; its first message names it', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    // Folders where sessions "ran" (a fixture, never this Mac's real sessions): one to pick, one inside nothing.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-found-')));
    const shop = join(scratch, 'billing-service');
    mkdirSync(shop);
    execFileSync('git', ['init', '-q'], { cwd: shop });
    const fixture = join(scratch, 'sessions.json');
    writeFileSync(
      fixture,
      JSON.stringify([
        { provider: 'claude', nativeSessionId: 's1', cwd: shop, title: 'Fix invoices', updatedAt: new Date().toISOString() },
        { provider: 'codex', nativeSessionId: 's2', cwd: shop, title: 'Add refunds', updatedAt: new Date().toISOString() },
        { provider: 'claude', nativeSessionId: 's3', cwd: join(scratch, 'ml-notes'), title: 'Read papers', updatedAt: new Date(Date.now() - 86400_000).toISOString() },
        { provider: 'claude', nativeSessionId: 's4', cwd: join(scratch, 'bot'), title: 'sub-agent', automated: true },
      ]),
    );
    // The demo entry offers mock agents in the dialog.
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-new-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_DISCOVER_FIXTURE: fixture } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    await expect.poll(async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).projects.length, { timeout: 30_000 }).toBeGreaterThan(0);
    // The demo seeds its sample agents in the background: wait until they are all there.
    let last = -1;
    await expect
      .poll(async () => {
        const n = (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.length;
        const settled = n > 0 && n === last;
        last = n;
        return settled;
      }, { timeout: 30_000, interval: 1500 })
      .toBe(true);
    const before = (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.map((t) => t.taskId);

    await page.getByTestId('new-task').first().click();
    const dialog = page.getByRole('dialog');
    // The project: the one used last, shown as a button.
    await expect.poll(() => page.getByTestId('project-current').innerText()).toContain('demo-shop');
    // Opened: a searchable list of the projects added (recent first), then folders where sessions ran
    // (automated ones left out), then the other ways to add a folder.
    await page.getByTestId('project-current').click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('project-search');
    const kinds = () => page.getByTestId('project-item').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-kind')}:${e.textContent?.trim().slice(0, 40)}`));
    await expect.poll(async () => (await kinds()).filter((k) => k.startsWith('found:')).length).toBe(2);
    const listed = await kinds();
    expect(listed[0]).toMatch(/^project:demo-shop/);
    const foundNames = listed.filter((k) => k.startsWith('found:'));
    expect(foundNames[0]).toMatch(/^found:billing-service/);
    expect(foundNames[1]).toMatch(/^found:ml-notes/);
    expect(listed.some((k) => k.includes('bot'))).toBe(false);
    expect(listed.at(-1)).toMatch(/^browse:/);
    expect(await page.getByTestId('project-pop').innerText()).toContain('2 sessions');
    await page.screenshot({ path: join(shots, 'new-agent-00-projects.png') });
    // Search narrows it; Esc closes the list, not the dialog.
    await page.keyboard.type('billing');
    await expect.poll(async () => (await kinds()).filter((k) => !k.startsWith('browse')).map((k) => k.split(':')[0])).toEqual(['found']);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByTestId('project-pop').count()).toBe(0);
    expect(await dialog.count()).toBe(1);
    // A found folder, picked with the keyboard, becomes the project.
    await page.getByTestId('project-current').click();
    await page.keyboard.type('billing');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('project-current').innerText()).toContain('billing-service');
    expect((await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).projects.some((p) => p.rootPath === shop)).toBe(true);
    // Nothing to name: no label or title fields; the instruction is optional.
    expect(await dialog.locator('input.input').count()).toBe(0);
    await dialog.locator('label.radio').filter({ hasText: 'Mock' }).click();
    await page.screenshot({ path: join(shots, 'new-agent-01-dialog.png') });
    expect(await page.getByTestId('create-agent').isEnabled()).toBe(true);
    await page.getByTestId('create-agent').click();

    // Created and opened, waiting for its first message, the box ready to type in.
    let fresh = '';
    await expect
      .poll(async () => {
        const s = await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
        fresh = s.tasks.find((t) => !before.includes(t.taskId))?.taskId ?? '';
        return fresh;
      })
      .not.toBe('');
    const task = async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.find((t) => t.taskId === fresh)!;
    expect((await task()).title).toBe('');
    expect((await task()).name).toBe((await task()).alias);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('composer-input');

    // Its first message is what the task is, and what its name is made from.
    await page.keyboard.type('Migrate the orders API to v2');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await task()).title).toBe('Migrate the orders API to v2');
    await expect.poll(async () => (await task()).name).not.toBe((await task()).alias);
    await expect.poll(() => page.locator('.focus-meta').innerText()).toContain('Migrate the orders API to v2');
    await page.screenshot({ path: join(shots, 'new-agent-02-named.png') });
  }, 120_000);
});
