// Choosing a coding agent with 2, 3, 4 (a grid of equal one-line options, rows evened out) and 5
// (a dropdown) to choose from, at a normal and a narrow width, in English and Chinese; and the other
// places that list providers, with four of them. ACP entries run the fake agent: never a real CLI.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
const FAKE = join(appDir, 'tests/fixtures/fake-acp-agent.mjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});
const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;
const snapshot = (page: Page) => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});

async function launch(opts: { acp: boolean; demo: boolean; dismiss?: boolean }): Promise<{ page: Page; repo: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-picker-')));
  const repo = join(scratch, 'shop');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const home = join(scratch, 'home');
  mkdirSync(home);
  const fake = JSON.stringify([process.execPath, FAKE]);
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    cwd: appDir,
    env: {
      ...env,
      HOME: home,
      AMW_DATA_DIR: join(scratch, 'data'),
      AMW_MAIN_AGENT: 'off',
      AMW_NO_OPENAI: '1',
      AMW_NO_AUTOLISTEN: '1',
      AMW_NO_SHELL_PATH: '1',
      FAKE_ACP_DIR: join(scratch, 'fake-store'),
      ...(opts.demo ? { AMW_MODE: 'demo' } : {}),
      ...(opts.acp ? { AMW_ACP_COMMAND_OPENCODE: fake, AMW_ACP_COMMAND_ANTIGRAVITY: fake } : { AMW_ACP_OFF: '1' }),
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.app');
  if (opts.dismiss !== false) await invoke(page, 'settings:update', { onboarding: { dismissed: true }, language: 'en' });
  if (opts.acp) await expect.poll(async () => (await snapshot(page)).capabilities.find((c) => c.provider === 'antigravity')?.available, { timeout: 30_000 }).toBe(true);
  return { page, repo };
}

/** The dialog's picker, checked: its control, columns, equal one-line options, nothing overflowing. */
async function checkPicker(page: Page, name: string, count: number, expected: { control: 'grid' | 'dropdown'; columns?: number }) {
  await page.getByTestId('new-task').first().click();
  const picker = page.getByRole('dialog').getByTestId('provider-picker');
  await picker.waitFor();
  expect(await picker.getAttribute('data-control')).toBe(expected.control);
  const m = await picker.evaluate((el) => {
    const modal = el.closest('.modal') as HTMLElement;
    const body = modal.querySelector('.modal-body') as HTMLElement | null;
    const opts = [...el.querySelectorAll('label.radio')].map((o) => {
      const r = o.getBoundingClientRect();
      const label = o.querySelector('.radio-label') as HTMLElement;
      return { h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top), right: r.right, lineH: label ? label.getBoundingClientRect().height : 0 };
    });
    return {
      opts,
      options: el.querySelectorAll('option').length,
      overflow: el.scrollWidth - el.clientWidth,
      modalOverflow: (body ?? modal).scrollWidth - (body ?? modal).clientWidth,
      right: el.getBoundingClientRect().right,
      modalRight: modal.getBoundingClientRect().right,
    };
  });
  expect(m.overflow, name).toBeLessThanOrEqual(1);
  expect(m.modalOverflow, name).toBeLessThanOrEqual(1);
  expect(m.right, name).toBeLessThanOrEqual(m.modalRight);
  if (expected.control === 'grid') {
    expect(m.opts.length, name).toBe(count);
    expect(Number(await picker.getAttribute('data-columns')), name).toBe(expected.columns);
    // Equal heights, one line each (an option is no taller than a line plus its padding).
    expect(new Set(m.opts.map((o) => o.h)).size, name).toBe(1);
    expect(m.opts[0].h, name).toBeLessThan(44);
    for (const o of m.opts) expect(o.lineH, name).toBeLessThan(24);
    // Rows evened out: every row as full as the first.
    const rows = new Map<number, number>();
    for (const o of m.opts) rows.set(o.top, (rows.get(o.top) ?? 0) + 1);
    expect([...rows.values()].every((n) => n === expected.columns), name).toBe(true);
    // Equal widths in a row.
    expect(new Set(m.opts.map((o) => o.w)).size, name).toBe(1);
  } else {
    expect(m.options, name).toBe(count);
  }
  await page.screenshot({ path: join(shots, `provider-picker-${name}.png`) });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}

/** Normal and narrow width, English and Chinese. */
async function eachLook(page: Page, count: number, normal: { control: 'grid' | 'dropdown'; columns?: number }, narrow: { control: 'grid' | 'dropdown'; columns?: number }) {
  for (const language of ['en', 'zh'] as const) {
    await invoke(page, 'settings:update', { language });
    await page.setViewportSize({ width: 1280, height: 820 });
    await checkPicker(page, `${count}-${language}-normal`, count, normal);
    await page.setViewportSize({ width: 420, height: 820 });
    await checkPicker(page, `${count}-${language}-narrow`, count, narrow);
  }
  await invoke(page, 'settings:update', { language: 'en' });
  await page.setViewportSize({ width: 1280, height: 820 });
}

