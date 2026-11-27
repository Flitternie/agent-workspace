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
  app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 820 }).catch(() => {});
  await page.waitForSelector('.app');
  return page;
}

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

afterAll(async () => {
  await app?.close().catch(() => {});
});

describe('real entry: first run, settings, language', () => {
  it('starts empty, shows readiness, switches to Chinese and remembers it', async () => {
    let page = await launch();
    // A fresh workspace opens on the first-run guide; each CLI settles (never stuck checking).
    await expect.poll(() => page.getByTestId('onboarding').count(), { timeout: 30_000 }).toBe(1);
    const settling = async () => {
      // Connected already (the step folds), or each row shows ready / signed out / missing.
      if ((await page.getByTestId('onboarding-step-1').getAttribute('data-done')) === 'true') return false;
      const rows = page.locator('[data-testid="onboarding-claude"], [data-testid="onboarding-codex"]');
      return (await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).includes('checking');
    };
    await expect.poll(settling, { timeout: 30_000 }).toBe(false);
    // Skipped, it gives way to the empty Overview.
    await page.getByTestId('onboarding-skip').click();
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
    await expect.poll(() => page.getByTestId('settings-page').innerText()).toContain('Agent 连接');
    // Settings is a page with search, not a dialog.
    expect(await page.getByRole('dialog').count()).toBe(0);
    await page.getByTestId('settings-search').fill('权限');
    await expect.poll(() => page.locator('.settings-section').count()).toBe(1);
    await page.getByTestId('settings-search').fill('');
    await page.getByTestId('perm-auto').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'settings-zh.png') });
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.stage-head h1').innerText()).toBe('总览');
    await page.screenshot({ path: join(shots, 'first-run-zh.png') });

    // Sessions from any folder on this computer can be continued here (import only; nothing is started).
    await page.getByTestId('resume-session').click();
    await expect.poll(async () => (await page.getByTestId('session-row').count()) > 0 || (await page.getByRole('dialog').innerText()).includes('没有找到会话'), { timeout: 30_000 }).toBe(true);
    await page.screenshot({ path: join(shots, 'sessions-zh.png') });
    if (await page.getByTestId('session-row').count()) {
      await page.getByTestId('session-row').first().getByRole('button').click();
      await expect.poll(() => page.getByTestId('composer-target').count(), { timeout: 15_000 }).toBe(1);
      expect(await page.getByTestId('composer-target').innerText()).toContain('小王');
      // The past conversation is shown right away, without resuming anything.
      await expect.poll(() => page.getByTestId('transcript').locator('.msg').count(), { timeout: 30_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(shots, 'session-history-zh.png') });
      await page.screenshot({ path: join(shots, 'session-imported-zh.png') });
      await page.keyboard.press('Escape');
    } else await page.keyboard.press('Escape');

    await app!.close();
    page = await launch();
    await expect.poll(() => page.locator('.stage-head h1').innerText()).toBe('总览');
    await page.getByTestId('open-settings').click();
    await page.getByTestId('lang-en').click();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.stage-head h1').innerText()).toBe('Overview');
    await page.screenshot({ path: join(shots, 'first-run-en.png') });
  }, 120_000);

  it('Advanced: picks a choice per row, keeps it after a restart, restores the defaults', async () => {
    await app?.close();
    let page = await launch();
    await page.getByTestId('open-settings').click();
    const value = (key: string) => page.getByTestId(`adv-${key}`).inputValue();
    expect(await value('openTurns')).toBe('1');
    expect(await value('toolsOpen')).toBe('folded');
    await expect.poll(() => page.getByTestId('advanced-reset').isDisabled()).toBe(true);
    await page.getByTestId('adv-openTurns').selectOption('3');
    await page.getByTestId('adv-toolsOpen').selectOption('failed');
    await page.getByTestId('adv-idleAfterDays').selectOption('0');
    await expect.poll(() => value('openTurns')).toBe('3');
    await page.getByTestId('settings-advanced').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'settings-advanced.png') });
    await app!.close();
    page = await launch();
    await page.getByTestId('open-settings').click();
    expect(await value('openTurns')).toBe('3');
    expect(await value('toolsOpen')).toBe('failed');
    expect(await value('idleAfterDays')).toBe('0');
    // Sleep, in General: on unless turned off, and kept.
    expect(await page.getByTestId('keep-awake').isChecked()).toBe(true);
    // Controlled by the saved setting: it flips once saved.
    await page.getByTestId('keep-awake').click();
    await expect.poll(() => invoke<{ settings: { keepAwake?: boolean } }>(page, 'workspace:snapshot', {}).then((x) => x.settings.keepAwake)).toBe(false);
    await page.getByTestId('keep-awake').click();
    await expect.poll(() => page.getByTestId('keep-awake').isChecked()).toBe(true);
    await page.getByTestId('advanced-reset').click();
    await expect.poll(() => value('openTurns')).toBe('1');
    expect(await value('idleAfterDays')).toBe('3');
    await expect.poll(() => page.getByTestId('advanced-reset').isDisabled()).toBe(true);
    await page.keyboard.press('Escape');
  }, 120_000);
});
