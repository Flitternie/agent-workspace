// The agent header's tokens, context and account limits (mock agent: fixed counts per turn), their
// cards, and that the totals outlive a relaunch. The first message and "resumed · <id>" are gone.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionRecord, Task } from '../../src/shared/types';

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

async function launch(dataDir: string): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_MOCK_DELAY_MS: '40', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.app');
  return page;
}

describe('session usage in the agent header', () => {
  it('shows tokens, context and limits with their breakdowns, and keeps the totals across a relaunch', async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-usage-')));
    const dir = join(scratch, 'shop');
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '# shop\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const dataDir = join(scratch, 'data');
    let page = await launch(dataDir);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await invoke(page, 'settings:update', { onboarding: { dismissed: true }, language: 'en' });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: dir, name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: '/clear', name: 'Orders', mockScript: 'work', instruction: '/clear', isolate: false });
    const snap = () => invoke<{ tasks: Task[]; sessions: SessionRecord[] }>(page, 'workspace:snapshot', {});
    const settled = async () => !['running', 'starting'].includes((await snap()).tasks.find((t) => t.taskId === a.taskId)!.status);
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"]`).click();

    // One turn: 35K tokens, 30K of the 34.2K input read from the cache; 24.7K of a 1M context.
    const tokens = page.getByTestId('usage-tokens');
    await expect.poll(() => tokens.innerText()).toContain('35K tok · 88% cached');
    expect(await page.getByTestId('usage-context').innerText()).toBe('2%');
    expect(await page.getByTestId('usage-limits').innerText()).toBe('Limits 5h 34% · week 35%');
    expect(await page.getByTestId('usage-limits').getAttribute('class')).not.toContain('hot');

    // Neither the first message nor "resumed · <id>"; the session id is on the provider's tag.
    const meta = await page.locator('.focus-meta').innerText();
    const now = await snap();
    const nativeId = now.sessions.find((s) => s.localId === now.tasks.find((t) => t.taskId === a.taskId)!.sessionLocalId)!.nativeSessionId!;
    expect(meta).not.toContain('/clear');
    expect(meta).not.toMatch(/managed|resumed/);
    expect(meta).not.toContain(nativeId.slice(0, 8));
    expect(await page.getByTestId('session-tag').getAttribute('title')).toContain(nativeId);
    expect(await page.getByTestId('memory-chip').count()).toBe(1);
    expect(meta).toContain('shop');

    const head = async (name: string) => {
      const box = (await page.locator('.focus-head').boundingBox())!;
      await page.screenshot({ path: join(shots, name), clip: { x: box.x, y: box.y, width: Math.min(900, box.width), height: box.height + 260 } });
    };
    await head('usage-header.png');

    // The tokens card: the breakdown and the API-price reference.
    await tokens.click();
    const tokensPop = page.getByTestId('usage-tokens-pop');
    await expect.poll(() => tokensPop.isVisible()).toBe(true);
    const tp = await tokensPop.innerText();
    for (const s of ['Total', '35,000', 'Cache hit', '88%', 'Uncached input', '1,200', 'Cache write', '3,000', 'Cache read', '30,000', 'Output', '800', '≈ $0.12 at API prices', 'not a charge']) expect(tp).toContain(s);
    await head('usage-tokens-pop.png');
    await page.keyboard.press('Escape');
    await expect.poll(() => tokensPop.count()).toBe(0);
    // Esc closed only the card: still on the agent's page.
    expect(await page.locator('.focus-head').count()).toBe(1);

    await page.getByTestId('usage-context').click();
    expect(await page.getByTestId('usage-context-pop').innerText()).toContain('~24.7K / 1M');
    await head('usage-context-pop.png');
    await page.mouse.click(700, 600);
    await expect.poll(() => page.getByTestId('usage-context-pop').count()).toBe(0);

    await page.getByTestId('usage-limits').click();
    const lp = page.getByTestId('usage-limits-pop');
    expect(await lp.getByTestId('usage-limit').count()).toBe(2);
    const lt = await lp.innerText();
    expect(lt).toContain('34% used');
    expect(lt).toContain('35% used');
    expect(lt).toMatch(/resets in 1h 5\dm|resets in 2h 0m/);
    await head('usage-limits-pop.png');
    await page.keyboard.press('Escape');

    // A second turn adds to the totals; the context grows.
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'Next step.', via: 'text' });
    await expect.poll(() => tokens.innerText(), { timeout: 30_000 }).toContain('70K tok');
    await expect.poll(settled, { timeout: 30_000 }).toBe(true);
    expect(await page.getByTestId('usage-context').innerText()).toBe('3%');

    // Chinese.
    await invoke(page, 'settings:update', { language: 'zh' });
    await expect.poll(() => tokens.innerText()).toContain('70K tok · 缓存命中 88%');
    expect(await page.getByTestId('usage-limits').innerText()).toBe('额度 5h 34% · 周 35%');
    await head('usage-header-zh.png');
    await invoke(page, 'settings:update', { language: 'en' });
    expect(errors).toEqual([]);

    // Relaunch: the totals and the last limits are still there before any new turn.
    await app!.close();
    page = await launch(dataDir);
    await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"]`).click();
    await expect.poll(() => page.getByTestId('usage-tokens').innerText()).toContain('70K tok · 88% cached');
    expect(await page.getByTestId('usage-context').innerText()).toBe('3%');
    expect(await page.getByTestId('usage-limits').innerText()).toBe('Limits 5h 34% · week 35%');

    // Another agent of the same provider nearly used up the 5-hour window: highlighted here too.
    const b = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Docs', name: 'Docs', mockScript: 'work limits-high', instruction: 'Write docs.', isolate: false });
    await expect.poll(async () => !['running', 'starting'].includes((await invoke<{ tasks: Task[] }>(page, 'workspace:snapshot', {})).tasks.find((t) => t.taskId === b.taskId)!.status), { timeout: 30_000 }).toBe(true);
    await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"]`).click();
    const limits = page.getByTestId('usage-limits');
    await expect.poll(() => limits.innerText()).toBe('Limits 5h 86% · week 35%');
    expect(await limits.getAttribute('class')).toContain('hot');
    await limits.click();
    expect(await page.locator('[data-testid="usage-limits-pop"] .usage-limit.hot').count()).toBe(1);
    await head('usage-limits-hot.png');
    // Its own totals are its own.
    expect(await page.getByTestId('usage-tokens').innerText()).toContain('70K tok');
  }, 120_000);
});
