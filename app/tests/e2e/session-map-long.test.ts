// A long session's map, taller than its room: it scrolls on its own, fades at its ends, and keeps the
// task being read in view, beside the conversation and as the outline (mock agent, fixed grouping).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/types';

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

const TURNS = 60;
const TASKS = 30;

describe('session map, long session', () => {
  it('scrolls on its own and keeps the task being read in view', async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-maplong-')));
    const dir = join(scratch, 'shop');
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '# shop\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const answer = join(scratch, 'answer.json');
    writeFileSync(
      answer,
      JSON.stringify({
        tasks: Array.from({ length: TASKS }, (_, i) => ({
          start: i * (TURNS / TASKS),
          title: `Task ${i + 1}`,
          outcome: `Outcome ${i + 1}`,
          status: i === TASKS - 1 ? 'in_progress' : 'done',
          ...(i % 4 === 1 ? { decisions: [{ turn: i * 2 + 1, decision: `Choice ${i + 1}`, rejected: 'Other way' }] } : {}),
        })),
      }),
    );
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: join(scratch, 'data'), AMW_MOCK_DELAY_MS: '5', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_BACKGROUND_ANSWER: answer } });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1720, height: 800 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: dir, name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Long', name: 'Long', instruction: 'Step 0.', isolate: false });
    const snap = () => invoke<{ tasks: Task[] }>(page, 'workspace:snapshot', {});
    const settled = async () => !['running', 'starting'].includes((await snap()).tasks.find((t) => t.taskId === a.taskId)!.status);
    for (let i = 1; i < TURNS; i++) {
      await expect.poll(settled, { timeout: 30_000, interval: 50 }).toBe(true);
      await invoke(page, 'task:send', { taskId: a.taskId, text: `Step ${i}.`, via: 'text' });
    }
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"],[data-testid="needs-item"][data-alias="${a.alias}"]`).first().click();

    const tasks = page.getByTestId('map-task');
    await expect.poll(() => tasks.count(), { timeout: 20_000 }).toBe(TASKS);
    // Taller than its room, it scrolls inside its own box.
    const box = page.getByTestId('session-map-beside');
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
    // It runs down to the reply box's bottom edge (the room right of the box is free).
    const ends = await page.evaluate(() => ({
      map: document.querySelector('[data-testid="session-map-beside"]')!.getBoundingClientRect().bottom,
      box: document.querySelector('.composer-box')!.getBoundingClientRect().bottom,
    }));
    expect(Math.abs(ends.map - ends.box)).toBeLessThan(20);
    /** Whether the task being read is within the map's box. */
    const currentShown = (sel: string, item: string) =>
      page.evaluate(([sel, item]) => {
        const b = document.querySelector(sel)!.getBoundingClientRect();
        const n = document.querySelector(`${sel} ${item}.current`)?.getBoundingClientRect();
        return !!n && n.top >= b.top && n.bottom <= b.bottom;
      }, [sel, item] as const);
    // At the end of the conversation: the latest task, scrolled into view.
    await expect.poll(() => tasks.nth(TASKS - 1).getAttribute('class')).toContain('current');
    await expect.poll(() => currentShown('[data-testid="session-map-beside"]', '.map-task')).toBe(true);
    await page.screenshot({ path: join(shots, 'map-long-01-end.png') });
    // Back at the start of the conversation: the first task, and the map follows.
    await page.locator('.transcript').evaluate((el) => el.scrollTo({ top: 0 }));
    await expect.poll(() => tasks.nth(0).getAttribute('class'), { timeout: 5000 }).toContain('current');
    await expect.poll(() => currentShown('[data-testid="session-map-beside"]', '.map-task')).toBe(true);
    // Halfway.
    await page.locator('.transcript').evaluate((el) => el.scrollTo({ top: el.scrollHeight / 2 }));
    await expect.poll(() => currentShown('[data-testid="session-map-beside"]', '.map-task')).toBe(true);
    await page.screenshot({ path: join(shots, 'map-long-02-middle.png') });

    // The outline, narrower: it scrolls too, and follows.
    await page.setViewportSize({ width: 1150, height: 800 });
    await expect.poll(() => page.getByTestId('mini-task').count()).toBe(TASKS);
    const mini = page.getByTestId('session-minimap');
    expect(await mini.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.locator('.transcript').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect.poll(() => currentShown('[data-testid="session-minimap"]', '.mini-task')).toBe(true);
    await page.screenshot({ path: join(shots, 'map-long-03-outline.png') });
    expect(errors).toEqual([]);
  }, 180_000);
});
