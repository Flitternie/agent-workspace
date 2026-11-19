import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

// Typing @ in an agent's box lists the files in its folder; choosing one puts @path in the message.
it('@ lists the agent’s files, filters as you type, and inserts the chosen path', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amw-at-')));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, HOME: home, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-atd-')), AMW_MOCK_DELAY_MS: '20', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.app');
  const inv = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<any>;
  await inv('settings:update', { onboarding: { dismissed: true } });
  const dir = join(home, 'shop');
  mkdirSync(join(dir, 'src', 'checkout'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'x');
  writeFileSync(join(dir, 'src', 'checkout', 'Button.tsx'), 'x');
  writeFileSync(join(dir, 'src', 'checkout', 'Cart.tsx'), 'x');
  writeFileSync(join(dir, 'src', 'index.ts'), 'x');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  // A folder beside the project, reached with ../
  mkdirSync(join(home, 'shared'));
  writeFileSync(join(home, 'shared', 'tokens.css'), 'x');
  const p = await inv('project:add', { rootPath: dir, name: 'shop' });
  const a = await inv('task:create', { projectId: p.projectId, provider: 'mock', title: 'checkout', name: 'checkout', mockScript: 'quick', isolate: false });
  await page.getByTestId('agent-card').first().dblclick();
  const box = page.getByTestId('composer-input');
  await box.click();

  await box.pressSequentially('Fix @');
  await expect.poll(() => page.getByTestId('mention-item').allInnerTexts(), { timeout: 5000 }).toEqual(['src/', 'README.md']);
  await box.pressSequentially('butt');
  await expect.poll(() => page.getByTestId('mention-item').first().innerText(), { timeout: 5000 }).toMatch(/Button\.tsx/);
  await box.press('Enter');
  await expect.poll(() => box.inputValue()).toBe('Fix @src/checkout/Button.tsx ');
  await expect.poll(() => page.getByTestId('mention-pop').count()).toBe(0);

  // A folder goes in and keeps the list open inside it; ↓ and Tab pick; Escape closes it.
  await box.pressSequentially('and @src/');
  await expect.poll(() => page.getByTestId('mention-item').allInnerTexts(), { timeout: 5000 }).toEqual([expect.stringMatching(/checkout/), expect.stringMatching(/index\.ts/)]);
  await box.press('ArrowDown');
  await box.press('Tab');
  await expect.poll(() => box.inputValue()).toBe('Fix @src/checkout/Button.tsx and @src/index.ts ');
  await box.pressSequentially('@');
  await expect.poll(() => page.getByTestId('mention-pop').count(), { timeout: 5000 }).toBe(1);
  await box.press('Escape');
  await expect.poll(() => page.getByTestId('mention-pop').count()).toBe(0);
  await box.press('Backspace');
  // The mentions are marked in the box; Backspace right after one removes it whole.
  await expect.poll(() => page.locator('.composer-mirror mark').allInnerTexts()).toEqual(['@src/checkout/Button.tsx', '@src/index.ts']);
  await box.press('Backspace'); // the space after it
  await box.press('Backspace'); // the whole @src/index.ts
  await expect.poll(() => box.inputValue()).toBe('Fix @src/checkout/Button.tsx and ');

  // ./ is the agent's own folder, written explicitly.
  await box.pressSequentially('@./');
  await expect.poll(() => page.getByTestId('mention-item').allInnerTexts(), { timeout: 5000 }).toEqual(['src/', 'README.md']);
  await box.press('Escape');
  await box.press('Backspace'); // the whole @./
  await expect.poll(() => box.inputValue()).toBe('Fix @src/checkout/Button.tsx and ');

  // Typed with a Chinese input method: ＠。、 means @./ and the path goes in half-width.
  await box.pressSequentially('＠。、src、ind');
  await expect.poll(() => page.getByTestId('mention-item').allInnerTexts(), { timeout: 5000 }).toEqual([expect.stringMatching(/^index\.ts/)]);
  await box.press('Enter');
  await expect.poll(() => box.inputValue()).toBe('Fix @src/checkout/Button.tsx and @./src/index.ts ');
  for (let i = 0; i < 2; i++) await box.press('Backspace');
  await expect.poll(() => box.inputValue()).toBe('Fix @src/checkout/Button.tsx and ');

  // ../ browses the folder above, one level at a time.
  await box.pressSequentially('@../');
  await expect.poll(() => page.getByTestId('mention-item').allInnerTexts(), { timeout: 5000 }).toEqual(expect.arrayContaining([expect.stringMatching(/^shared\//)]));
  await box.pressSequentially('sha');
  await box.press('Enter');
  await expect.poll(() => page.getByTestId('mention-item').allInnerTexts(), { timeout: 5000 }).toEqual([expect.stringMatching(/tokens\.css/)]);
  await box.press('Enter');
  await expect.poll(() => box.inputValue()).toBe('Fix @src/checkout/Button.tsx and @../shared/tokens.css ');

  // A file (not an image) given to the box, as when dropped or picked: its @path goes in at the caret.
  await page.locator('.composer input[type="file"]').setInputFiles([join(dir, 'src', 'checkout', 'Cart.tsx'), join(home, 'shared', 'tokens.css')]);
  await expect.poll(() => box.inputValue(), { timeout: 5000 }).toBe('Fix @src/checkout/Button.tsx and @../shared/tokens.css @src/checkout/Cart.tsx @~/shared/tokens.css ');
  await box.fill('Fix @src/checkout/Button.tsx and @../shared/tokens.css ');

  // Sent: the path goes as written, and shows as chips in the conversation.
  await box.press('Enter');
  await expect.poll(async () => (await inv('transcript:get', { taskId: a.taskId })).find((i: any) => i.role === 'user')?.text, { timeout: 5000 }).toBe('Fix @src/checkout/Button.tsx and @../shared/tokens.css');
  await expect.poll(() => page.getByTestId('mention-chip').allInnerTexts(), { timeout: 5000 }).toEqual(['Button.tsx', 'tokens.css']);
  expect(await page.getByTestId('mention-chip').first().getAttribute('title')).toBe('src/checkout/Button.tsx');
  // A word that matches nothing: the list does not open (no "Looking…" flash).
  await box.fill('');
  await box.pressSequentially('@zzzq');
  await page.waitForTimeout(600);
  expect(await page.getByTestId('mention-pop').count()).toBe(0);
  await app.close();
}, 120000);
