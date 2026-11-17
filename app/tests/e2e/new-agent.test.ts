// New agent: no title or name to make up; created empty, its first message says what it is for.
import { mkdirSync, mkdtempSync } from 'node:fs';
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
    // The demo entry offers mock agents in the dialog.
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-new-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
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
