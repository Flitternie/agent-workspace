// Opt-in: drives the app with the user's real Claude Code and Codex (tiny prompts).
//   AMW_E2E_REAL=1 npm run test:e2e
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const enabled = process.env.AMW_E2E_REAL === '1';
const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'amw-real-'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;

function repo(): string {
  const dir = mkdtempSync(join(join(appDir, '.cache'), 'real-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# real e2e repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

async function launch(): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
  app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_DATA_DIR: dataDir, AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.waitForSelector('.app');
  return page;
}

const invoke = (page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const);
const card = (page: Page, alias: string) => page.locator(`[data-testid="agent-card"][data-alias="${alias}"]`);

afterAll(async () => {
  await app?.close().catch(() => {});
});

describe.runIf(enabled)('real providers through the app', () => {
  it('Claude + Codex in separate worktrees, native approval, voice IPC, restart + resume', async () => {
    const root = repo();
    let page = await launch();
    const project = (await invoke(page, 'project:add', { rootPath: root, name: 'real-e2e' })) as { projectId: string };

    await invoke(page, 'task:create', {
      projectId: project.projectId,
      provider: 'claude',
      name: 'claude-real',
      title: 'Claude smoke task',
      isolate: true,
      instruction: 'Remember the codeword MANGO-7. Reply with one short sentence confirming you are ready. Do not use tools.',
    });
    await invoke(page, 'task:create', {
      projectId: project.projectId,
      provider: 'codex',
      name: 'codex-real',
      title: 'Codex smoke task',
      isolate: true,
      instruction: 'Reply with one short sentence confirming you are ready. Do not run commands.',
    });
    await expect.poll(() => card(page, 'Alice').getByTestId('card-summary').innerText(), { timeout: 180_000 }).toMatch(/ready/i);
    await expect.poll(() => card(page, 'Bob').getByTestId('card-summary').innerText(), { timeout: 180_000 }).toMatch(/ready/i);
    const snap = (await invoke(page, 'workspace:snapshot', {})) as { tasks: Array<{ taskId: string; alias: string; cwd: string; worktree?: { branch: string } }> };
    const [a, b] = snap.tasks;
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.worktree?.branch).toMatch(/^amw\//);
    await page.screenshot({ path: join(shots, 'real-01-overview.png') });

    // Default mode is auto (Claude Code's classifier, as in the CLI): routine commands run without asking.
    await card(page, 'Alice').locator('textarea').fill('Use your Bash tool to run exactly: git status --short && ls . Then reply with the single word AUTO-OK.');
    await card(page, 'Alice').locator('textarea').press('Enter');
    await expect.poll(() => card(page, 'Alice').getByTestId('card-summary').innerText(), { timeout: 180_000 }).toMatch(/AUTO-OK/);
    expect(await card(page, 'Alice').locator('[data-attention-kind="approval"]').count()).toBe(0);

    // Switch the live session to "ask every time" (no restart), then a write outside the worktree must wait for the user.
    await invoke(page, 'task:setPermissionMode', { taskId: snap.tasks.find((x) => x.alias === 'Alice')!.taskId, mode: 'ask' });
    // Native approval: ask Claude to write outside its worktree; deny from the card.
    const outside = join(root, '..', `amw-outside-${Date.now()}.txt`);
    await card(page, 'Alice').locator('textarea').fill(`Use your Bash tool to run exactly: touch ${outside} . If it is denied, reply DENIED and do not retry.`);
    await card(page, 'Alice').locator('textarea').press('Enter');
    const approval = card(page, 'Alice').locator('[data-attention-kind="approval"]');
    await expect.poll(() => approval.count(), { timeout: 180_000 }).toBe(1);
    await page.screenshot({ path: join(shots, 'real-02-claude-approval.png') });
    await approval.getByRole('button', { name: 'Deny' }).click();
    await expect.poll(() => card(page, 'Alice').getByTestId('card-summary').innerText(), { timeout: 180_000 }).toMatch(/DENIED/i);
    expect(existsSync(outside)).toBe(false);

    // Voice IPC with real audio bytes (generated by the voice smoke test).
    const wav = join(appDir, '.cache', 'voice-0.wav');
    if (existsSync(wav)) {
      const bytes = [...readFileSync(wav)];
      const heard = (await page.evaluate(
        (arr) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<{ text: string }> } }).amw.invoke('voice:transcribe', { audio: new Uint8Array(arr), mimeType: 'audio/wav' }),
        bytes,
      )) as { text: string };
      expect(heard.text).toMatch(/regression test/i);
    }

    // Restart and resume Claude's native session with real context.
    await app!.close();
    page = await launch();
    await expect.poll(() => page.getByTestId('agent-card').count()).toBe(2);
    await card(page, 'Alice').getByRole('button', { name: 'Open' }).click();
    await page.getByTestId('composer-input').fill('What codeword did I ask you to remember? Reply with only the codeword.');
    await page.getByTestId('composer-input').press('Enter');
    await expect.poll(() => page.getByTestId('transcript').innerText(), { timeout: 180_000 }).toMatch(/Resumed native claude session/);
    await expect.poll(() => page.getByTestId('transcript').innerText(), { timeout: 180_000 }).toMatch(/MANGO-7[\s\S]*MANGO-7/);
    expect((await page.getByTestId('transcript').innerText()).split('Remember the codeword MANGO-7').length - 1).toBe(1);
    expect(await page.getByTestId('transcript').innerText()).not.toMatch(/▶ ?⊘ Tool\n/);
    await page.screenshot({ path: join(shots, 'real-03-claude-resumed.png') });

    // Steering: a message sent while the agent works joins the running turn (no restart),
    // and the task still finishes (it used to stay "running" after Claude folded the message in).
    type Snap = { tasks: Array<{ taskId: string; alias: string; status: string }> };
    const idOf = async (alias: string) => ((await invoke(page, 'workspace:snapshot', {})) as Snap).tasks.find((x) => x.alias === alias)!.taskId;
    const statusOf = async (alias: string) => ((await invoke(page, 'workspace:snapshot', {})) as Snap).tasks.find((x) => x.alias === alias)!.status;
    const lastReply = async (alias: string) => {
      const items = (await invoke(page, 'transcript:get', { taskId: await idOf(alias) })) as Array<{ role: string; text: string }>;
      return items.filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
    };
    const LONG = 'Run these shell commands one at a time, each as its own tool call: `sleep 6 && echo STEP1`, then `sleep 6 && echo STEP2`, then `sleep 6 && echo STEP3`. Then reply with the outputs.';
    await invoke(page, 'task:setPermissionMode', { taskId: await idOf('Alice'), mode: 'auto' });
    for (const alias of ['Alice', 'Bob']) {
      const taskId = await idOf(alias);
      await invoke(page, 'task:send', { taskId, text: LONG, via: 'text' });
      await expect.poll(() => statusOf(alias), { timeout: 60_000 }).toBe('running');
      await page.waitForTimeout(4000);
      const r = (await invoke(page, 'task:send', { taskId, text: 'Change of plan: skip any remaining sleep steps and end your reply with the word BANANA.', via: 'text' })) as { delivery?: string };
      expect(r.delivery, alias).toBe('steer');
      await expect.poll(() => lastReply(alias), { timeout: 240_000 }).toMatch(/BANANA/);
      await expect.poll(() => statusOf(alias), { timeout: 30_000 }).not.toBe('running');
    }
    await page.locator('[data-testid="rail-item"][data-alias="Bob"]').click();
    await expect.poll(() => page.getByTestId('transcript').innerText()).toMatch(/added mid-turn/);
    await page.screenshot({ path: join(shots, 'real-04-steered.png') });

    // Interrupt: stop the running turn and start over with the new message.
    for (const alias of ['Alice', 'Bob']) {
      const taskId = await idOf(alias);
      await invoke(page, 'task:send', { taskId, text: LONG, via: 'text' });
      await expect.poll(() => statusOf(alias), { timeout: 60_000 }).toBe('running');
      await page.waitForTimeout(3000);
      const r = (await invoke(page, 'task:send', { taskId, text: 'Reply with only the word KIWI.', via: 'text', interrupt: true })) as { delivery?: string };
      expect(r.delivery, alias).toBe('interrupt');
      await expect.poll(() => lastReply(alias), { timeout: 180_000 }).toMatch(/KIWI/);
      await expect.poll(() => statusOf(alias), { timeout: 30_000 }).not.toBe('running');
    }
  }, 1_200_000);
});
