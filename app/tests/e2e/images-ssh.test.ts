// Opt-in: images to Claude Code and Codex agents on an SSH host (Claude gets base64 blocks over the
// session's stream, Codex a data URL). Works in a scratch folder on the host, removed afterwards with
// the sessions it made there.
//   AMW_E2E_SSH_HOST=<alias from ~/.ssh/config> npm run test:e2e -- images-ssh
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { ImageRef, Task, TranscriptItem, WorkspaceSnapshot } from '../../src/shared/types';

const host = process.env.AMW_E2E_SSH_HOST ?? '';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
const scratch = `amw-img-e2e-${Date.now().toString(36)}`;
const remote = (cmd: string) => execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', '--', host, cmd], { encoding: 'utf8', timeout: 60_000 }).trim();
let app: ElectronApplication | undefined;
const threads: string[] = [];

afterAll(async () => {
  await app?.close().catch(() => {});
  if (!host) return;
  // Only what this test made: its folder, Claude's project folder for it, Codex's rollouts of its threads.
  remote(`rm -rf ~/${scratch} ~/.claude/projects/*${scratch}`);
  for (const id of threads) if (/^[0-9a-f-]{20,}$/.test(id)) remote(`find ~/.codex/sessions -name '*${id}.jsonl' -delete 2>/dev/null; true`);
});

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

describe.runIf(host)('images to agents on an SSH host', () => {
  it('Claude Code and Codex there read an image sent from this Mac', async () => {
    remote(`mkdir -p ~/${scratch} && cd ~/${scratch} && git init -q && echo hi > README.md`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-imgssh-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
    const page = await app.firstWindow();
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    await invoke(page, 'ssh:setEnabled', { host, enabled: true });
    await expect.poll(async () => ((await snap()) as unknown as { remoteHosts: Array<{ host: string; ssh: string }> }).remoteHosts.find((h) => h.host === host)?.ssh, { timeout: 60_000 }).toBe('ok');
    const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: `~/${scratch}`, host });

    const ref = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 240;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 640, 240);
      ctx.fillStyle = '#111';
      ctx.font = 'bold 96px sans-serif';
      ctx.fillText('OTTER 83', 40, 160);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      return (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke('attachment:save', { bytes: new Uint8Array(await blob.arrayBuffer()), name: 'word.png' });
    }) as ImageRef;

    for (const provider of ['claude', 'codex'] as const) {
      const t = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider, title: `Image on ${host}`, isolate: false });
      const r = await invoke<{ ok: boolean; error?: string }>(page, 'task:send', { taskId: t.taskId, text: 'What word and number are written in the image? Reply with only them, nothing else. Do not use any tools.', via: 'text', images: [ref] });
      expect(r, provider).toMatchObject({ ok: true });
      await expect.poll(async () => (await snap()).tasks.find((x) => x.taskId === t.taskId)!.status, { timeout: 240_000, interval: 1000 }).toMatch(/done|idle|waiting_for_user/);
      const reply = (await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: t.taskId })).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
      console.log(`[${provider} on ${host}] reply:`, reply);
      const s = await snap();
      const localId = s.tasks.find((x) => x.taskId === t.taskId)!.sessionLocalId;
      const native = s.sessions.find((x) => x.localId === localId)?.nativeSessionId;
      if (provider === 'codex' && native) threads.push(native);
      expect(reply.toUpperCase(), provider).toContain('OTTER');
      expect(reply, provider).toContain('83');
    }
  }, 600_000);
});
