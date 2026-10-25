// On-device speech-to-text inside the real Electron app, with no OpenAI key at all.
// Opt-in (needs a downloaded model in app/.models): AMW_E2E_LOCAL_STT=1
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const enabled = process.env.AMW_E2E_LOCAL_STT === '1';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;

afterAll(async () => {
  await app?.close().catch(() => {});
});

describe.runIf(enabled)('local speech-to-text', () => {
  it('transcribes with SenseVoice in the main process and restores agent names', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MODE: 'demo', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_MOCK_DELAY_MS: '50', AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-local-stt-')) },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.app');
    const invoke = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c, p), [c, p] as const);
    type Snap = { voice: { sttAvailable: boolean; sttModel?: string; localModels: Array<{ id: string; installed: boolean }> } };
    let snap = (await invoke('workspace:snapshot', {})) as Snap;
    expect(snap.voice.sttAvailable).toBe(false); // no key, nothing selected yet
    expect(snap.voice.localModels.find((m) => m.id === 'sensevoice')?.installed).toBe(true);
    await invoke('settings:update', { sttModel: 'local:sensevoice' });
    snap = (await invoke('workspace:snapshot', {})) as Snap;
    expect(snap.voice).toMatchObject({ sttAvailable: true, sttModel: 'local:sensevoice' });

    const heard = async (file: string) => {
      const bytes = [...readFileSync(join(appDir, '.cache', file))];
      return page.evaluate((arr) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<{ text: string }> } }).amw.invoke('voice:transcribe', { audio: new Uint8Array(arr), mimeType: 'audio/wav' }), bytes);
    };
    // Demo agents are Alice, Bob, Charlie.
    expect((await heard('voice-0.wav')).text).toMatch(/^Alice add a regres+ion test/);
    expect((await heard('voice-5.wav')).text).toContain('小王');
    expect((await heard('voice-7.wav')).text).toMatch(/等一下.*Charlie.*删/);
  });
});
