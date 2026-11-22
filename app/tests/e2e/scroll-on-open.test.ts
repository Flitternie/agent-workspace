// Opening an agent shows the end of its conversation, whatever the reader did in the agent before it
// (scrolled up there), and after a relaunch, when opening connects it and replays its history (mock agents).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
afterAll(async () => {
  await app?.close().catch(() => {});
});
const invoke = <T,>(page: Page, c: string, p: unknown) => page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [c, p] as const) as Promise<T>;

describe('opening an agent', () => {
  it('shows the end of its conversation, after scrolling up in another agent and after a relaunch', async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-scroll-')));
    const dir = join(scratch, 'shop');
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '# shop\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    const launch = async () => {
      app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: join(scratch, 'data'), AMW_MOCK_DELAY_MS: '5', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1400, height: 800 });
      await page.waitForSelector('.app');
      return page;
    };
    let page = await launch();
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: dir, name: 'shop' });
    const settled = async (id: string) => !['running', 'starting'].includes((await invoke<{ tasks: Task[] }>(page, 'workspace:snapshot', {})).tasks.find((t) => t.taskId === id)!.status);
    const agents: Task[] = [];
    for (const name of ['A', 'B']) {
      const t = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: name, name, mockScript: 'work', instruction: `Start ${name}.`, isolate: false });
      agents.push(t);
      for (let i = 1; i < 14; i++) {
        await expect.poll(() => settled(t.taskId), { timeout: 30_000, interval: 40 }).toBe(true);
        await invoke(page, 'task:send', { taskId: t.taskId, text: `${name} step ${i}.`, via: 'text' });
      }
      await expect.poll(() => settled(t.taskId), { timeout: 30_000, interval: 40 }).toBe(true);
    }
    const gap = () => page.locator('.transcript').evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    const open = (t: Task) => page.locator(`[data-testid="rail-item"][data-alias="${t.alias}"],[data-testid="needs-item"][data-alias="${t.alias}"]`).first().click();

    await open(agents[0]);
    await expect.poll(gap).toBeLessThan(5);
    // Scrolled up in A to read; then B opens at its own end (it used to keep A's "not at the end").
    await page.locator('.transcript').evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    expect(await gap()).toBeGreaterThan(200);
    await open(agents[1]);
    await expect.poll(gap).toBeLessThan(5);

    // Relaunched: opening connects the agent and replays its history into the view; still at the end.
    await app!.close();
    page = await launch();
    await open(agents[0]);
    await page.waitForTimeout(1500);
    await expect.poll(gap).toBeLessThan(5);
  }, 120_000);
});
