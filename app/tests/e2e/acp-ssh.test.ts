// Opt-in: OpenCode / Antigravity agents on a real SSH host. In a scratch folder there (removed afterwards):
// detected on the host, a reply, the model list, a command whose connection is killed mid-run (the local
// ssh killed outright, as when the laptop sleeps) still finishing, the conversation going on, a restart
// resuming it there, and nothing of the app left running on the host after quitting.
//   AMW_E2E_SSH_HOST=<alias> [AMW_E2E_ACP_ONLY=opencode|antigravity] npm run test:e2e -- acp-ssh
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { AttentionItem, Task, TranscriptItem, WorkspaceSnapshot } from '../../src/shared/types';

const host = process.env.AMW_E2E_SSH_HOST ?? '';
const only = process.env.AMW_E2E_ACP_ONLY;
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
const remote = (cmd: string) => execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', '--', host, cmd], { encoding: 'utf8', timeout: 60_000 }).trim();
const attachments = () => {
  try {
    return execFileSync('pgrep', ['-f', 'agent-workspace/run.*tail -c'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

let app: ElectronApplication | undefined;
const scratches: string[] = [];
afterAll(async () => {
  await app?.close().catch(() => {});
  for (const s of scratches) remote(`rm -rf ~/${s}`);
});

describe.runIf(host).each(['opencode', 'antigravity'].filter((p) => !only || p === only))('%s on an SSH host', (provider) => {
  it('works there, survives a dropped connection, resumes after a restart, leaves nothing behind', async () => {
    const scratch = `amw-acp-e2e-${provider}-${Date.now().toString(36)}`;
    scratches.push(scratch);
    remote(`mkdir -p ~/${scratch} && cd ~/${scratch} && git init -q && echo hi > README.md`);
    // Runs already on the host (the user's own app may have some): only this test's are checked at the end.
    const runsNow = () => remote('ls ~/.cache/agent-workspace/run 2>/dev/null || true').split('\n').filter(Boolean);
    const before = new Set(runsNow());
    const dataDir = mkdtempSync(join(tmpdir(), `amw-acpssh-${provider}-`));
    const launch = async () => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
      app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
      const page = await app.firstWindow();
      await page.waitForSelector('.app');
      return page;
    };
    let page = await launch();
    await invoke(page, 'settings:update', { onboarding: { dismissed: true }, permissionMode: 'auto', language: 'en' });
    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    await invoke(page, 'ssh:setEnabled', { host, enabled: true });
    const hostStatus = async () => ((await snap()) as unknown as { remoteHosts: Array<{ host: string; ssh: string; capabilities: Array<{ provider: string; available: boolean; version?: string }> }> }).remoteHosts.find((h) => h.host === host);
    await expect.poll(async () => (await hostStatus())?.ssh, { timeout: 60_000 }).toBe('ok');
    // Detected on the host.
    await expect.poll(async () => (await hostStatus())?.capabilities.find((c) => c.provider === provider)?.available, { timeout: 60_000 }).toBe(true);
    console.log(`[${provider} on ${host}] version:`, (await hostStatus())?.capabilities.find((c) => c.provider === provider)?.version);

    const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: `~/${scratch}`, host });
    const t = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider, title: `${provider} on ${host}`, isolate: false });
    const taskOf = async () => (await snap()).tasks.find((x) => x.taskId === t.taskId)!;
    const items = () => invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: t.taskId });
    const reply = async () => (await items()).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
    const settled = () => expect.poll(async () => (await taskOf()).status, { timeout: 240_000, interval: 1000 }).toMatch(/done|idle|waiting_for_user|failed/);
    const send = async (text: string) => {
      const r = await invoke<{ ok: boolean; error?: string }>(page, 'task:send', { taskId: t.taskId, text, via: 'text' });
      if (!r.ok) throw new Error(`send failed: ${r.error}`);
    };
    // Approves whatever it asks (a command needs approval on OpenCode in any mode).
    const approving = setInterval(async () => {
      try {
        const card = (await snap()).attention.find((a) => a.taskId === t.taskId && a.state === 'open' && a.kind === 'approval') as AttentionItem | undefined;
        const opt = card?.options?.find((o) => o.kind === 'allow_once') ?? card?.options?.find((o) => /allow/i.test(o.label));
        if (card && opt) await invoke(page, 'attention:respond', { attentionId: card.id, decision: opt.id });
      } catch {
        /* between pages */
      }
    }, 1000);
    try {
      // 1. A reply.
      await send('Reply with only the word: pong');
      await settled();
      console.log(`[${provider}] reply 1:`, await reply(), '| status', (await taskOf()).status, (await taskOf()).summary);
      expect((await reply()).toLowerCase()).toContain('pong');
      // 2. Its models, from the host.
      const models = await invoke<Array<{ id: string }>>(page, 'task:models', { taskId: t.taskId });
      console.log(`[${provider}] models on the host:`, models.length);
      expect(models.length).toBeGreaterThan(0);
      // 3. A command whose connection is killed mid-run.
      await send('Run exactly this shell command in the foreground and wait for it: `python3 -c "import time; time.sleep(25); print(\\"OTTER-\\" + str(40 + 43))"`. Then reply with only its output.');
      await expect.poll(async () => (await items()).some((i) => i.role === 'tool' && i.toolStatus === 'running'), { timeout: 180_000, interval: 500 }).toBe(true);
      await new Promise((r) => setTimeout(r, 4000));
      const killed = attachments();
      expect(killed.length).toBeGreaterThan(0);
      execFileSync('kill', ['-9', ...killed]);
      await settled();
      console.log(`[${provider}] reply after the drop:`, await reply());
      expect(await reply()).toContain('OTTER-83');
      // 4. The conversation goes on.
      await send('Reply with only the word KESTREL. Do not use any tools.');
      await settled();
      expect(await reply()).toContain('KESTREL');
    } finally {
      clearInterval(approving);
    }
    // 5. A restart: it resumes the same conversation on the host.
    await app!.close();
    page = await launch();
    await send('What word did you reply with just before this message? Reply with only that word. Do not use any tools.');
    await settled();
    console.log(`[${provider}] reply after restart:`, await reply());
    expect(await reply()).toContain('KESTREL');
    // 6. Quitting stops it on the host.
    await app!.close();
    app = undefined;
    const ours = runsNow().filter((d) => !before.has(d));
    const alive = () =>
      remote(`cd ~/.cache/agent-workspace/run 2>/dev/null || exit 0; for d in ${ours.join(' ') || 'none'}; do [ -f "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null && echo "$d"; done; true`);
    await expect.poll(alive, { timeout: 20_000, interval: 1000 }).toBe('');
  }, 900_000);
});
