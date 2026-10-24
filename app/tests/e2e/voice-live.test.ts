// Opt-in: always-on microphone, end to end, with real OpenAI STT + routing.
// Chromium's fake capture device plays a WAV file as the microphone, so the
// on-device voice detection, segmentation, transcription and auto-routing all
// run exactly as they would for a person talking.
//   AMW_E2E_VOICE=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/voice-live.test.ts
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

/** silence · "Agent A, add a regression test…" · pause · "刚才那个数据库的 Agent，先不要改 schema" · silence */
function buildMicFixture(): string {
  const pcm = (f: string) => {
    const b = readFileSync(join(appDir, '.cache', f));
    if (b.readUInt32LE(24) !== 24_000 || b.readUInt16LE(22) !== 1) throw new Error(`${f}: expected 24 kHz mono`);
    return b.subarray(44);
  };
  const silence = (ms: number) => Buffer.alloc(Math.round((24_000 * ms) / 1000) * 2);
  const data = Buffer.concat([silence(1500), pcm('voice-0.wav'), silence(2000), pcm('voice-1.wav'), silence(6000)]);
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
  const out = join(appDir, '.cache', 'mic-fixture.wav');
  writeFileSync(out, Buffer.concat([h, data]));
  return out;
}

afterAll(async () => {
  await app?.close().catch(() => {});
});

describe.runIf(enabled)('always-on microphone', () => {
  it('hears two spoken commands without any click and routes each to the named agent', async () => {
    expect(existsSync(join(appDir, '.cache', 'voice-0.wav'))).toBe(true);
    const fixture = buildMicFixture();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      // The sandboxed audio service cannot read the fixture file; test-only.
      args: ['--disable-features=AudioServiceSandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}%noloop`, appDir],
      cwd: appDir,
      env: { ...env, AMW_MODE: 'demo', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-voice-')), AMW_MOCK_DELAY_MS: '120' },
    });
    const page: Page = await app.firstWindow();
    await page.waitForSelector('.app');
    // The demo entry seeds three mock agents on first launch.
    await expect.poll(() => page.getByTestId('agent-card').count()).toBe(3);

    // Nobody clicked the mic: it is open because the app joined "the meeting" listening.
    await expect.poll(() => page.getByTestId('mic-button').getAttribute('aria-pressed'), { timeout: 15_000 }).toBe('true');

    const toasts = () => page.getByTestId('caption').allInnerTexts().then((t) => t.join('\n'));
    await expect.poll(toasts, { timeout: 60_000 }).toMatch(/Sent to Agent A/);
    await page.screenshot({ path: join(shots, 'voice-01-live-caption.png') });
    await expect.poll(toasts, { timeout: 60_000 }).toMatch(/Sent to Agent C/);
    await page.screenshot({ path: join(shots, 'voice-02-second-command.png') });

    const transcript = (alias: string) =>
      page.evaluate(async (a) => {
        const amw = (window as unknown as { amw: { invoke(c: string, p?: unknown): Promise<unknown> } }).amw;
        const snap = (await amw.invoke('workspace:snapshot', {})) as { tasks: Array<{ alias: string; taskId: string }> };
        const t = snap.tasks.find((x) => x.alias === a)!;
        const items = (await amw.invoke('transcript:get', { taskId: t.taskId })) as Array<{ role: string; via?: string; text: string }>;
        return items.filter((i) => i.role === 'user' && i.via === 'voice').map((i) => i.text);
      }, alias);
    // Each spoken command reaches its agent exactly once.
    expect(await transcript('A')).toHaveLength(1);
    expect((await transcript('A'))[0]).toMatch(/regression test/i);
    expect(await transcript('C')).toHaveLength(1);
    expect((await transcript('C'))[0]).toMatch(/schema/i);
    expect(await transcript('B')).toEqual([]);

    // Mute really releases the microphone.
    await page.getByTestId('mic-button').click();
    await expect.poll(() => page.getByTestId('mic-button').getAttribute('aria-pressed')).toBe('false');
    await page.screenshot({ path: join(shots, 'voice-03-muted.png') });
  });
});
