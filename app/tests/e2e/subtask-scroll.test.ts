import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

// A sub-agent with a long run: its page scrolls, with the scrollbar at the window's edge (not mid-page).
it('a long sub-agent run scrolls across the whole page', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amw-ss-')));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, HOME: home, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-ssd-')), AMW_MOCK_DELAY_MS: '150', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.waitForSelector('.app');
  const inv = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<any>;
  await inv('settings:update', { onboarding: { dismissed: true } });
  writeFileSync(join(home, 'README.md'), 'x');
  execFileSync('git', ['init', '-q'], { cwd: home });
  const p = await inv('project:add', { rootPath: home, name: 'shop' });
  await inv('task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', mockScript: 'subagent-long', instruction: 'Check the callers.', isolate: false });
  await expect.poll(() => page.locator('.sidebar').getByTestId('subtask-dots').count(), { timeout: 15_000 }).toBe(1);
  await page.locator('.sidebar').getByTestId('subtask-dots').click();
  const row = page.locator('.sidebar').getByTestId('subtask-row').first();
  await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(1);
  await row.click();
  await expect.poll(() => page.getByTestId('subtask-steps').locator('li').count(), { timeout: 10_000 }).toBe(50);
  const m = await page.locator('.subtask-view-body').evaluate((b) => {
    const r = b.getBoundingClientRect();
    const v = b.closest('[data-testid="subtask-view"]')!.getBoundingClientRect();
    return { scrolls: b.scrollHeight > b.clientHeight, right: Math.round(r.right), viewRight: Math.round(v.right), wider: r.width > 900 };
  });
  expect(m).toEqual({ scrolls: true, right: m.viewRight, viewRight: m.viewRight, wider: true });
  await app.close();
}, 120000);