describe('provider picker', () => {
  it('two agents: one row of two', async () => {
    const { page, repo } = await launch({ acp: false, demo: false });
    await invoke(page, 'project:add', { rootPath: repo, name: 'shop' });
    await eachLook(page, 2, { control: 'grid', columns: 2 }, { control: 'grid', columns: 2 });
  }, 120_000);

  it('three agents: one row of three, one per row when narrow', async () => {
    const { page, repo } = await launch({ acp: false, demo: true });
    await invoke(page, 'project:add', { rootPath: repo, name: 'shop' });
    await eachLook(page, 3, { control: 'grid', columns: 3 }, { control: 'grid', columns: 1 });
  }, 120_000);

  it('four agents: 2×2; and every other place that lists them', async () => {
    const { page, repo } = await launch({ acp: true, demo: false, dismiss: false });
    // The first-run guide's step "connect a coding agent", with the ACP rows.
    await page.setViewportSize({ width: 1280, height: 900 });
    if (await page.getByTestId('onboarding').count()) {
      await page.screenshot({ path: join(shots, 'provider-picker-onboarding.png') });
      await page.setViewportSize({ width: 900, height: 900 });
      await page.screenshot({ path: join(shots, 'provider-picker-onboarding-narrow.png') });
    }
    await invoke(page, 'settings:update', { onboarding: { dismissed: true }, language: 'en' });
    // The empty workspace's checklist: one row per provider, nothing overflowing.
    await page.setViewportSize({ width: 1280, height: 900 });
    const check = page.getByTestId('setup-check');
    await check.waitFor();
    expect(await check.locator('.setup-row').count()).toBe(5); // four agents and voice
    for (const language of ['en', 'zh'] as const) {
      await invoke(page, 'settings:update', { language });
      for (const width of [1280, 900]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await check.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        await check.screenshot({ path: join(shots, `provider-picker-checklist-${language}-${width}.png`) });
      }
    }
    await invoke(page, 'settings:update', { language: 'en' });
    await page.setViewportSize({ width: 1280, height: 820 });
    await invoke(page, 'project:add', { rootPath: repo, name: 'shop' });
    await eachLook(page, 4, { control: 'grid', columns: 2 }, { control: 'grid', columns: 2 });

    // Settings › Coding agents: a row each; the main agent offers Claude Code, Codex or Off only.
    await page.keyboard.press('Meta+,');
    const row = page.getByTestId('provider-antigravity');
    if (!(await row.count())) await page.getByRole('button', { name: 'Settings' }).first().click();
    await row.waitFor({ timeout: 10_000 });
    for (const language of ['en', 'zh'] as const) {
      await invoke(page, 'settings:update', { language });
      for (const width of [1280, 900]) {
        await page.setViewportSize({ width, height: 900 });
        for (const p of ['claude', 'codex', 'opencode', 'antigravity']) {
          const r = page.getByTestId(`provider-${p}`);
          expect(await r.evaluate((el) => el.scrollWidth - el.clientWidth), `${p} ${language} ${width}`).toBeLessThanOrEqual(1);
        }
        await page.getByTestId('provider-claude').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(shots, `provider-picker-settings-${language}-${width}.png`) });
        // The main agent's choice (a dropdown beyond four choices, else a segmented control): inside its section.
        const seg = page.locator(`[data-testid="main-agent-select"], .segmented[aria-label="${language === 'zh' ? '主 Agent' : 'Main agent'}"]`);
        expect(await seg.count()).toBe(1);
        {
          const box = await seg.evaluate((el) => ({ right: el.getBoundingClientRect().right, parent: (el.closest('.settings-section') as HTMLElement).getBoundingClientRect().right }));
          expect(box.right, `main agent ${language} ${width}`).toBeLessThanOrEqual(box.parent);
          await seg.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(shots, `provider-picker-main-agent-${language}-${width}.png`) });
        }
      }
    }
    await invoke(page, 'settings:update', { language: 'en' });
    await page.keyboard.press('Escape');

    // An ACP agent: its mark in the sidebar, the card and the header; no limits footer for it.
    const project = (await snapshot(page)).projects[0];
    await invoke(page, 'task:create', { projectId: project.projectId, provider: 'antigravity', isolate: false });
    await expect.poll(async () => (await snapshot(page)).tasks.length).toBe(1);
    const card = page.getByTestId('agent-card').first();
    await card.waitFor({ timeout: 30_000 });
    expect(await card.textContent()).toContain('Antigravity');
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 820 });
      await page.screenshot({ path: join(shots, `provider-picker-overview-${width}.png`) });
    }
    await card.dblclick();
    await page.getByTestId('composer-input').first().waitFor({ timeout: 30_000 });
    expect(await page.getByTestId('account-limits').count()).toBe(0);
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 820 });
      await page.screenshot({ path: join(shots, `provider-picker-agent-${width}.png`) });
    }
  }, 180_000);

  it('five agents: one dropdown', async () => {
    const { page, repo } = await launch({ acp: true, demo: true });
    await invoke(page, 'project:add', { rootPath: repo, name: 'shop' });
    await eachLook(page, 5, { control: 'dropdown' }, { control: 'dropdown' });
    // Picking from it works, and the choice is used.
    await page.getByTestId('new-task').first().click();
    const select = page.getByRole('dialog').getByTestId('provider-picker').locator('select');
    await select.selectOption('opencode');
    await page.getByRole('dialog').getByTestId('create-agent').click();
    await expect.poll(async () => (await snapshot(page)).tasks.find((t) => t.provider === 'opencode')?.provider, { timeout: 30_000 }).toBe('opencode');
  }, 120_000);
});
