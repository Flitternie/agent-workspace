// Opening an agent's page starts its session in the background, so the first message does not wait
// for it; looking is not using, so nothing the user sees of the agent (place, set aside, summary) changes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task, WorkspaceSnapshot } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
afterAll(async () => {
  await app?.close().catch(() => {});
});
const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;
const snap = (page: Page) => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});

function repo(): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-warm-'))), 'shop');
  mkdirSync(dir);
  writeFileSync(join(dir, 'README.md'), '# shop\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const dataDir = mkdtempSync(join(tmpdir(), 'amw-warm-data-'));
async function launch(): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    cwd: appDir,
    env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.app');
  return page;
}

const visible = (t: Task) => ({ status: t.status, statusSince: t.statusSince, updatedAt: t.updatedAt, lastUserActivityAt: t.lastUserActivityAt, setAside: t.setAside, unread: t.unread, summary: t.summary, title: t.title, name: t.name });

describe('connect on open', () => {
  it('connects an agent when its page opens, leaving its place, flags and summary until it is messaged', async () => {
    let page = await launch();
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo(), name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', instruction: 'Do orders.', isolate: false });
    const b = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Charts', name: 'Charts', instruction: 'Do charts.', isolate: false });
    const task = async (id: string) => (await snap(page)).tasks.find((t) => t.taskId === id)!;
    for (const t of [a, b]) await expect.poll(async () => (await task(t.taskId)).status, { timeout: 30_000 }).toBe('done');
    // Seen (opening clears "unread" by itself, apart from connecting) and Charts set aside.
    for (const t of [a, b]) await invoke(page, 'task:viewed', { taskId: t.taskId });
    await invoke(page, 'task:setAside', { taskId: b.taskId, on: true });
    await app!.close();

    page = await launch();
    const row = (alias: string) => page.locator(`[data-testid="rail-item"][data-alias="${alias}"]`);
    const rail = () => page.locator('[data-testid="rail-item"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-alias')));
    await expect.poll(() => row(a.alias).count()).toBe(1);
    expect((await snap(page)).connectedTaskIds).toEqual([]);
    const before = Object.fromEntries((await snap(page)).tasks.map((t) => [t.taskId, visible(t)]));
    const railBefore = await rail();
    const transcriptBefore = (await invoke<Array<{ text: string }>>(page, 'transcript:get', { taskId: a.taskId })).length;

    // Opened: connected without a message; the header says so; nothing else moved.
    await row(a.alias).click();
    await expect.poll(async () => (await snap(page)).connectedTaskIds, { timeout: 15_000 }).toContain(a.taskId);
    await expect.poll(() => page.locator('.focus-head .status').getAttribute('title')).toBe('Provider session connected');
    expect(visible(await task(a.taskId))).toEqual(before[a.taskId]);
    expect(await rail()).toEqual(railBefore);
    expect((await invoke<Array<{ text: string }>>(page, 'transcript:get', { taskId: a.taskId })).length).toBeLessThanOrEqual(transcriptBefore);

    // The set-aside one, opened from its team's idle row: connected, still set aside.
    await page.getByTestId('team-idle').click();
    await row(b.alias).click();
    await expect.poll(async () => (await snap(page)).connectedTaskIds, { timeout: 15_000 }).toContain(b.taskId);
    expect(visible(await task(b.taskId))).toEqual(before[b.taskId]);
    await expect.poll(() => page.getByTestId('set-aside').getAttribute('aria-pressed')).toBe('true');

    // Messaged: that is using it, as before (activity, back from set aside), on the session already there.
    const sessions = (await snap(page)).sessions.length;
    await page.getByTestId('composer-input').fill('One more thing.');
    await page.getByTestId('composer-input').press('Enter');
    await expect.poll(async () => (await task(b.taskId)).setAside ?? false).toBe(false);
    const after = await task(b.taskId);
    expect(after.lastUserActivityAt).not.toBe(before[b.taskId].lastUserActivityAt);
    expect(after.updatedAt).not.toBe(before[b.taskId].updatedAt);
    expect((await snap(page)).sessions.length).toBe(sessions);
    await expect.poll(() => page.getByTestId('transcript').innerText(), { timeout: 15_000 }).toMatch(/Resumed native mock session/);
  });
});
