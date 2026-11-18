// Preview foundation and "Open with…" (mock agents, fake app bundles, launches recorded not run).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

function repo(): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-prev-'))), 'shop');
  mkdirSync(join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# shop\n');
  writeFileSync(join(dir, 'src/big.ts'), Array.from({ length: 300 }, (_, i) => `export const v${i + 1} = ${i + 1};`).join('\n') + '\n');
  // Long rows that wrap: line finding must not drift.
  writeFileSync(join(dir, 'notes.txt'), Array.from({ length: 120 }, (_, i) => `row ${i + 1} ` + 'word '.repeat(i % 3 === 0 ? 60 : 2)).join('\n') + '\n');
  writeFileSync(join(dir, 'src/orders.ts'), 'export const total = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function fakeApps(): string {
  const root = mkdtempSync(join(tmpdir(), 'amw-apps-'));
  for (const [bundle, cli] of [
    ['Cursor.app', 'Contents/Resources/app/bin/cursor'],
    ['Fork.app', ''],
    ['Finder.app', ''],
  ]) {
    mkdirSync(join(root, bundle, 'Contents'), { recursive: true });
    if (cli) {
      mkdirSync(join(root, bundle, cli, '..'), { recursive: true });
      writeFileSync(join(root, bundle, cli), '#!/bin/sh\n');
    }
  }
  return root;
}

describe('preview and open with…', () => {
  it('opens folders and files in the user’s apps, jumps to lines, remembers previews per agent, covers when narrow', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    const record = join(mkdtempSync(join(tmpdir(), 'amw-open-')), 'launches.jsonl');
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-prev-data-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_APPS_DIRS: fakeApps(), AMW_OPEN_RECORD: record },
    });
    const launches = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cmd: string; args: string[] }) : []);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const row = (name: string) => page.locator('[data-testid="rail-item"],[data-testid="needs-item"]').filter({ hasText: name }).first();
    const root = repo();
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Paths', name: 'Paths', mockScript: 'ask:`src/big.ts:200` notes.txt:100 README.md', instruction: 'Point me at lines.', isolate: false });
    const b = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', mockScript: 'work', instruction: 'Do orders.', isolate: false });
    await expect.poll(() => page.getByTestId('agent-card').count(), { timeout: 30_000 }).toBe(2);

    // From an overview card: the file an activity row touched opens with the agent, in the preview.
    const orders = page.getByTestId('agent-card').filter({ hasText: 'Orders' });
    await expect.poll(() => orders.getByTestId('card-preview-file').count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await orders.getByTestId('card-preview-file').first().click();
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('data-path')).toBe('src/orders.ts');
    await expect.poll(() => page.getByTestId('file-preview').innerText()).toContain('export const total');

    // Open with…: the agent's folder in Cursor (the menu lists only what is installed).
    await page.getByTestId('open-folder-in').getByTestId('open-in-more').click();
    const items = page.getByTestId('open-in-menu').getByTestId('open-in-item');
    expect(await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-app')))).toEqual(['cursor', 'fork', 'finder']);
    await page.screenshot({ path: join(shots, 'open-in-01-folder-menu.png') });
    await page.getByTestId('open-in-menu').locator('[data-app="cursor"]').click();
    await expect.poll(() => launches().length).toBe(1);
    expect(launches()[0].cmd).toBe('open');
    expect(launches()[0].args.slice(0, 1)).toEqual(['-a']);
    expect(launches()[0].args[1]).toMatch(/Cursor\.app$/);
    expect(launches()[0].args[2]).toBe(root);
    // Remembered: the main button now opens in Cursor in one click.
    await expect.poll(() => page.getByTestId('open-folder-in').getByTestId('open-in-main').getAttribute('aria-label')).toContain('Cursor');

    // Agent A: a path:line in its message previews at that line, highlighted.
    await row('Paths').click();
    await expect.poll(() => page.locator('.focus-thread').innerText(), { timeout: 30_000 }).toContain('README.md');
    await page.locator('[data-testid="md-file"][data-line="200"]').first().click();
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('data-path')).toBe('src/big.ts');
    await expect.poll(() => page.getByTestId('line-flash').count()).toBe(1);
    const visible = async (text: string) =>
      page.evaluate((needle) => {
        const panel = document.querySelector('[data-testid="file-preview"]')!.getBoundingClientRect();
        const flash = document.querySelector('[data-testid="line-flash"]')!.getBoundingClientRect();
        // The highlight sits on the line asked for, and it is on screen.
        const walker = document.createTreeWalker(document.querySelector('[data-testid="file-preview"]')!, NodeFilter.SHOW_TEXT);
        let hit: DOMRect | null = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = n.textContent!.indexOf(needle);
          if (i >= 0) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + needle.length);
            hit = r.getBoundingClientRect();
            break;
          }
        }
        return { inView: flash.top >= panel.top && flash.bottom <= panel.bottom, onLine: !!hit && Math.abs(hit.top + hit.height / 2 - (flash.top + flash.height / 2)) < flash.height / 2 + 1 };
      }, text);
    await expect.poll(() => visible('v200')).toEqual({ inView: true, onLine: true });
    await page.screenshot({ path: join(shots, 'open-in-02-line-jump.png') });
    // Full height on the right, beside the agent's header and the voice bar; both headers share one top row.
    const box = (sel: string) => page.evaluate((q) => { const r = document.querySelector(q)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, left: r.left }; }, sel);
    expect((await box('[data-testid="file-preview"]')).top).toBe(0);
    expect((await box('[data-testid="file-preview"]')).bottom).toBe(900);
    expect(Math.abs((await box('.preview-top')).height - (await box('.focus-head')).height)).toBeLessThanOrEqual(1);
    // In the narrow agent column the permission menu is its shield icon, and still a working menu.
    expect(Math.round((await box('.perm')).height)).toBe(30);
    await page.getByTestId('task-permission').selectOption('ask');
    await expect.poll(async () => (await invoke<{ tasks: Task[] }>(page, 'workspace:snapshot', {})).tasks.find((t) => t.taskId === a.taskId)?.permissionMode).toBe('ask');
    expect((await box('.dock')).left).toBeLessThan((await box('[data-testid="file-preview"]')).left);

    // The same file at its line in Cursor: the editor's own CLI with file:line.
    await page.getByTestId('file-preview').getByTestId('open-in-more').click();
    await page.getByTestId('open-in-menu').locator('[data-app="cursor"]').click();
    await expect.poll(() => launches().length).toBe(2);
    expect(launches()[1].cmd).toMatch(/Cursor\.app\/Contents\/Resources\/app\/bin\/cursor$/);
    expect(launches()[1].args).toEqual(['-g', `${join(root, 'src/big.ts')}:200`]);
    // Finder reveals the file.
    await page.getByTestId('file-preview').getByTestId('open-in-more').click();
    await page.getByTestId('open-in-menu').locator('[data-app="finder"]').click();
    await expect.poll(() => launches().length).toBe(3);
    expect(launches()[2]).toEqual({ cmd: 'open', args: ['-R', join(root, 'src/big.ts')] });

    // Wrapped plain text: line 100 is found exactly, even with long rows above it.
    await page.locator('[data-testid="md-file"][data-line="100"]').first().click();
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('data-path')).toBe('notes.txt');
    await expect.poll(() => visible('row 100 ')).toEqual({ inView: true, onLine: true });
    // …and fades out and goes.
    await expect.poll(() => page.getByTestId('line-flash').count(), { timeout: 5000 }).toBe(0);

    // Asked for again while shown: the panel flashes (not a second panel).
    await page.locator('[data-testid="md-file"][data-line="100"]').first().click();
    const pulse = await page.getByTestId('file-preview').getAttribute('data-pulse');
    await page.locator('[data-testid="md-file"][data-line="100"]').first().click();
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('data-pulse')).not.toBe(pulse);
    expect(await page.getByTestId('file-preview').getAttribute('data-pulse')).toBeTruthy();
    expect(await page.getByTestId('file-preview').count()).toBe(1);

    // Changed on disk by something other than the agent: the preview reads it again.
    writeFileSync(join(root, 'notes.txt'), 'rewritten outside the agent\n');
    await expect.poll(() => page.getByTestId('file-preview').innerText(), { timeout: 10_000 }).toContain('rewritten outside the agent');

    // Per agent: B still shows its own file, A comes back with notes.txt.
    await row('Orders').click();
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('data-path')).toBe('src/orders.ts');
    await row('Paths').click();
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('data-path')).toBe('notes.txt');

    // Width rules: the conversation keeps 400px; too narrow for both, the preview covers it.
    const widths = () => page.evaluate(() => ({ preview: document.querySelector('[data-testid="file-preview"]')!.getBoundingClientRect().width, thread: (document.querySelector('.focus-thread') as HTMLElement).offsetParent ? document.querySelector('.focus-thread')!.getBoundingClientRect().width : 0 }));
    const wide = await widths();
    expect(wide.thread).toBeGreaterThanOrEqual(400);
    expect(wide.preview).toBeGreaterThanOrEqual(300);
    await page.setViewportSize({ width: 820, height: 800 });
    await expect.poll(async () => (await widths()).thread).toBe(0);
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('class')).toContain('maximized');
    await page.screenshot({ path: join(shots, 'open-in-03-narrow-cover.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await widths()).thread).toBeGreaterThanOrEqual(400);

    // Maximized: the preview takes the conversation's place under the agent's header, then goes back to the side.
    await page.getByTestId('preview-maximize').click();
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('class')).toContain('maximized');
    expect(await page.getByTestId('stage-side').evaluate((e) => e.childElementCount)).toBe(0);
    await page.screenshot({ path: join(shots, 'open-in-05-maximized.png') });
    await page.getByTestId('preview-maximize').click();
    await expect.poll(() => page.getByTestId('stage-side').evaluate((e) => e.childElementCount)).toBeGreaterThan(0);
    // Memory takes the same full-height column.
    await page.getByTestId('memory-chip').click();
    await expect.poll(() => page.locator('[data-testid="stage-side"] > .memory').count()).toBe(1);
    await page.screenshot({ path: join(shots, 'open-in-06-memory.png') });

    // Remove asks in the app's own dialog (not the system's): Cancel keeps the agent, Remove removes it.
    await row('Orders').click();
    await page.getByTestId('remove-task').click();
    await expect.poll(() => page.getByTestId('confirm-dialog').count()).toBe(1);
    await page.screenshot({ path: join(shots, 'open-in-04-remove-confirm.png') });
    await page.getByTestId('confirm-cancel').click();
    expect(await page.getByTestId('confirm-dialog').count()).toBe(0);
    expect((await invoke<{ tasks: Task[] }>(page, 'workspace:snapshot', {})).tasks.some((t) => t.taskId === b.taskId)).toBe(true);
    await page.getByTestId('remove-task').click();
    await page.keyboard.press('Escape');
    expect(await page.getByTestId('confirm-dialog').count()).toBe(0);
    await page.getByTestId('remove-task').click();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(async () => (await invoke<{ tasks: Task[] }>(page, 'workspace:snapshot', {})).tasks.some((t) => t.taskId === b.taskId)).toBe(false);
    void a;
  }, 120_000);
});
