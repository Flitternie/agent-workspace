import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
// Projects where nothing is going on fold into one "Archived" row; one comes back when an agent in it is messaged.
it('folds inactive projects into Archived and brings one back when it is used', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amw-ar-')));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, HOME: home, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-ard-')), AMW_MOCK_DELAY_MS: '20', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.app');
  const inv = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<any>;
  await inv('settings:update', { onboarding: { dismissed: true }, language: 'zh' });
  const made: Record<string, string[]> = {};
  for (const name of ['shop', 'blog', 'paper-2025', 'old-site']) {
    const dir = join(home, name); mkdirSync(dir); writeFileSync(join(dir, 'README.md'), 'x'); execFileSync('git', ['init', '-q'], { cwd: dir });
    const p = await inv('project:add', { rootPath: dir, name });
    made[name] = [];
    for (const n of [1, 2]) made[name].push((await inv('task:create', { projectId: p.projectId, provider: 'mock', title: `${name} ${n}`, name: `${name} ${n}`, mockScript: 'quick', instruction: 'Do.', isolate: false })).taskId);
  }
  await page.waitForTimeout(3000);
  for (const name of ['paper-2025', 'old-site']) for (const id of made[name]) await inv('task:setAside', { taskId: id, on: true });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(appDir, 'test-results', 'archive-1.png'), clip: { x: 0, y: 0, width: 252, height: 900 } });
  expect(await page.getByTestId('team-archive').count()).toBe(1);
  expect(await page.locator('.agent-list > [data-testid="team"]').count()).toBe(2);
  await page.getByTestId('team-archive-head').click(); await page.waitForTimeout(300);
  await page.screenshot({ path: join(appDir, 'test-results', 'archive-2.png'), clip: { x: 0, y: 0, width: 252, height: 900 } });
  // An agent in an archived project gets a message: the project comes back.
  await inv('task:send', { taskId: made['old-site'][0], text: 'One more thing.', via: 'text' });
  await expect.poll(() => page.locator('.agent-list > [data-testid="team"][data-project="old-site"]').count(), { timeout: 10000 }).toBe(1);
  await page.screenshot({ path: join(appDir, 'test-results', 'archive-3.png'), clip: { x: 0, y: 0, width: 252, height: 900 } });
  await app.close();
}, 180000);
