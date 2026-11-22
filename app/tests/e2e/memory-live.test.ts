// Memory saved while agents are running reaches them with their next message (no restart): every agent
// of its scope, once, shown in the conversation; an edit or a removal likewise; idle ones can be told now.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { MemoryRecord, Task, TranscriptItem } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
afterAll(async () => {
  await app?.close().catch(() => {});
});
const invoke = <T,>(page: Page, c: string, p: unknown) => page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [c, p] as const) as Promise<T>;

describe('memory reaches running agents', () => {
  it('sends a note saved mid-session with the next message to every agent of its scope', async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-memlive-')));
    const repo = (name: string) => {
      const dir = join(scratch, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
      execFileSync('git', ['init', '-q'], { cwd: dir });
      return dir;
    };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: join(scratch, 'data'), AMW_MOCK_DELAY_MS: '20', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const shop = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo('shop'), name: 'shop' });
    const other = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo('site'), name: 'site' });
    const snap = () => invoke<{ tasks: Task[] }>(page, 'workspace:snapshot', {});
    const settled = async (id: string) => !['running', 'starting'].includes((await snap()).tasks.find((t) => t.taskId === id)!.status);
    const mk = (projectId: string, name: string) => invoke<Task>(page, 'task:create', { projectId, provider: 'mock', title: name, name, mockScript: 'work', instruction: `Start ${name}.`, isolate: false });
    const transcript = (id: string) => invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: id });
    const say = async (id: string, text: string) => {
      await expect.poll(() => settled(id), { timeout: 30_000 }).toBe(true);
      await invoke(page, 'task:send', { taskId: id, text, via: 'text' });
      await expect.poll(() => settled(id), { timeout: 30_000 }).toBe(true);
    };
    const lastReply = async (id: string) => (await transcript(id)).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
    const memoryNotes = async (id: string) => (await transcript(id)).filter((i) => i.role === 'system' && i.memoryUpdate?.length);
    const a = await mk(shop.projectId, 'Ana');
    const b = await mk(shop.projectId, 'Ben');
    const c = await mk(other.projectId, 'Cal');
    for (const t of [a, b, c]) await expect.poll(() => settled(t.taskId), { timeout: 30_000 }).toBe(true);

    // A project note, saved while all three sessions are running.
    const note = await invoke<MemoryRecord>(page, 'memory:add', { scope: 'project', scopeId: shop.projectId, body: 'Prices are integer cents.', originTaskId: a.taskId, approvedForReuse: true });
    // It reaches the project's agents (not the other project's), from their next message.
    const reach = await invoke<Array<{ alias: string }>>(page, 'memory:reach', { id: note.id });
    expect(reach.map((r) => r.alias).sort()).toEqual([a.alias, b.alias].sort());
    await say(b.taskId, 'Add a refund endpoint.');
    expect(await lastReply(b.taskId)).toContain('Memory update received: - [project convention] Prices are integer cents.');
    expect(await lastReply(b.taskId)).toContain('Add a refund endpoint.');
    expect((await memoryNotes(b.taskId)).length).toBe(1);
    // What the user wrote is shown as they wrote it.
    expect((await transcript(b.taskId)).filter((i) => i.role === 'user').at(-1)!.text).toBe('Add a refund endpoint.');
    // Once: the next message carries nothing more.
    await say(b.taskId, 'And a test.');
    expect(await lastReply(b.taskId)).not.toContain('Memory update');
    expect((await memoryNotes(b.taskId)).length).toBe(1);
    // The other project's agent never gets it.
    await say(c.taskId, 'Hello.');
    expect(await lastReply(c.taskId)).not.toContain('Memory update');
    // Shown in the conversation: one line, the note on a click.
    await page.locator(`[data-testid="rail-item"][data-alias="${b.alias}"],[data-testid="needs-item"][data-alias="${b.alias}"]`).first().click();
    const sent = page.getByTestId('memory-sent');
    await expect.poll(() => sent.count()).toBe(1);
    // (It went with an earlier message, whose turn is folded now: open it.)
    const fold = page.getByTestId('turn-fold').filter({ has: sent });
    if (await fold.count()) await fold.locator('summary').first().click();
    await sent.locator('summary').click();
    expect(await sent.innerText()).toContain('Prices are integer cents.');
    await page.screenshot({ path: join(shots, 'memory-live-01.png') });

    // Edited: the new wording goes out; then removed: it is said to no longer apply.
    await invoke(page, 'memory:update', { id: note.id, body: 'Prices are integer cents; round half up.' });
    await say(b.taskId, 'Next.');
    expect(await lastReply(b.taskId)).toContain('[project convention, updated] Prices are integer cents; round half up.');
    await invoke(page, 'memory:delete', { id: note.id });
    await say(b.taskId, 'Then.');
    expect(await lastReply(b.taskId)).toContain('[no longer applies] Prices are integer cents; round half up.');

    // Tell the idle ones now: Ana (idle, never told) gets a short message with the update.
    const second = await invoke<MemoryRecord>(page, 'memory:add', { scope: 'project', scopeId: shop.projectId, body: 'Use pnpm.', approvedForReuse: true });
    expect(await invoke<number>(page, 'memory:tellNow', { id: second.id })).toBe(2);
    await expect.poll(() => lastReply(a.taskId), { timeout: 30_000 }).toContain('Use pnpm.');
    await expect.poll(() => invoke<Array<unknown>>(page, 'memory:reach', { id: second.id })).toEqual([]);
    expect(errors).toEqual([]);
  }, 120_000);
});
