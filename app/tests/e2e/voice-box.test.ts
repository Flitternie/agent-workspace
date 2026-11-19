// On an agent's page what is said appears in the agent's own box (the voice bar has no box there).
// The speech itself needs a model; here the voice bar's events stand in for it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

it('what is said shows in the agent’s box, is kept to check or let go, and typing takes it over', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amw-vb-')));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, HOME: home, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-vbd-')), AMW_MOCK_DELAY_MS: '20', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.app');
    const inv = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<any>;
    await inv('settings:update', { onboarding: { dismissed: true } });
    const dir = join(home, 'shop'); mkdirSync(dir); writeFileSync(join(dir, 'README.md'), 'x'); execFileSync('git', ['init', '-q'], { cwd: dir });
    const p = await inv('project:add', { rootPath: dir, name: 'shop' });
    const a = await inv('task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', mockScript: 'quick', instruction: 'Do.', isolate: false });
    await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"]`).click();
    const box = page.getByTestId('composer-input');
    await box.waitFor();
    // No voice bar here: one box, the mic beside it.
    expect(await page.getByTestId('dock-input').count()).toBe(0);
    expect(await page.locator('.composer [data-testid="mic-button"]').count()).toBe(1);
    const say = (text: string, phase: string) => page.evaluate(([taskId, text, phase]) => window.dispatchEvent(new CustomEvent('amw:voice-draft', { detail: { taskId, text, phase } })), [a.taskId, text, phase] as const);
    // Typed first, then spoken: the spoken part follows what was typed, live.
    await box.fill('Also');
    await say('add a totals row', 'listening');
    await expect.poll(() => box.inputValue()).toBe('Also add a totals row');
    expect(await page.locator('.composer-box.voice-live').count()).toBe(1);
    await say('add a totals row please', 'listening');
    await expect.poll(() => box.inputValue()).toBe('Also add a totals row please');
    // Let go (sent at once, or for someone else): back to what was typed.
    await say('', 'drop');
    await expect.poll(() => box.inputValue()).toBe('Also');
    expect(await page.locator('.composer-box.voice-live').count()).toBe(0);
    // Kept to check: it stays, ready to send with Enter.
    await say('and run the tests', 'listening');
    await say('and run the tests', 'keep');
    await expect.poll(() => box.inputValue()).toBe('Also and run the tests');
    expect(await page.locator('.composer-box.voice-live').count()).toBe(0);
    // Typing while something is being said takes it over: the voice bar is told, the text stays.
    await box.fill('');
    await page.evaluate(() => ((window as any).__taken = 0, window.addEventListener('amw:voice-taken', () => (window as any).__taken++)));
    await say('stop after this', 'listening');
    await expect.poll(() => box.inputValue()).toBe('stop after this');
    await box.press('End');
    await box.type('!');
    await expect.poll(() => page.evaluate(() => (window as any).__taken)).toBe(1);
    expect(await box.inputValue()).toBe('stop after this!');
    await say('', 'drop'); // a late "let go" no longer clears it
    expect(await box.inputValue()).toBe('stop after this!');
  } finally {
    await app.close();
  }
}, 120000);
