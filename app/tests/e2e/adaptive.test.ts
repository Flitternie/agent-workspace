// Width follows the window: Overview columns, and one conversation column (mock agents).
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
  const dir = join(mkdtempSync(join(tmpdir(), 'amw-adapt-')), name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

describe('width follows the window', () => {
  it('keeps a layout’s tiles in fewer columns when narrow; the conversation is one column that adapts', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-adapt-data-')), AMW_MOCK_DELAY_MS: '100', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    // Not about the first-run guide: skip it, as a returning user has.
    await page.evaluate(() => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke('settings:update', { onboarding: { dismissed: true } }));
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo('shop'), name: 'shop' });
    const tasks: Task[] = [];
    for (let i = 1; i <= 6; i++)
      tasks.push(await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: `Task ${i}`, name: `Task ${i}`, mockScript: 'work', instruction: `Do task ${i}.`, isolate: false }));
    await expect.poll(() => page.getByTestId('agent-card').count(), { timeout: 30_000 }).toBe(6);

    // Six tiles: 3×2 where there is room…
    await page.getByTestId('layout-6').click();
    const cols = async () => Number(await page.getByTestId('overview').getAttribute('data-cols'));
    await expect.poll(cols).toBe(3);
    await page.screenshot({ path: join(shots, 'adaptive-01-wide.png') });
    // …2×3 when the window narrows (still six, none squeezed below a readable width).
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(cols).toBe(2);
    expect(await page.getByTestId('agent-card').count()).toBe(6);
    const tileW = (await page.getByTestId('agent-card').first().boundingBox())!.width;
    expect(tileW).toBeGreaterThanOrEqual(320);
    await page.screenshot({ path: join(shots, 'adaptive-02-narrow.png') });

    // The conversation: text, requests and composer share one width and one left edge, and that
    // width follows the room (80%, between 908 and 1160 when there is room).
    const column = async () =>
      page.evaluate(() => {
        const r = (sel: string) => {
          const e = document.querySelector(sel);
          return e ? e.getBoundingClientRect() : null;
        };
        const pane = r('.focus-thread')!;
        // The transcript's room, without its scrollbar gutters (always-visible scrollbars).
        const room = document.querySelector('.transcript')!.clientWidth;
        return { pane: pane.width, room, text: r('.transcript-inner'), composer: r('.composer') };
      });
    for (const width of [1440, 1180, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator(`[data-testid="rail-item"][data-alias="${tasks[0].alias}"]`).click();
      await expect.poll(async () => (await column()).text?.width ?? 0).toBeGreaterThan(0);
      const c = await column();
      const col = Math.min(1160, Math.max(908, c.pane * 0.8));
      expect(Math.abs(c.text!.width - Math.min(col, c.room))).toBeLessThanOrEqual(2);
      expect(Math.abs(c.composer!.width - Math.min(col, c.pane))).toBeLessThanOrEqual(2);
      // Where the column fits, text and composer are the same width on the same left edge, even
      // when the transcript scrolls with a visible scrollbar.
      if (col <= c.room) {
        expect(Math.abs(c.composer!.width - c.text!.width)).toBeLessThanOrEqual(2);
        expect(Math.abs(c.composer!.left - c.text!.left)).toBeLessThanOrEqual(2);
      }
      await page.screenshot({ path: join(shots, `adaptive-03-conversation-${width}.png`) });
    }
  }, 120_000);
});
