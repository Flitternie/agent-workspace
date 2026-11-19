// Opt-in: sends an image to real Claude Code and Codex agents through the app (tiny prompts) and
// checks they read it; then imports the conversation again and checks the image comes back with it.
//   AMW_E2E_REAL=1 npm run test:e2e -- images-real
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImageRef, Task, TranscriptItem, WorkspaceSnapshot } from '../../src/shared/types';

const enabled = process.env.AMW_E2E_REAL === '1';
const appDir = resolve(__dirname, '../..');
mkdirSync(join(appDir, 'test-results'), { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;

afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
});

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

/** A picture of a word and a number, stored as a message box stores a pasted image. */
const drawWord = (page: Page, word: string) =>
  page.evaluate(async (word) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 240;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 640, 240);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 96px sans-serif';
    ctx.fillText(word, 40, 160);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke('attachment:save', { bytes, name: 'word.png' });
  }, word) as Promise<ImageRef>;

describe.runIf(enabled)('images to real agents', () => {
  for (const provider of ['claude', 'codex'] as const) {
    it(`${provider} reads an image sent with a message, and it comes back with the conversation`, async () => {
      mkdirSync(join(appDir, '.cache'), { recursive: true });
      const root = mkdtempSync(join(appDir, '.cache', 'img-repo-'));
      execFileSync('git', ['init', '-q'], { cwd: root });
      writeFileSync(join(root, 'README.md'), '# images e2e\n');
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
      app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-imgr-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
      await page.waitForSelector('.app');
      await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
      const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
      const settled = (id: string) => expect.poll(async () => (await snap()).tasks.find((t) => t.taskId === id)!.status, { timeout: 180_000, interval: 1000 }).toMatch(/done|idle|waiting_for_user/);
      const transcript = (id: string) => invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: id });

      const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: 'img-e2e' });
      const a = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider, title: 'Read an image', isolate: false });
      const ref = await drawWord(page, 'ZEBRA 47');
      const r = await invoke<{ ok: boolean; error?: string }>(page, 'task:send', { taskId: a.taskId, text: 'What word and number are written in the image? Reply with only them, nothing else. Do not use any tools.', via: 'text', images: [ref] });
      expect(r).toMatchObject({ ok: true });
      await settled(a.taskId);
      const reply = (await transcript(a.taskId)).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
      console.log(`[${provider}] reply:`, reply);
      expect(reply.toUpperCase()).toContain('ZEBRA');
      expect(reply).toContain('47');

      // The conversation imported again (as from another app): its image comes back from the CLI's own history.
      const s0 = await snap();
      const localId = s0.tasks.find((t) => t.taskId === a.taskId)!.sessionLocalId;
      const nativeSessionId = s0.sessions.find((s) => s.localId === localId)!.nativeSessionId;
      await invoke(page, 'task:remove', { taskId: a.taskId });
      const b = await invoke<Task>(page, 'task:importSession', { projectId: project.projectId, provider, nativeSessionId, cwd: root, title: 'Imported' });
      await invoke(page, 'task:send', { taskId: b.taskId, text: 'Reply with only: ok', via: 'text' });
      await settled(b.taskId);
      const user = (await transcript(b.taskId)).filter((i) => i.role === 'user');
      expect(user[0].images?.length).toBe(1);
      expect(user[0].images![0].id).toBeTruthy();
      await page.locator(`[data-testid="agent-card"][data-alias="${b.alias}"]`).getByRole('button', { name: 'Open' }).click();
      await expect.poll(() => page.locator('[data-testid="msg-images"] img').evaluateAll((imgs) => imgs.length > 0 && imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)), { timeout: 10_000 }).toBe(true);
      await page.screenshot({ path: join(appDir, 'test-results', `images-real-${provider}.png`) });
    }, 420_000);
  }
});
