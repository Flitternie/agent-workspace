// Sub-agents in the sidebar and on cards (mock agents, Chinese UI). Screenshots in test-results/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function repo(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'amw-sub-')), name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

describe('sub-agents (mock agents)', () => {
  it('shows them as dots that unfold into half-height thread rows, apart from sessions', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-sub-data-')), AMW_MOCK_DELAY_MS: '150', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
    await page.waitForSelector('.app');
    // Not about the first-run guide: skip it, as a returning user has.
    await page.evaluate(() => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke('settings:update', { onboarding: { dismissed: true } }));
    await invoke(page, 'settings:update', { language: 'zh' });

    const shop = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo('shop'), name: 'shop' });
    const legal = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo('legal-docs'), name: 'legal-docs' });
    const mk = (projectId: string, title: string, mockScript: string, instruction: string) =>
      invoke<Task>(page, 'task:create', { projectId, provider: 'mock', title, mockScript, instruction, isolate: false });
    const orders = await mk(shop.projectId, '订单接口迁移到 v2', 'subagents', '把订单接口迁移到 v2，旧的调用方一起改掉。');
    await mk(shop.projectId, '登录页暗色模式', 'work', '给登录页加暗色模式。');
    await mk(shop.projectId, '数据库结构迁移', 'ask:要删除旧的 orders.notes 列，直接执行还是先回填数据？', '为新的订单表写数据库迁移。');
    await mk(legal.projectId, '合同条款时效梳理', 'work', '梳理合同里所有和时效相关的条款。');

    const row = page.locator(`[data-testid="rail-item"][data-alias="${orders.alias}"]`);
    // Folded: a small mark on the agent's own row, nothing more.
    // One fixed-width mark: the count, coloured while any is running.
    await expect.poll(() => row.getByTestId('subtask-dots').innerText(), { timeout: 30_000 }).toBe('3');
    expect(await row.getByTestId('subtask-dots').getAttribute('data-state')).toBe('running');
    expect(await page.getByTestId('subtask-row').count()).toBe(0);
    await page.screenshot({ path: join(shots, 'subtasks-01-folded.png') });
    // Alignment: the mark's centre sits on the centre of the text beside it (sidebar line, card status).
    const align = await page.evaluate((alias) => {
      const box = (e: Element | null) => (e ? e.getBoundingClientRect() : null);
      const mid = (r: DOMRect | null) => (r ? r.top + r.height / 2 : NaN);
      const row = document.querySelector(`[data-testid="rail-item"][data-alias="${alias}"]`)!;
      const badge = row.querySelector('[data-testid="subtask-dots"]')!;
      // The text right after the mark, measured on its own glyph box.
      const textNode = [...badge.parentElement!.childNodes].find((n) => n.nodeType === 3 && n.textContent!.trim()) ?? null;
      const range = document.createRange();
      if (textNode) range.selectNodeContents(textNode);
      const textRect = textNode ? range.getClientRects()[0] : null;
      const card = document.querySelector(`[data-testid="agent-card"][data-alias="${alias}"]`)!;
      const cBadge = card.querySelector('[data-testid="subtask-dots"]')!;
      const status = card.querySelector('.status-text');
      return {
        side: { badge: mid(box(badge)), icon: mid(box(badge.querySelector('.icon'))), count: mid(box(badge.querySelector('.subtask-count'))), text: mid(textRect as DOMRect), badgeH: box(badge)!.height, textH: textRect?.height },
        card: { badge: mid(box(cBadge)), icon: mid(box(cBadge.querySelector('.icon'))), count: mid(box(cBadge.querySelector('.subtask-count'))), status: mid(box(status)), badgeH: box(cBadge)!.height, statusH: box(status)!.height },
      };
    }, orders.alias);
    writeFileSync(join(shots, 'subtasks-align.json'), JSON.stringify(align, null, 2));
    const off = (a: number, b: number) => Math.abs(a - b);
    expect(off(align.side.badge, align.side.text)).toBeLessThanOrEqual(1);
    expect(off(align.side.icon, align.side.count)).toBeLessThanOrEqual(1);
    expect(off(align.card.badge, align.card.status)).toBeLessThanOrEqual(1);
    expect(off(align.card.icon, align.card.count)).toBeLessThanOrEqual(1);

    // Hover: what each one is doing.
    await row.getByTestId('subtask-dots').hover();
    await expect.poll(() => page.getByTestId('subtask-pop').count()).toBe(1);
    await expect.poll(() => page.getByTestId('subtask-pop').innerText()).toContain('补充接口测试');
    // Playwright's screenshot reads as the pointer leaving (the card closes); capture the window from Electron instead.
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync(join(shots, 'subtasks-02-hover.png'), Buffer.from(png, 'base64'));

    // Click the dots: half-height rows on a thread line; the row itself still opens the agent.
    await row.getByTestId('subtask-dots').click();
    await expect.poll(() => page.locator('.sidebar').getByTestId('subtask-row').count()).toBe(3);
    // Unfolded, the agent's row and its sub-agents are one card.
    expect(await page.locator('.sidebar .agent-item.unfolded').getByTestId('subtask-row').count()).toBe(3);
    expect(await page.locator('.sidebar .agent-item.unfolded').getByTestId('rail-item').getAttribute('data-alias')).toBe(orders.alias);
    expect(await page.getByTestId('stage-head-focus').count()).toBe(0);
    const subH = (await page.locator('.sidebar').getByTestId('subtask-row').first().boundingBox())!.height;
    const rowH = (await row.boundingBox())!.height;
    expect(subH).toBeLessThanOrEqual(22);
    expect(rowH).toBeGreaterThan(subH * 1.8);
    await page.mouse.move(800, 30);
    await page.screenshot({ path: join(shots, 'subtasks-03-unfolded.png') });
    await page.locator('.sidebar').screenshot({ path: join(shots, 'subtasks-03b-sidebar.png') });

    // On its Overview card, the same dots unfold above the card's activity.
    const card = page.locator(`[data-testid="agent-card"][data-alias="${orders.alias}"]`);
    await card.getByTestId('subtask-dots').click();
    await expect.poll(() => card.getByTestId('subtask-row').count()).toBe(3);
    await page.mouse.move(800, 30);
    await page.screenshot({ path: join(shots, 'subtasks-04-card.png') });
    await card.screenshot({ path: join(shots, 'subtasks-04b-card.png') });

    // Click a sub-agent: its run, read-only (each step, and what it reported back).
    await page.locator('.sidebar').getByTestId('subtask-row').filter({ hasText: '检查更新日志' }).click();
    await expect.poll(() => page.getByTestId('subtask-view').isVisible()).toBe(true);
    await expect.poll(() => page.getByTestId('subtask-steps').locator('li').count()).toBe(2);
    await expect.poll(() => page.getByTestId('subtask-result').innerText()).toContain('cursor');
    await page.mouse.move(800, 30);
    await page.screenshot({ path: join(shots, 'subtasks-05-view.png') });
    // Back goes to the agent it belongs to.
    await page.getByTestId('subtask-back').click();
    await expect.poll(() => page.getByTestId('subtask-view').count()).toBe(0);
    console.log(`row ${rowH}px, sub-agent row ${subH}px`);
  }, 120_000);
});
