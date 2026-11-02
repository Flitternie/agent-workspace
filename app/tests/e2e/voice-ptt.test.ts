// Opt-in: push to talk, end to end, with real speech-to-text + routing.
// Chromium's fake capture device plays a WAV file as the microphone from the moment
// the app opens it, so holding the shortcut "speaks" the file.
//   AMW_E2E_VOICE=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/voice-ptt.test.ts
// Needs the TTS fixtures from `npm run smoke:voice` (.cache/voice-0.wav, voice-1.wav).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const enabled = process.env.AMW_E2E_VOICE === '1';
const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;

/** "Alice, add a regression test…" · a pause longer than the always-on send hold · "刚才那个数据库的 Agent，先不要改 schema". */
function buildMicFixture(): string {
  const pcm = (f: string) => readFileSync(join(appDir, '.cache', f)).subarray(44);
  const silence = (ms: number) => Buffer.alloc(Math.round((24_000 * ms) / 1000) * 2);
  const data = Buffer.concat([silence(500), pcm('voice-0.wav'), silence(3500), pcm('voice-1.wav'), silence(6000)]);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24_000, 24);
  h.writeUInt32LE(48_000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  const out = join(appDir, '.cache', 'mic-fixture-ptt.wav');
  writeFileSync(out, Buffer.concat([h, data]));
  return out;
}

afterAll(async () => {
  await app?.close().catch(() => {});
});

describe.runIf(enabled)('push to talk', () => {
  it('keeps the mic off until the shortcut is held, and sends everything said while held as one message', async () => {
    expect(existsSync(join(appDir, '.cache', 'voice-0.wav'))).toBe(true);
    const fixture = buildMicFixture();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-ptt-'));
    app = await electron.launch({
      executablePath: electronPath,
      args: ['--disable-features=AudioServiceSandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}%noloop`, appDir],
      cwd: appDir,
      env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_MOCK_DELAY_MS: '120', AMW_NO_AUTOLISTEN: '1' },
    });
    const page: Page = await app.firstWindow();
    await page.waitForSelector('.app');
    await expect.poll(() => page.getByTestId('agent-card').count()).toBe(3);
    const invoke = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [c, p] as const);
    await invoke('settings:update', { micMode: 'hold', micShortcut: 'Alt+Space' });

    const mic = page.getByTestId('mic-button');
    const label = () => page.locator('.mic-label').innerText();
    await page.waitForTimeout(3000);
    expect(await mic.getAttribute('aria-pressed')).toBe('false');
    await expect.poll(label).toMatch(/Hold ⌥Space to talk/);

    // Hold ⌥Space through both sentences and the pause between them, then let go.
    await page.keyboard.down('Alt');
    await page.keyboard.down('Space');
    await expect.poll(() => mic.getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('true');
    await expect.poll(label).toMatch(/let go to send|Hearing you/);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(shots, 'ptt-01-holding.png') });
    await page.waitForTimeout(9000);
    await page.keyboard.up('Space');
    await page.keyboard.up('Alt');
    await expect.poll(() => mic.getAttribute('aria-pressed')).toBe('false');

    const toasts = () => page.getByTestId('caption').allInnerTexts().then((t) => t.join('\n'));
    await expect.poll(toasts, { timeout: 60_000 }).toMatch(/Sent to (\w+ )?Alice/);
    await page.screenshot({ path: join(shots, 'ptt-02-sent.png') });

    const voiceMessages = () =>
      page.evaluate(async () => {
        const amw = (window as unknown as { amw: { invoke(c: string, p?: unknown): Promise<unknown> } }).amw;
        const snap = (await amw.invoke('workspace:snapshot', {})) as { tasks: Array<{ alias: string; taskId: string }> };
        const out: string[] = [];
        for (const t of snap.tasks) {
          const items = (await amw.invoke('transcript:get', { taskId: t.taskId })) as Array<{ role: string; via?: string; text: string }>;
          out.push(...items.filter((i) => i.role === 'user' && i.via === 'voice').map((i) => `${t.alias}: ${i.text}`));
        }
        return out;
      });
    // One message with both sentences: the pause did not send the first half.
    await page.waitForTimeout(3000);
    const sent = await voiceMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Alice: .*regression test/i);
    expect(sent[0]).toMatch(/schema/i);

    // A quick tap is not speech: nothing is sent, and the bar says to hold.
    await page.keyboard.down('Alt');
    await page.keyboard.down('Space');
    await page.waitForTimeout(80);
    await page.keyboard.up('Space');
    await page.keyboard.up('Alt');
    await expect.poll(label).toMatch(/Hold ⌥Space while you talk/);
    expect(await mic.getAttribute('aria-pressed')).toBe('false');

    // The shortcut and mode can be changed in Settings.
    await page.getByRole('button', { name: /Settings/ }).first().click();
    await page.getByTestId('mic-mode-toggle').click();
    await page.getByTestId('mic-shortcut').click();
    await page.keyboard.press('Meta+Shift+KeyK');
    await expect.poll(() => page.getByTestId('mic-shortcut').innerText()).toMatch(/⇧\s*⌘\s*K/);
    await page.getByTestId('settings-voice').screenshot({ path: join(shots, 'ptt-03-settings.png') });
    expect(((await invoke('workspace:snapshot', {})) as { settings: { micMode: string; micShortcut: string } }).settings).toMatchObject({ micMode: 'toggle', micShortcut: 'Meta+Shift+K' });
    await page.keyboard.press('Escape');

    // Toggle: press once to open the mic, again to close it.
    await page.keyboard.press('Meta+Shift+KeyK');
    await expect.poll(() => mic.getAttribute('aria-pressed'), { timeout: 10_000 }).toBe('true');
    await page.waitForTimeout(1500);
    await page.keyboard.press('Meta+Shift+KeyK');
    await expect.poll(() => mic.getAttribute('aria-pressed')).toBe('false');
  }, 180_000);
});
