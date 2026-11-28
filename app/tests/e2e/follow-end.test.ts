import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

// The conversation follows the agent's work at its end: after the user sends (even from a little way up),
// and through content that grows on its own; only the reader scrolling up leaves the end.
it('keeps to the end while the agent works, unless the reader scrolls up', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amw-fe-')));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, HOME: home, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-fed-')), AMW_MOCK_DELAY_MS: '60', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1300, height: 700 });
  await page.waitForSelector('.app');
  const inv = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<any>;
  await inv('settings:update', { onboarding: { dismissed: true } });
  writeFileSync(join(home, 'README.md'), 'x');
  execFileSync('git', ['init', '-q'], { cwd: home });
  const p = await inv('project:add', { rootPath: home, name: 'shop' });
  const a = await inv('task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'orders', mockScript: 'work', isolate: false });
  await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"]`).click();
  const box = page.getByTestId('composer-input');
  const fromEnd = () => page.getByTestId('transcript').evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  const idle = () => expect.poll(async () => (await inv('workspace:snapshot', {})).tasks.find((t: any) => t.taskId === a.taskId).status, { timeout: 30_000 }).toMatch(/done|idle|waiting_for_user/);

  for (const text of ['First request.', 'Second request.']) {
    await box.fill(text);
    await box.press('Enter');
    await idle();
  }
  await expect.poll(fromEnd).toBeLessThan(5);

  // Content that grows after the view scrolled to its end (as code highlighting does) does not leave it.
  await page.getByTestId('transcript').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    const tall = document.createElement('div');
    tall.style.height = '400px';
    el.querySelector('.transcript-inner')!.appendChild(tall);
    el.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(fromEnd).toBeLessThan(5);

  // Scrolled up a little, then a message sent: back to the end, and it stays there while the agent works.
  await page.getByTestId('transcript').hover();
  await page.mouse.wheel(0, -150);
  await expect.poll(fromEnd).toBeGreaterThan(100);
  await box.fill('Third request.');
  await box.press('Enter');
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(250);
    expect(await fromEnd()).toBeLessThan(5);
  }
  await idle();
  expect(await fromEnd()).toBeLessThan(5);

  // The reader scrolling up while it works: it stays where they are.
  await box.fill('Fourth request.');
  await box.press('Enter');
  await page.waitForTimeout(300);
  await page.getByTestId('transcript').hover();
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(200);
  const away = await fromEnd();
  expect(away).toBeGreaterThan(200);
  await idle();
  expect(await fromEnd()).toBeGreaterThanOrEqual(away);
  await app.close();
}, 120000);
