import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/types';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
const invoke = <T,>(page: Page, c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<T>;
// The agent header at many widths, with and without the side column: never the name under the buttons,
// never a button past the edge, at most two rows (buttons lined up under the name when they wrap).
describe('agent header across widths', () => {
  it('keeps the name and buttons apart and in bounds at every width', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-w-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-w-r-'))), 'shop'); mkdirSync(dir); writeFileSync(join(dir, 'README.md'), '# shop\n'); execFileSync('git', ['init', '-q'], { cwd: dir });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: dir, name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders dashboard migration', name: 'Orders dashboard migration', mockScript: 'work', instruction: 'Do.', isolate: false });
    await expect.poll(() => page.getByTestId('agent-card').count(), { timeout: 30000 }).toBe(1);
    await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"]`).click();
    await page.waitForTimeout(1500);
    const out: unknown[] = [];
    for (const preview of [false, true]) {
      if (preview) { await page.evaluate((id) => localStorage.setItem(`amw.preview.${id}`, JSON.stringify({ path: 'README.md' })), a.taskId); await page.getByRole('button', { name: /^Overview/ }).click(); await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"]`).click(); }
      for (const w of [1280, 1100, 960, 860, 760, 680]) {
        await page.setViewportSize({ width: w, height: 800 });
        await page.waitForTimeout(400);
        out.push(await page.evaluate(([w, preview]) => {
          const r = (q: string) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
          const acts = [...document.querySelectorAll('.focus-actions > *')].map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right)]; });
          const lab = document.querySelector('[data-testid="mic-label"]')?.getBoundingClientRect() ?? { height: 0 };
          return { w, preview, micLabelH: Math.round(lab.height), dockInput: r('.dock-input'), head: r('.focus-head'), ident: r('.focus-ident'), name: r('.focus-name'), nameScroll: (document.querySelector('.focus-name') as HTMLElement).scrollWidth, actions: r('.focus-actions'), acts, sidebar: r('.sidebar') ?? r('aside'), stage: r('.stage'), win: innerWidth };
        }, [w, preview] as const));
      }
    }
    for (const g of out as Array<{ w: number; preview: boolean; head: number[]; ident: number[]; actions: number[]; acts: number[][]; nameScroll: number }>) {
      const where = `${g.w}px${g.preview ? ' with preview' : ''}`;
      const [hl, , hw, hh] = g.head;
      const sameRow = Math.abs(g.ident[1] - g.actions[1]) < 20;
      // Side by side: the name ends before the buttons begin.
      if (sameRow) expect(g.ident[0] + g.ident[2], where).toBeLessThanOrEqual(g.actions[0]);
      // Every button inside the header, all on one line.
      for (const a of g.acts) expect(a[2], where).toBeLessThanOrEqual(hl + hw);
      expect(new Set(g.acts.map((a) => a[1])).size, where).toBe(1);
      // One row, or two (buttons under the name, starting where the name starts).
      expect(hh, where).toBeLessThanOrEqual(100);
      if (!sameRow) expect(Math.abs(g.actions[0] - g.ident[0]), where).toBeLessThanOrEqual(2);
      // No voice bar on an agent's page: its box is the only one (the mic sits beside it).
      expect((g as unknown as { dockInput: number[] | null }).dockInput, where).toBeNull();
      // The name shortens (ellipsis) instead of overflowing its column.
      expect(g.nameScroll, where).toBeLessThanOrEqual(g.ident[2] + 1);
    }    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(appDir, 'test-results', 'widths-dock-narrow.png') });
    // Voice not set up: no words, the slashed mic is the way in (it opens Settings).
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await page.getByTestId('mic-label').count()).toBe(0);
    expect(await page.getByTestId('mic-button').getAttribute('title')).toBe('Set up voice');
    await page.getByTestId('mic-button').click();
    await expect.poll(() => page.locator('[data-testid="settings-page"], .settings').count()).toBeGreaterThan(0);
    await app.close();
  }, 120000);
});
