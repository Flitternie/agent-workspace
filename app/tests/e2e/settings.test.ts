// The real entry from scratch: no demo agents, readiness checks, settings and
// the Chinese UI (persisted across restarts). No agent sessions are started.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'amw-settings-'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;

async function launch(): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'AMW_MODE') env[k] = v;
  app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_DATA_DIR: dataDir, AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 820 }).catch(() => {});
  await page.waitForSelector('.app');
  return page;
}

afterAll(async () => {
  await app?.close().catch(() => {});
});

describe('real entry: first run, settings, language', () => {
  it('starts empty, shows readiness, switches to Chinese and remembers it', async () => {
    let page = await launch();
    await expect.poll(() => page.getByTestId('setup-check').count()).toBe(1);
    expect(await page.getByTestId('load-demo').count()).toBe(0);
    // Each CLI ends up ready, signed out or missing — never stuck checking.
    await expect.poll(async () => (await page.getByTestId('setup-check').getByTestId('readiness').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).slice(0, 2).includes('checking'), { timeout: 30_000 }).toBe(false);

    await page.getByTestId('new-task').click();
    expect(await page.getByRole('dialog').innerText()).not.toContain('Mock');
    await page.keyboard.press('Escape');

    await page.getByTestId('open-settings').click();
    await expect.poll(() => page.getByTestId('provider-claude').count()).toBe(1);
    await page.getByTestId('lang-zh').click();
    await expect.poll(() => page.getByRole('dialog').innerText()).toContain('Agent 连接');
    await page.screenshot({ path: join(shots, 'settings-zh.png') });
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.stage-head h1').innerText()).toBe('总览');
    await page.screenshot({ path: join(shots, 'first-run-zh.png') });

    await app!.close();
    page = await launch();
    await expect.poll(() => page.locator('.stage-head h1').innerText()).toBe('总览');
    await page.getByTestId('open-settings').click();
    await page.getByTestId('lang-en').click();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.stage-head h1').innerText()).toBe('Overview');
    await page.screenshot({ path: join(shots, 'first-run-en.png') });
  }, 120_000);
});
