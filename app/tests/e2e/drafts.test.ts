import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type Page } from 'playwright-core';
import { expect, it } from 'vitest';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

/** Pastes a small drawn image into the element matching `selector`, as a pasted screenshot would be. */
async function pasteImage(page: Page, selector: string) {
  await page.evaluate(async (selector) => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    canvas.getContext('2d')!.fillRect(0, 0, 120, 80);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    document.querySelector(selector)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, selector);
}

// A message typed to an agent but not sent stays that agent's: through the Overview (where its tile
// shows the same text), past another agent with its own, and across a restart. Sending clears it.
it('keeps each agent’s unsent message through the Overview, other agents and a restart', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amw-dr-')));
  const dataDir = mkdtempSync(join(tmpdir(), 'amw-drd-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const launch = async () => {
    const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, HOME: home, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_MOCK_DELAY_MS: '20', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    return { app, page };
  };
  let { app, page } = await launch();
  const inv = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<any>;
  await inv('settings:update', { onboarding: { dismissed: true }, language: 'en' });
  const dir = join(home, 'shop');
  mkdirSync(dir);
  writeFileSync(join(dir, 'README.md'), 'x');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const p = await inv('project:add', { rootPath: dir, name: 'shop' });
  const a = await inv('task:create', { projectId: p.projectId, provider: 'mock', title: 'checkout', name: 'checkout', mockScript: 'quick', instruction: 'Do.', isolate: false });
  const b = await inv('task:create', { projectId: p.projectId, provider: 'mock', title: 'login', name: 'login', mockScript: 'quick', instruction: 'Do.', isolate: false });
  await page.waitForTimeout(2000);
  let box = page.getByTestId('composer-input');
  const open = async (alias: string) => {
    await page.locator(`[data-testid="rail-item"][data-alias="${alias}"]`).click();
    await page.waitForSelector('[data-testid="composer-input"]');
  };
  const overview = () => page.getByRole('button', { name: /^Overview/ }).click();
  const tile = (alias: string) => page.locator(`[data-testid="agent-card"][data-alias="${alias}"] .tile-composer textarea`);

  // Typed on A's page, with an image waiting, then away to the Overview: the tile has the same message.
  await open(a.alias);
  await box.click();
  await page.keyboard.type('Half a thought about the');
  await pasteImage(page, '[data-testid="composer-input"]');
  await expect.poll(() => page.locator('.composer-box .attach-thumb img').count(), { timeout: 5000 }).toBe(1);
  await overview();
  await expect.poll(() => tile(a.alias).inputValue()).toBe('Half a thought about the');
  expect(await page.locator(`[data-testid="agent-card"][data-alias="${a.alias}"] .attach-thumb img`).count()).toBe(1);
  expect(await tile(b.alias).inputValue()).toBe('');
  // Added to on the tile, then back to A's page: all of it, the image, and the cursor at the end.
  await tile(a.alias).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' button');
  await open(a.alias);
  await expect.poll(() => box.inputValue()).toBe('Half a thought about the button');
  expect(await page.locator('.composer-box .attach-thumb img').count()).toBe(1);
  expect(await box.evaluate((el) => [document.activeElement === el, (el as HTMLTextAreaElement).selectionStart === (el as HTMLTextAreaElement).value.length])).toEqual([true, true]);

  // B has its own: empty at first, then what was typed to it; A's is untouched.
  await open(b.alias);
  expect(await box.inputValue()).toBe('');
  expect(await page.locator('.composer-box .attach-thumb').count()).toBe(0);
  await box.fill('!ls');
  await open(a.alias);
  expect(await box.inputValue()).toBe('Half a thought about the button');
  await open(b.alias);
  expect(await box.inputValue()).toBe('!ls');
  expect(await page.locator('.composer-box.shell-mode').count()).toBe(1);
  await box.fill('');

  // Sent from A: gone from the box and the tile, and the images with it.
  await open(a.alias);
  await box.press('Enter');
  await expect.poll(() => box.inputValue(), { timeout: 5000 }).toBe('');
  expect(await page.locator('.composer-box .attach-thumb').count()).toBe(0);
  await expect.poll(async () => (await inv('transcript:get', { taskId: a.taskId })).some((i: any) => i.role === 'user' && i.text.includes('about the button')), { timeout: 5000 }).toBe(true);
  await overview();
  expect(await tile(a.alias).inputValue()).toBe('');

  // Left unsent and the app quit: there after it starts again.
  await open(b.alias);
  await box.fill('Remember to check the redirect');
  await app.close();
  ({ app, page } = await launch());
  box = page.getByTestId('composer-input');
  await page.waitForTimeout(1000);
  await overview();
  await expect.poll(() => tile(b.alias).inputValue(), { timeout: 5000 }).toBe('Remember to check the redirect');
  await open(b.alias);
  expect(await box.inputValue()).toBe('Remember to check the redirect');
  await open(a.alias);
  expect(await box.inputValue()).toBe('');
  await app.close();
}, 180000);
