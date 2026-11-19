// The session map: an agent's turns as a tree of tasks (grouped by a model, here a fixed answer),
// beside the conversation when there is room, in the side column when not (mock agent).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { AttentionItem, Task } from '../../src/shared/types';

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

describe('session map', () => {
  it('draws the tasks with their outcome, decisions and options, follows the reading, and folds into the side column', async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-map-')));
    const dir = join(scratch, 'shop');
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '# shop\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // The background model's answer (a real one is never called in tests).
    const answer = join(scratch, 'answer.json');
    writeFileSync(
      answer,
      JSON.stringify({
        tasks: [
          { start: 0, title: 'Clean the build', outcome: 'dist removed, build is green', status: 'done', decisions: [{ turn: 1, decision: 'Keep the old config', rejected: 'Rewrite it' }], attempts: [{ turn: 1, tried: 'Rewrite the config', why: 'Too risky before the release' }] },
          { start: 2, title: 'Refund flow', outcome: 'Endpoints drafted', status: 'in_progress' },
        ],
      }),
    );
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: join(scratch, 'data'), AMW_MOCK_DELAY_MS: '40', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_BACKGROUND_ANSWER: answer } });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1720, height: 960 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: dir, name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Build', name: 'Build', mockScript: 'approval:rm -rf dist', instruction: 'Clean the build output.', isolate: false });
    const snap = () => invoke<{ tasks: Task[]; attention: AttentionItem[] }>(page, 'workspace:snapshot', {});
    // The approval: allowed, which records the decision with the options offered.
    await expect.poll(async () => (await snap()).attention.find((x) => x.taskId === a.taskId && x.state === 'open' && x.kind === 'approval')?.id, { timeout: 30_000 }).toBeTruthy();
    const ask = (await snap()).attention.find((x) => x.taskId === a.taskId && x.state === 'open' && x.kind === 'approval')!;
    await invoke(page, 'attention:respond', { attentionId: ask.id, decision: ask.options![0].id });
    const settled = async () => !['running', 'starting'].includes((await snap()).tasks.find((t) => t.taskId === a.taskId)!.status);
    for (const text of ['Keep the old config, do not rewrite it.', 'Now the refund flow.', 'Add the refund endpoints.']) {
      await expect.poll(settled, { timeout: 30_000 }).toBe(true);
      await invoke(page, 'task:send', { taskId: a.taskId, text, via: 'text' });
    }
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"],[data-testid="needs-item"][data-alias="${a.alias}"]`).first().click();

    // Beside the conversation: the model's tasks, titles, state, outcome of the one in view.
    await expect.poll(() => page.getByTestId('session-map-beside').count(), { timeout: 15_000 }).toBe(1);
    const titles = () => page.getByTestId('map-task-title').allInnerTexts();
    await expect.poll(titles).toEqual(['Clean the build', 'Refund flow']);
    const tasks = page.getByTestId('map-task');
    expect(await tasks.nth(0).getAttribute('data-status')).toBe('done');
    expect(await tasks.nth(1).getAttribute('data-status')).toBe('in_progress');
    // Scrolled to the end, the last task is the one being read: open, its outcome shown.
    await expect.poll(() => tasks.nth(1).getAttribute('class')).toContain('current');
    expect(await tasks.nth(1).innerText()).toContain('Endpoints drafted');
    await page.screenshot({ path: join(shots, 'map-01-beside.png') });
    // The current node, enlarged with its glow, is not cut off by the box around the map.
    const clip = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="session-map-beside"]')!.getBoundingClientRect();
      const node = document.querySelector('.map-task.current .map-node')!.getBoundingClientRect();
      return node.left - 4 - box.left;
    });
    expect(clip).toBeGreaterThanOrEqual(0);
    // The first task, opened: the decision read from the talk, and the approval with the options offered.
    await page.getByTestId('map-caret').first().click();
    const decisions = tasks.nth(0).getByTestId('map-decision');
    await expect.poll(() => decisions.count()).toBe(2);
    expect(await decisions.nth(0).innerText()).toContain('Allowed:');
    expect(await decisions.nth(0).locator('.map-option.chosen').count()).toBe(1);
    expect(await decisions.nth(1).innerText()).toContain('Keep the old config');
    // The way not taken branches off the decision.
    expect(await decisions.nth(1).getByTestId('map-not-taken').innerText()).toContain('Rewrite it');
    // An approach tried and dropped: a dead end, with why.
    expect(await tasks.nth(0).getByTestId('map-attempt').innerText()).toContain('Rewrite the config');
    expect(await tasks.nth(0).getByTestId('map-attempt').innerText()).toContain('Too risky before the release');
    await page.screenshot({ path: join(shots, 'map-02-decisions.png') });
    // A title jumps the conversation there, and the map follows.
    await page.getByTestId('map-task-title').first().click();
    await expect.poll(() => tasks.nth(0).getAttribute('class'), { timeout: 5000 }).toContain('current');

    // A fork of this agent: a lane off the task under way, to the new agent; in the new agent, where it came from.
    const fork = await invoke<Task>(page, 'task:fork', { taskId: a.taskId, isolate: false });
    // Folded, the task says it has one; opened, the lane to the new agent.
    await expect.poll(() => tasks.nth(1).innerText(), { timeout: 15_000 }).toContain('1 forks');
    await tasks.nth(1).getByTestId('map-caret').click();
    await expect.poll(() => tasks.nth(1).getByTestId('map-branch').count()).toBe(1);
    // Its avatar stays inside its box (a two-character alias shows one character, on one line).
    const avatar = await tasks.nth(1).getByTestId('map-branch').locator('.alias').evaluate((el) => ({ h: el.scrollHeight, w: el.scrollWidth, box: el.clientHeight, text: el.textContent }));
    expect(avatar.h).toBeLessThanOrEqual(avatar.box);
    expect(avatar.w).toBeLessThanOrEqual(avatar.box);
    expect(await tasks.nth(1).getByTestId('map-branch').innerText()).toContain(fork.alias);
    await page.screenshot({ path: join(shots, 'map-02b-fork.png') });

    // The reader merges the second task into the first.
    await tasks.nth(1).hover();
    await tasks.nth(1).getByTestId('map-merge').click();
    await expect.poll(titles).toEqual(['Clean the build']);

    // Beside the map, the conversation is centred in the room left of it: the blank on its left is no
    // wider than the gap between it and the map.
    const gaps = await page.evaluate(() => {
      const col = document.querySelector('.transcript-inner')!.getBoundingClientRect();
      const pane = document.querySelector('.focus-thread')!.getBoundingClientRect();
      const map = document.querySelector('[data-testid="session-map-beside"]')!.getBoundingClientRect();
      return { left: col.left - pane.left, right: map.left - col.right };
    });
    expect(Math.abs(gaps.left - gaps.right)).toBeLessThan(60);
    // And a margin on its right: nothing in it runs to the window's edge.
    const edge = await page.evaluate(() => {
      const pane = document.querySelector('.focus-thread')!.getBoundingClientRect();
      return Math.max(...[...document.querySelectorAll('[data-testid="session-map-beside"] *')].map((el) => el.getBoundingClientRect().right)) - pane.right;
    });
    expect(edge).toBeLessThanOrEqual(-24);

    // Narrow: not beside the conversation; its outline (no words) at the edge opens it in the side column.
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(() => page.getByTestId('session-map-beside').count()).toBe(0);
    await expect.poll(() => page.getByTestId('mini-task').count()).toBe(1);
    // The trunk only: each task's node and its decisions (what branched off, like the dropped attempt in
    // this task, is for the full map).
    expect(await page.locator('[data-testid="mini-task"] > *').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('class')))].sort())).toEqual(['mini-mark', 'mini-node']);
    expect(await page.getByTestId('session-minimap').innerText()).toBe('');
    // It sits in the margin, clear of the messages.
    const clear = await page.evaluate(() => {
      const mini = document.querySelector('[data-testid="session-minimap"]')!.getBoundingClientRect();
      const msgs = [...document.querySelectorAll('.transcript-inner > *')].map((m) => m.getBoundingClientRect());
      return msgs.every((m) => m.right <= mini.left || m.bottom <= mini.top || m.top >= mini.bottom);
    });
    expect(clear).toBe(true);
    // With no blank beside the messages at all, not even the outline (nothing floats over them).
    await page.setViewportSize({ width: 820, height: 900 });
    await expect.poll(() => page.getByTestId('session-minimap').count()).toBe(0);
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.getByTestId('session-minimap').click();
    await expect.poll(() => page.getByTestId('session-map-panel').count()).toBe(1);
    await expect.poll(() => page.getByTestId('session-minimap').count()).toBe(0);
    // Squeezed by the side column, the header's buttons stay square and the reply box's foot one line
    // (the key hints go).
    for (const w of [1100, 1000]) {
      await page.setViewportSize({ width: w, height: 900 });
      const shape = await page.evaluate(() => ({
        buttons: [...document.querySelectorAll('.focus-actions .btn.btn-icon')].map((b) => { const r = b.getBoundingClientRect(); return Math.abs(r.width - r.height); }),
        foot: document.querySelector('.composer-foot')!.getBoundingClientRect().height,
        hint: getComputedStyle(document.querySelector('[data-testid="composer-hint"]')!).display,
      }));
      expect(Math.max(...shape.buttons)).toBeLessThanOrEqual(1);
      expect(shape.foot).toBeLessThan(40);
      expect(shape.hint).toBe('none');
    }
    // Too narrow for both, it covers the conversation like a preview does; a task there closes it and goes.
    await page.setViewportSize({ width: 940, height: 900 });
    await expect.poll(() => page.locator('.focus-thread').isHidden()).toBe(true);
    expect(await page.getByTestId('session-map-panel').count()).toBe(1);
    await page.getByTestId('session-map-panel').getByTestId('map-task-title').first().click();
    await expect.poll(() => page.getByTestId('session-map-panel').count()).toBe(0);
    await expect.poll(() => page.locator('.focus-thread').isVisible()).toBe(true);
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.getByTestId('session-minimap').click();
    // The side column is resized like the preview: drag its edge.
    const panelW = () => page.getByTestId('session-map-panel').evaluate((el) => el.getBoundingClientRect().width);
    const before = await panelW();
    const bar = (await page.getByTestId('panel-resizer').boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + 200);
    await page.mouse.down();
    await page.mouse.move(bar.x + 100, bar.y + 200, { steps: 5 });
    await page.mouse.up();
    await expect.poll(panelW).toBeLessThan(before - 40);
    expect(await page.getByTestId('session-map-panel').getByTestId('map-task-title').allInnerTexts()).toEqual(['Clean the build']);
    await page.screenshot({ path: join(shots, 'map-03-panel.png') });

    // Sub-agents sent off in a task: lanes of their own (another agent; structure groups it, no fitting answer).
    await page.setViewportSize({ width: 1720, height: 960 });
    const b = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', mockScript: 'subagents', instruction: 'Move the orders API to v2.', isolate: false });
    const settledB = async () => !['running', 'starting'].includes((await snap()).tasks.find((t) => t.taskId === b.taskId)!.status);
    await expect.poll(settledB, { timeout: 30_000 }).toBe(true);
    await invoke(page, 'task:send', { taskId: b.taskId, text: 'Thanks, carry on.', via: 'text' });
    await expect.poll(settledB, { timeout: 30_000 }).toBe(true);
    await page.locator(`[data-testid="rail-item"][data-alias="${b.alias}"],[data-testid="needs-item"][data-alias="${b.alias}"]`).first().click();
    await expect.poll(() => page.getByTestId('map-subagent').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    expect(await page.getByTestId('map-subagent').first().innerText()).toContain('Find callers of the old API');
    await page.screenshot({ path: join(shots, 'map-04-subagents.png') });

    // The forked agent shows where it came from, and that leads back.
    await page.locator(`[data-testid="rail-item"][data-alias="${fork.alias}"],[data-testid="needs-item"][data-alias="${fork.alias}"]`).first().click();
    await invoke(page, 'task:send', { taskId: fork.taskId, text: 'Try another way.', via: 'text' });
    await expect.poll(() => page.getByTestId('map-origin').count(), { timeout: 30_000 }).toBe(1);
    expect(await page.getByTestId('map-origin').innerText()).toContain(a.alias);
    await page.getByTestId('map-origin').click();
    await expect.poll(() => page.locator('.focus-head').innerText()).toContain('Build');
    expect(errors).toEqual([]);
  }, 120_000);
});
