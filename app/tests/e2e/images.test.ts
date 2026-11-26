import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type Page } from 'playwright-core';
import { expect, it } from 'vitest';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

/** Pastes a drawn image (w×h) into the element matching `selector`, as a screenshot pasted from the clipboard would be. */
async function pasteImage(page: Page, selector: string, w: number, h: number, colour: string) {
  await page.evaluate(
    async ([selector, w, h, colour]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w as number;
      canvas.height = h as number;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = colour as string;
      ctx.fillRect(0, 0, w as number, h as number);
      ctx.fillStyle = '#fff';
      ctx.fillRect((w as number) / 4, (h as number) / 4, (w as number) / 2, (h as number) / 2);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const data = new DataTransfer();
      data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
      const el = document.querySelector(selector as string)!;
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [selector, w, h, colour] as const,
  );
}

// Images pasted into a message box go with the message: thumbnails first, then in the conversation,
// and the agent gets them. A too-large one is shrunk before it is stored.
it('pastes images into an agent’s box and a tile’s box, and sends them with the message', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amw-img-')));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, HOME: home, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-imgd-')), AMW_MOCK_DELAY_MS: '20', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.app');
  const inv = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<any>;
  await inv('settings:update', { onboarding: { dismissed: true }, language: 'zh' });
  const dir = join(home, 'shop');
  mkdirSync(dir);
  writeFileSync(join(dir, 'README.md'), 'x');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const p = await inv('project:add', { rootPath: dir, name: 'shop' });
  const a = await inv('task:create', { projectId: p.projectId, provider: 'mock', title: 'checkout', name: '结账页', mockScript: 'quick', isolate: false });
  await page.waitForTimeout(500);

  // On the tile: paste, a thumbnail, send.
  await pasteImage(page, '[data-testid="agent-card"] .tile-composer textarea', 320, 200, '#2563eb');
  await expect.poll(() => page.locator('.tile-composer .attach-thumb img').count(), { timeout: 5000 }).toBe(1);
  await page.locator('[data-testid="agent-card"] .tile-composer textarea').fill('这个按钮颜色对吗？');
  await page.screenshot({ path: join(appDir, 'test-results', 'images-1-tile.png') });
  await page.locator('[data-testid="agent-card"] .tile-composer textarea').press('Enter');
  await expect.poll(() => page.locator('.tile-composer .attach-thumb').count(), { timeout: 5000 }).toBe(0);
  await expect.poll(async () => (await inv('transcript:get', { taskId: a.taskId })).find((i: any) => i.role === 'user')?.images?.length ?? 0, { timeout: 5000 }).toBe(1);

  // On the agent's page: a large screenshot is shrunk, and two images go in one message.
  await page.getByTestId('agent-card').first().dblclick();
  await page.waitForSelector('[data-testid="composer-input"]');
  await pasteImage(page, '[data-testid="composer-input"]', 4000, 3000, '#16a34a');
  await pasteImage(page, '[data-testid="composer-input"]', 600, 400, '#dc2626');
  await expect.poll(() => page.locator('.composer-box .attach-thumb img').count(), { timeout: 8000 }).toBe(2);
  const widths = await page.locator('.composer-box .attach-thumb img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth));
  expect(widths).toEqual([2000, 600]);
  // The remove button's × sits in the middle of its circle.
  await page.locator('.composer-box .attach-thumb').first().hover();
  const centre = await page.locator('.composer-box .attach-remove').first().evaluate((b) => {
    const r = b.getBoundingClientRect();
    const i = b.querySelector('svg')!.getBoundingClientRect();
    return [r.x + r.width / 2 - (i.x + i.width / 2), r.y + r.height / 2 - (i.y + i.height / 2)].map((d) => Math.abs(Math.round(d)));
  });
  expect(centre).toEqual([0, 0]);
  await page.screenshot({ path: join(appDir, 'test-results', 'images-2-composer.png') });
  await page.getByTestId('composer-input').press('Enter');
  await expect.poll(() => page.locator('[data-testid="msg-images"] img').count(), { timeout: 8000 }).toBe(3);
  // They load from the app's store.
  await expect.poll(() => page.locator('[data-testid="msg-images"] img').evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)), { timeout: 5000 }).toBe(true);
  const sent = (await inv('transcript:get', { taskId: a.taskId })).filter((i: any) => i.role === 'user');
  expect(sent.map((i: any) => i.images?.length)).toEqual([1, 2]);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(appDir, 'test-results', 'images-3-sent.png') });
  await page.locator('[data-testid="msg-images"] button').first().click();
  await expect.poll(() => page.getByTestId('image-lightbox').count()).toBe(1);
  await page.screenshot({ path: join(appDir, 'test-results', 'images-4-lightbox.png') });
  await page.keyboard.press('Escape');
  await expect.poll(() => page.getByTestId('image-lightbox').count()).toBe(0);
  await app.close();
}, 120000);
