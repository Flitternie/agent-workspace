// Opt-in: every agent feature of the app against the real OpenCode and Antigravity CLIs, through the
// app (tiny prompts; the CLIs' own sign-in, in the user's real home folder; app data in a temp folder).
//   AMW_E2E_ACP_REAL=1 [AMW_E2E_ACP=opencode|antigravity] npm run test:e2e -- acp-real
// Each step is recorded (passed or failed, with what was observed) in test-results/acp-real-<id>.json;
// a failed step does not stop the others, and the test fails at the end if any did.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { AttentionItem, ImageRef, Task, TranscriptItem, WorkspaceSnapshot } from '../../src/shared/types';

const enabled = process.env.AMW_E2E_ACP_REAL === '1';
const only = process.env.AMW_E2E_ACP;
const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
const cleanup: string[] = [];
afterAll(async () => {
  await app?.close().catch(() => {});
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

const SETUPS = {
  // A free model to switch to (the default is another free one).
  // `vision`: a model that reads images, for the image step (the default may not; that is the model, not the CLI).
  opencode: { label: 'OpenCode', other: 'opencode/deepseek-v4.1-flash-free', vision: 'opencode/nemotron-3.5-super-vl-free' },
  antigravity: { label: 'Antigravity', other: 'gemini-3.8-flash', vision: undefined },
} as const;

async function launch(dataDir: string): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
  app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  await page.waitForSelector('.app');
  return page;
}

describe.runIf(enabled)('ACP agents with the real CLIs', () => {
  for (const id of Object.keys(SETUPS) as Array<keyof typeof SETUPS>) {
    it.runIf(!only || only === id)(`${id}: every agent feature through the app`, async () => {
      const setup = SETUPS[id];
      const results: Array<{ step: string; ok: boolean; evidence: string }> = [];
      const out = join(shots, `acp-real-${id}.json`);
      const save = () => writeFileSync(out, JSON.stringify(results, null, 2));
      let prompts = 0;
      async function step(name: string, fn: () => Promise<string>): Promise<void> {
        const t0 = Date.now();
        try {
          const evidence = await fn();
          results.push({ step: name, ok: true, evidence });
          console.log(`[${id}] ok   ${name} (${Math.round((Date.now() - t0) / 1000)}s): ${evidence}`);
        } catch (error) {
          results.push({ step: name, ok: false, evidence: String((error as Error).message ?? error).slice(0, 800) });
          console.log(`[${id}] FAIL ${name}: ${(error as Error).message}`);
          await page.screenshot({ path: join(shots, `acp-real-${id}-fail-${results.length}.png`) }).catch(() => {});
        }
        save();
      }

      mkdirSync(join(appDir, '.cache'), { recursive: true });
      const root = realpathSync(mkdtempSync(join(appDir, '.cache', `acp-${id}-`)));
      cleanup.push(root);
      execFileSync('git', ['init', '-q'], { cwd: root });
      writeFileSync(join(root, 'README.md'), '# acp e2e\n');
      writeFileSync(join(root, 'notes.txt'), 'The secret fruit is PAPAYA-5.\n');
      execFileSync('git', ['add', '.'], { cwd: root });
      execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: root });
      const dataDir = mkdtempSync(join(tmpdir(), `amw-acp-real-${id}-`));
      cleanup.push(dataDir);
      let page = await launch(dataDir);
      await invoke(page, 'settings:update', { onboarding: { dismissed: true }, permissionMode: 'ask', language: 'en' });
      const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: `acp-${id}` });
      const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
      const nativeOf = async (taskId: string) => {
        const t = await taskOf(taskId);
        return (await snap()).sessions.find((s) => s.localId === t.sessionLocalId)?.nativeSessionId;
      };
      const transcript = (taskId: string) => invoke<TranscriptItem[]>(page, 'transcript:get', { taskId });
      const taskOf = async (taskId: string) => (await snap()).tasks.find((t) => t.taskId === taskId)!;
      const lastReply = async (taskId: string) => (await transcript(taskId)).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
      const settled = (taskId: string, ms = 240_000) => expect.poll(async () => (await taskOf(taskId)).status, { timeout: ms, interval: 1000 }).toMatch(/done|idle|failed/);
      const openCard = async (taskId: string) => (await snap()).attention.find((a) => a.taskId === taskId && a.state === 'open' && a.kind === 'approval');
      const waitCard = (taskId: string, ms = 180_000) => expect.poll(async () => !!(await openCard(taskId)), { timeout: ms, interval: 1000 }).toBe(true);
      const send = async (taskId: string, text: string, extra: Record<string, unknown> = {}) => {
        prompts++;
        const r = await invoke<{ ok: boolean; error?: string; delivery?: string }>(page, 'task:send', { taskId, text, via: 'text', ...extra });
        if (!r.ok) throw new Error(`send failed: ${r.error}`);
        return r;
      };
      /** Answers the open approval card by the kind of option. */
      const answer = async (taskId: string, kind: 'allow_once' | 'reject_once') => {
        const card = (await openCard(taskId)) as AttentionItem;
        const opt = card.options!.find((o) => o.kind === kind) ?? card.options!.find((o) => (kind === 'allow_once' ? /allow/i : /deny|reject/i).test(o.label));
        await invoke(page, 'attention:respond', { attentionId: card.id, decision: opt!.id });
        return card;
      };

      // Installed and detected.
      await expect.poll(async () => (await snap()).capabilities.find((c) => c.provider === id)?.available, { timeout: 60_000 }).toBe(true);
      const caps = (await snap()).capabilities.find((c) => c.provider === id)!;
      results.push({ step: 'detected', ok: true, evidence: `${caps.version} · ${caps.detail}` });

      // 1. New agent dialog, first message, streamed reply, thoughts, usage.
      let taskId = '';
      /** The agent's folder (its own worktree, as the dialog makes by default). */
      let work = root;
      await step('create from New agent dialog', async () => {
        await page.getByTestId('new-task').first().click();
        const dialog = page.getByRole('dialog');
        await dialog.getByText(setup.label, { exact: true }).first().click();
        // In the project folder itself, so "Continue a session" finds its conversation there later.
        await dialog.getByText('Run in its own git worktree').click();
        await page.screenshot({ path: join(shots, `acp-real-${id}-new-agent.png`) });
        await dialog.getByTestId('create-agent').click();
        await expect.poll(async () => (await snap()).tasks.find((t) => t.provider === id)?.taskId, { timeout: 60_000 }).toBeTruthy();
        taskId = (await snap()).tasks.find((t) => t.provider === id)!.taskId;
        work = (await taskOf(taskId)).cwd;
        return `task ${taskId} in ${work}`;
      });
      await step('first message, streamed reply, thoughts, usage', async () => {
        const input = page.getByTestId('composer-input');
        await input.fill('Remember the codeword KIWI-7. Reply with only: pong');
        prompts++;
        await input.press('Enter');
        // Streaming: the reply shows before the turn ends or right as it does.
        await page.getByTestId('transcript').getByText(/pong/i).first().waitFor({ timeout: 240_000 });
        await settled(taskId);
        const items = await transcript(taskId);
        const t = await taskOf(taskId);
        await page.screenshot({ path: join(shots, `acp-real-${id}-first.png`) });
        const ctx = await page.getByTestId('usage-context').first().innerText().catch(() => '(no context chip)');
        expect((await lastReply(taskId)).toLowerCase()).toContain('pong');
        expect(t.usage?.context ?? 0).toBeGreaterThan(0);
        return `reply "${await lastReply(taskId)}"; thoughts ${items.filter((i) => i.role === 'thought').length}; model ${t.activeModel}; context chip "${ctx}"; usage ${JSON.stringify(t.usage)}`;
      });

      // 2. Edits under each permission mode; 3. a command.
      await step('ask: edit → card with diff → Deny', async () => {
        await invoke(page, 'task:setPermissionMode', { taskId, mode: 'ask' });
        await send(taskId, 'Create a file deny.txt containing exactly: no. Use your file tool. Then reply with only: done');
        await waitCard(taskId);
        const card = await answer(taskId, 'reject_once');
        await settled(taskId);
        const tool = (await transcript(taskId)).filter((i) => i.role === 'tool' && i.tool?.kind === 'edit').at(-1);
        expect(existsSync(join(work, 'deny.txt'))).toBe(false);
        expect(card.preview?.some((p) => p.type === 'diff')).toBe(true);
        return `card "${card.headline}" options [${card.options?.map((o) => o.label).join(', ')}] diff in card; tool status ${tool?.toolStatus}; file not created`;
      });
      await step('ask: edit → Allow → diff rendered', async () => {
        await send(taskId, 'Create a file hello.txt containing exactly: hi. Use your file tool. Then reply with only: done');
        await waitCard(taskId);
        const card = await answer(taskId, 'allow_once');
        await settled(taskId);
        const tool = (await transcript(taskId)).filter((i) => i.role === 'tool' && i.tool?.kind === 'edit').at(-1);
        await page.screenshot({ path: join(shots, `acp-real-${id}-edit.png`) });
        expect(readFileSync(join(work, 'hello.txt'), 'utf8').trim()).toBe('hi');
        const diff = tool?.tool?.content.find((c) => c.type === 'diff');
        expect(diff).toBeTruthy();
        return `card "${card.headline}"; tool "${tool?.tool?.title}" ${tool?.toolStatus}, diff ${diff && diff.type === 'diff' ? `${diff.diff.path} +${diff.diff.added}/-${diff.diff.removed}` : 'none'}`;
      });
      await step('ask: command → card → Allow → terminal output', async () => {
        await send(taskId, 'Run the shell command `echo hi-from-shell` and reply with only its output.');
        await waitCard(taskId);
        const card = await answer(taskId, 'allow_once');
        await settled(taskId);
        const tool = (await transcript(taskId)).filter((i) => i.role === 'tool' && i.tool?.kind === 'execute').at(-1);
        const term = tool?.tool?.content.find((c) => c.type === 'terminal');
        await page.screenshot({ path: join(shots, `acp-real-${id}-command.png`) });
        expect(term && term.type === 'terminal' ? term.output : '').toContain('hi-from-shell');
        return `card "${card.headline}"; terminal ${JSON.stringify(term)}`;
      });
      await step('edits: in-folder edit without asking', async () => {
        await invoke(page, 'task:setPermissionMode', { taskId, mode: 'edits' });
        await send(taskId, 'Create a file edits.txt containing exactly: e. Use your file tool. Then reply with only: done');
        await expect.poll(async () => existsSync(join(work, 'edits.txt')) || !!(await openCard(taskId)), { timeout: 180_000, interval: 1000 }).toBe(true);
        const asked = await openCard(taskId);
        if (asked) await answer(taskId, 'allow_once');
        await settled(taskId);
        expect(asked).toBeUndefined();
        return `file created without a card`;
      });
      await step('auto: command (decided by the mode)', async () => {
        await invoke(page, 'task:setPermissionMode', { taskId, mode: 'auto' });
        await send(taskId, 'Run the shell command `echo auto-ok` and reply with only its output.');
        let asked = '';
        await expect.poll(
          async () => {
            const c = await openCard(taskId);
            if (c) {
              asked = c.headline;
              await answer(taskId, 'allow_once');
            }
            return (await taskOf(taskId)).status;
          },
          { timeout: 240_000, interval: 1000 },
        ).toMatch(/done|idle|failed/);
        expect(await lastReply(taskId)).toContain('auto-ok');
        return asked ? `asked: "${asked}" (allowed)` : 'ran without asking';
      });
      await invoke(page, 'task:setPermissionMode', { taskId, mode: 'ask' });

      // 4. Model picker.
      await step('model picker: list, switch, back to default', async () => {
        const before = (await taskOf(taskId)).activeModel;
        await page.getByTestId('model-chip').first().click();
        await page.getByTestId('model-menu').waitFor({ timeout: 30_000 });
        await page.getByTestId('model-option').first().waitFor({ timeout: 30_000 });
        const options = await page.getByTestId('model-option').allInnerTexts();
        await page.screenshot({ path: join(shots, `acp-real-${id}-models.png`) });
        expect(options.length).toBeGreaterThan(1);
        await page.locator(`[data-testid="model-option"][data-model="${setup.other}"]`).click();
        await expect.poll(async () => (await taskOf(taskId)).activeModel, { timeout: 30_000 }).toBe(setup.other);
        await send(taskId, 'Reply with only: switched');
        await settled(taskId);
        const reply = await lastReply(taskId);
        const chip = await page.getByTestId('model-chip').first().innerText();
        await page.getByTestId('model-chip').first().click();
        await page.getByTestId('model-reset').click();
        await expect.poll(async () => (await taskOf(taskId)).activeModel, { timeout: 30_000 }).toBe(before);
        expect(reply.toLowerCase()).toContain('switched');
        return `${options.length} models listed; ${before} → ${setup.other} (CLI confirmed; chip "${chip}"), reply "${reply}"; back to ${before}`;
      });

      // 5. Stop mid-turn, then a new message.
      await step('interrupt mid-turn, then a new message', async () => {
        await send(taskId, 'Count from 1 to 300, one number per line, nothing else.');
        await expect.poll(async () => (await taskOf(taskId)).status, { timeout: 60_000, interval: 300 }).toBe('running');
        await new Promise((r) => setTimeout(r, 2500));
        await invoke(page, 'task:interrupt', { taskId });
        await settled(taskId, 60_000);
        const after = await taskOf(taskId);
        await send(taskId, 'Reply with only: back');
        await settled(taskId);
        expect((await lastReply(taskId)).toLowerCase()).toContain('back');
        return `after interrupt: ${after.status} "${after.summary}"; next reply "${await lastReply(taskId)}"`;
      });

      // 6. A message while it works (held, then sent), and interrupt-and-send.
      await step('message while working: held and sent after the turn (steer)', async () => {
        await send(taskId, 'Count from 1 to 60, one number per line, nothing else.');
        await expect.poll(async () => (await taskOf(taskId)).status, { timeout: 60_000, interval: 300 }).toBe('running');
        const r = await send(taskId, 'Now reply with only: HELD-OK');
        await expect.poll(async () => (await lastReply(taskId)).includes('HELD-OK'), { timeout: 240_000, interval: 1000 }).toBe(true);
        await settled(taskId);
        const held = (await transcript(taskId)).filter((i) => i.role === 'user' && i.text.includes('HELD-OK')).at(-1);
        return `delivery ${r.delivery}; shown as ${held?.delivery}; reply "${await lastReply(taskId)}"`;
      });
      await step('interrupt and send', async () => {
        await send(taskId, 'Count from 1 to 300, one number per line, nothing else.');
        await expect.poll(async () => (await taskOf(taskId)).status, { timeout: 60_000, interval: 300 }).toBe('running');
        await new Promise((r) => setTimeout(r, 2000));
        const r = await send(taskId, 'Stop counting. Reply with only: INT-OK', { interrupt: true });
        await expect.poll(async () => (await lastReply(taskId)).includes('INT-OK'), { timeout: 240_000, interval: 1000 }).toBe(true);
        await settled(taskId);
        return `delivery ${r.delivery}; reply "${await lastReply(taskId)}"`;
      });

      // 8. @-mentions, dropped files and images.
      await step('@ mention', async () => {
        const found = await invoke<Array<{ path: string }>>(page, 'files:search', { taskId, query: 'notes' });
        await send(taskId, 'What is the secret fruit in @notes.txt? Reply with only it.');
        await expect.poll(async () => {
          const c = await openCard(taskId);
          if (c) await answer(taskId, 'allow_once');
          return (await taskOf(taskId)).status;
        }, { timeout: 240_000, interval: 1000 }).toMatch(/done|idle|failed/);
        expect(await lastReply(taskId)).toContain('PAPAYA-5');
        return `search → ${found.map((f) => f.path).join(', ')}; reply "${await lastReply(taskId)}"`;
      });
      await step('dropped file', async () => {
        const outside = join(mkdtempSync(join(tmpdir(), 'amw-acp-drop-')), 'drop note.txt');
        cleanup.push(resolve(outside, '..'));
        writeFileSync(outside, 'The dropped animal is OTTER-3.\n');
        const [m] = await invoke<Array<{ path: string; mention: string }>>(page, 'files:dropped', { taskId, paths: [outside] });
        await send(taskId, `What is the dropped animal in @"${m.path}"? Reply with only it.`);
        await expect.poll(async () => {
          const c = await openCard(taskId);
          if (c) await answer(taskId, 'allow_once');
          return (await taskOf(taskId)).status;
        }, { timeout: 240_000, interval: 1000 }).toMatch(/done|idle|failed/);
        expect(await lastReply(taskId)).toContain('OTTER-3');
        return `mention ${m.path}; reply "${await lastReply(taskId)}"`;
      });
      await step('image', async () => {
        const ref = await page.evaluate(async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 240;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, 640, 240);
          ctx.fillStyle = '#111';
          ctx.font = 'bold 96px sans-serif';
          ctx.fillText('ZEBRA 47', 40, 160);
          const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
          const bytes = new Uint8Array(await blob.arrayBuffer());
          return (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke('attachment:save', { bytes, name: 'word.png' });
        });
        if (setup.vision) await invoke(page, 'task:setModel', { taskId, model: setup.vision });
        await send(taskId, 'What word and number are written in the image? Reply with only them. Do not use tools.', { images: [ref as ImageRef] });
        await settled(taskId);
        const reply = await lastReply(taskId);
        if (setup.vision) await invoke(page, 'task:setModel', { taskId, model: null });
        expect(reply.toUpperCase()).toContain('ZEBRA');
        return `reply "${reply}"`;
      });

      // 9. !command.
      await step('!command handed over with the next message', async () => {
        await invoke(page, 'task:shell', { taskId, command: 'echo bang-$((40+2))' });
        await expect.poll(async () => (await transcript(taskId)).some((i) => i.text.includes('bang-42') || JSON.stringify(i.tool ?? {}).includes('bang-42')), { timeout: 30_000 }).toBe(true);
        await send(taskId, 'What did my last shell command print? Reply with only that.');
        await settled(taskId);
        expect(await lastReply(taskId)).toContain('bang-42');
        return `reply "${await lastReply(taskId)}"`;
      });

      // A question the agent asks with its own question tool (ACP form elicitation), answered on its card.
      await step('question card (agent asks, user answers)', async () => {
        await send(taskId, 'Use your question tool (not plain text) to ask me one multiple-choice question: tea or coffee. Then reply with only my answer.');
        await expect.poll(async () => {
          const q = (await snap()).attention.find((a) => a.taskId === taskId && a.state === 'open' && a.kind === 'question');
          return !!q || /done|idle|failed/.test((await taskOf(taskId)).status);
        }, { timeout: 180_000, interval: 1000 }).toBe(true);
        const q = (await snap()).attention.find((a) => a.taskId === taskId && a.state === 'open' && a.kind === 'question');
        if (!q) {
          // Only the CLI's own tools can ask this way; Antigravity has no question tool over ACP.
          if (id === 'opencode') throw new Error(`no question card; reply "${await lastReply(taskId)}"`);
          return `no question tool over ACP (replied in text: "${(await lastReply(taskId)).slice(0, 80)}")`;
        }
        await page.screenshot({ path: join(shots, `acp-real-${id}-question.png`) });
        const first = q.questions![0];
        const coffee = first.options.find((o) => /coffee/i.test(o.label))?.label ?? 'coffee';
        await invoke(page, 'attention:respond', { attentionId: q.id, answers: { [first.id]: coffee } });
        await settled(taskId);
        expect((await lastReply(taskId)).toLowerCase()).toContain('coffee');
        return `card "${q.headline}": ${first.question} [${first.options.map((o) => o.label).join(' / ')}] → ${coffee}; reply "${await lastReply(taskId)}"`;
      });

      // 10. Side question.
      await step('side question (btw)', async () => {
        const before = (await transcript(taskId)).length;
        prompts++;
        const entry = await invoke<{ answer?: string; error?: string }>(page, 'btw:ask', { taskId, question: 'What codeword did I ask you to remember? Reply with only it.' });
        const after = (await transcript(taskId)).length;
        expect(entry.error).toBeUndefined();
        expect(entry.answer).toContain('KIWI-7');
        expect(after).toBe(before);
        return `answer "${entry.answer}"; transcript unchanged (${before} items)`;
      });

      // 11. Session map, rename, set aside, memory.
      await step('session map', async () => {
        const map = await invoke<unknown>(page, 'session:map', { taskId });
        const text = JSON.stringify(map);
        expect(text.length).toBeGreaterThan(20);
        return `map ${text.slice(0, 200)}…`;
      });
      await step('rename and set aside', async () => {
        await invoke(page, 'task:rename', { taskId, name: 'Fruit checker' });
        await invoke(page, 'task:renameAgent', { taskId, alias: 'Pip' });
        await invoke(page, 'task:setAside', { taskId, on: true });
        const t = await taskOf(taskId);
        await invoke(page, 'task:setAside', { taskId, on: false });
        expect(t).toMatchObject({ name: 'Fruit checker', alias: 'Pip', setAside: true });
        return `name ${t.name}, alias ${t.alias}, set aside ${t.setAside}`;
      });
      await step('project memory reaches the agent', async () => {
        await invoke(page, 'memory:add', { scope: 'project', scopeId: project.projectId, body: 'The project codename is HERON-8.', approvedForReuse: true });
        await send(taskId, 'What is the project codename in your workspace memory? Reply with only it.');
        await settled(taskId);
        expect(await lastReply(taskId)).toContain('HERON-8');
        return `reply "${await lastReply(taskId)}"`;
      });
      await step('sync (re-reads the saved conversation)', async () => {
        const n = (await transcript(taskId)).length;
        await invoke(page, 'task:sync', { taskId });
        await expect.poll(async () => (await taskOf(taskId)).status, { timeout: 120_000, interval: 1000 }).toMatch(/done|idle/);
        const items = await transcript(taskId);
        expect(items.some((i) => i.text.includes('KIWI-7'))).toBe(true);
        return `${n} items before, ${items.length} after sync`;
      });

      // 7. Restart: history replayed, the next message continues the same conversation.
      await step('resume after app restart', async () => {
        const native = await nativeOf(taskId);
        await app!.close();
        page = await launch(dataDir);
        await invoke(page, 'task:resume', { taskId });
        await expect.poll(async () => (await transcript(taskId)).some((i) => i.text.includes('KIWI-7')), { timeout: 120_000 }).toBe(true);
        await send(taskId, 'What codeword did I ask you to remember first? Reply with only it.');
        await settled(taskId);
        const sessionAfter = await nativeOf(taskId);
        expect(await lastReply(taskId)).toContain('KIWI-7');
        expect(sessionAfter).toBe(native);
        return `same session ${native}; reply "${await lastReply(taskId)}"`;
      });

      // Fork (whole, and from an earlier prompt).
      let forkId = '';
      await step('fork the whole conversation', async () => {
        const points = await invoke<Array<{ upToMessageId: string; prompt: string }>>(page, 'task:forkPoints', { taskId });
        const fork = await invoke<Task>(page, 'task:fork', { taskId, isolate: false });
        forkId = fork.taskId;
        await send(forkId, 'What codeword did I ask you to remember? Reply with only it.');
        await settled(forkId);
        expect(await lastReply(forkId)).toContain('KIWI-7');
        return `${points.length} fork points; fork ${fork.alias} replies "${await lastReply(forkId)}"`;
      });
      await step('fork from an earlier prompt', async () => {
        const points = await invoke<Array<{ upToMessageId: string; prompt: string }>>(page, 'task:forkPoints', { taskId });
        const p = points.find((x) => x.prompt.includes('deny.txt'));
        expect(p).toBeTruthy();
        const fork = await invoke<Task>(page, 'task:fork', { taskId, isolate: false, upToMessageId: p!.upToMessageId });
        await expect.poll(async () => (await transcript(fork.taskId)).length, { timeout: 60_000 }).toBeGreaterThan(0);
        const items = await transcript(fork.taskId);
        expect(items.some((i) => i.text.includes('KIWI-7'))).toBe(true);
        expect(items.some((i) => i.role === 'user' && i.text.includes('deny.txt'))).toBe(false);
        return `fork before "${p!.prompt.slice(0, 40)}": ${items.length} items, ends before it`;
      });

      // Continue a session: removed, found again, imported with its history.
      await step('continue a saved session (import)', async () => {
        const native = (await nativeOf(taskId))!;
        await invoke(page, 'task:remove', { taskId });
        const found = await invoke<Array<{ nativeSessionId: string; title: string }>>(page, 'sessions:discover', { projectId: project.projectId, provider: id });
        const s = found.find((x) => x.nativeSessionId === native);
        expect(s).toBeTruthy();
        const t = await invoke<Task>(page, 'task:importSession', { projectId: project.projectId, provider: id, nativeSessionId: native, cwd: work, title: s!.title });
        await expect.poll(async () => (await transcript(t.taskId)).some((i) => i.text.includes('KIWI-7')), { timeout: 120_000 }).toBe(true);
        await page.getByTestId('resume-session').first().click();
        await page.getByTestId('session-list').waitFor({ timeout: 30_000 }).catch(() => {});
        await page.screenshot({ path: join(shots, `acp-real-${id}-import.png`) });
        await page.keyboard.press('Escape');
        return `${found.length} sessions in the folder; "${s!.title}" imported with history`;
      });

      results.push({ step: 'prompts used', ok: true, evidence: String(prompts) });
      save();
      console.log(`[${id}] results in ${out}; ${prompts} prompts`);
      expect(results.filter((r) => !r.ok).map((r) => r.step)).toEqual([]);
    }, 1_800_000);
  }

  // Installed but not signed in: Antigravity run with an empty home folder (no credentials at all; the
  // real ones are never read, copied or moved). No prompt reaches a model.
  it.runIf(!only || only === 'antigravity')('antigravity: not signed in → the exact command to sign in', async () => {
    await app?.close().catch(() => {});
    const home = mkdtempSync(join(tmpdir(), 'amw-acp-nohome-'));
    cleanup.push(home);
    const agy = ['/opt/homebrew/bin/agy', join(process.env.HOME ?? '', '.local/bin/agy')].find((p) => existsSync(p)) ?? 'agy';
    process.env.AMW_ACP_COMMAND_ANTIGRAVITY = JSON.stringify(['env', `HOME=${home}`, `XDG_CONFIG_HOME=${home}/.config`, `XDG_DATA_HOME=${home}/.local/share`, `XDG_CACHE_HOME=${home}/.cache`, agy, 'acp']);
    try {
      mkdirSync(join(appDir, '.cache'), { recursive: true });
      const root = realpathSync(mkdtempSync(join(appDir, '.cache', 'acp-auth-')));
      cleanup.push(root);
      execFileSync('git', ['init', '-q'], { cwd: root });
      const dataDir = mkdtempSync(join(tmpdir(), 'amw-acp-auth-'));
      cleanup.push(dataDir);
      const page = await launch(dataDir);
      await invoke(page, 'settings:update', { onboarding: { dismissed: true }, language: 'en' });
      // Its own status command (`agy models`) says so, without a prompt.
      await expect.poll(async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).capabilities.find((c) => c.provider === 'antigravity')?.auth, { timeout: 60_000 }).toEqual({ loggedIn: false });
      // Signing in with a code: the link its login prints (Google's sign-in page); cancelled, never completed.
      const login = await invoke<{ url?: string }>(page, 'acp:login', { provider: 'antigravity', mode: 'code' });
      expect(login.url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);
      await invoke(page, 'acp:loginCancel', { provider: 'antigravity' });
      writeFileSync(join(shots, 'acp-real-antigravity-login-url.txt'), (login.url ?? '').replace(/(state|code_challenge)=[^&]+/g, '$1=…'));
      const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: 'auth' });
      const t = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider: 'antigravity', isolate: false });
      await page.getByTestId('agent-card').first().click().catch(() => {});
      const r = await invoke<{ ok: boolean; error?: string }>(page, 'task:send', { taskId: t.taskId, text: 'Reply with only: pong', via: 'text' });
      const shown = async () => JSON.stringify(await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: t.taskId })) + JSON.stringify((await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.find((x) => x.taskId === t.taskId));
      await expect.poll(async () => (r.error ?? '') + (await shown()), { timeout: 90_000 }).toContain('agy acp --login');
      await expect.poll(async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.find((x) => x.taskId === t.taskId)?.status, { timeout: 30_000 }).toBe('failed');
      await page.getByText('Alice', { exact: true }).first().click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(shots, 'acp-real-antigravity-signin.png') });
      const said = r.error ?? (await shown()).match(/[^"]*not signed in[^"]*/)?.[0] ?? '';
      writeFileSync(join(shots, 'acp-real-antigravity-signin.txt'), said);
      console.log('[antigravity] sign-in:', said);
    } finally {
      delete process.env.AMW_ACP_COMMAND_ANTIGRAVITY;
    }
  }, 300_000);

  // Signed in as the CLI's own status says, and a sub-agent shown as one (OpenCode's background
  // `subagent` with its child-session updates; Antigravity's invoke_subagent). One tiny prompt each.
  for (const id of Object.keys(SETUPS) as Array<keyof typeof SETUPS>) {
    it.runIf(!only || only === id)(`${id}: signed in, and its sub-agent shown as a sub-agent`, async () => {
      await app?.close().catch(() => {});
      mkdirSync(join(appDir, '.cache'), { recursive: true });
      const root = realpathSync(mkdtempSync(join(appDir, '.cache', `acp-sub-${id}-`)));
      cleanup.push(root);
      execFileSync('git', ['init', '-q'], { cwd: root });
      writeFileSync(join(root, 'notes.txt'), 'The secret fruit is PAPAYA-5.\n');
      const dataDir = mkdtempSync(join(tmpdir(), `amw-acp-sub-${id}-`));
      cleanup.push(dataDir);
      const page = await launch(dataDir);
      await invoke(page, 'settings:update', { onboarding: { dismissed: true }, permissionMode: 'auto', language: 'en' });
      const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
      await expect.poll(async () => (await snap()).capabilities.find((c) => c.provider === id)?.auth?.loggedIn, { timeout: 60_000 }).toBe(true);
      const auth = (await snap()).capabilities.find((c) => c.provider === id)!.auth;
      const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: `sub-${id}` });
      const t = await invoke<Task>(page, 'task:create', { projectId: project.projectId, provider: id, isolate: false });
      const tool = id === 'opencode' ? 'subagent tool (general agent)' : 'invoke_subagent tool';
      const r = await invoke<{ ok: boolean; error?: string }>(page, 'task:send', { taskId: t.taskId, text: `Use your ${tool} to read notes.txt and report the secret fruit. Do not read it yourself. Keep the answer short.`, via: 'text' });
      expect(r.ok).toBe(true);
      const task = async () => (await snap()).tasks.find((x) => x.taskId === t.taskId)!;
      try {
        await expect.poll(async () => (await task()).subtasks?.some((s) => s.status === 'done'), { timeout: 240_000, interval: 1000 }).toBe(true);
      } catch (e) {
        writeFileSync(join(shots, `acp-real-${id}-subagent-fail.json`), JSON.stringify({ task: await task(), transcript: await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: t.taskId }) }, null, 1));
        throw e;
      }
      await expect.poll(async () => (await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: t.taskId })).some((i) => i.role === 'assistant' && i.text.includes('PAPAYA-5')), { timeout: 240_000, interval: 1000 }).toBe(true);
      await expect.poll(async () => (await task()).status, { timeout: 120_000, interval: 1000 }).toMatch(/done|idle/);
      const subs = (await task()).subtasks ?? [];
      await page.getByText((await task()).name ?? '', { exact: true }).first().click().catch(() => {});
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(shots, `acp-real-${id}-subagent.png`) });
      const evidence = { auth, subtasks: subs.map((s) => ({ description: s.description, status: s.status, steps: s.steps?.map((x) => x.text), result: s.result?.slice(0, 200) })) };
      writeFileSync(join(shots, `acp-real-${id}-subagent.json`), JSON.stringify(evidence, null, 2));
      console.log(`[${id}] sub-agent:`, JSON.stringify(evidence));
    }, 600_000);
  }
});
