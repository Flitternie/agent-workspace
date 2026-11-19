// Sidebar teams and Overview layouts with mock agents (no paid calls). Screenshots in test-results/.
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
  const dir = join(mkdtempSync(join(tmpdir(), 'amw-teams-')), name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

describe('teams and overview layouts (mock agents)', () => {
  it('groups agents by project, surfaces who needs you, and fills a fixed layout by priority', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-teams-data-')), AMW_MOCK_DELAY_MS: '120', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
    await page.waitForSelector('.app');
    // The demo seeds three agents in "demo-shop" (two will ask the user something).
    await expect.poll(() => page.getByTestId('agent-card').count(), { timeout: 30_000 }).toBe(3);

    // A second team: a project with one agent that finishes its work.
    const legal = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo('legal-docs'), name: 'legal-docs' });
    await invoke<Task>(page, 'task:create', { projectId: legal.projectId, provider: 'mock', title: 'Contract deadlines', mockScript: 'work', instruction: 'List the deadline clauses.', isolate: false });

    // Teams: one per project, the one with agents waiting on you first.
    await expect.poll(() => page.getByTestId('team').count()).toBe(2);
    await expect.poll(async () => (await page.getByTestId('team').first().getAttribute('data-project')) ?? '').toBe('demo-shop');
    await expect.poll(() => page.getByTestId('team').first().getByTestId('team-head').innerText()).toMatch(/⚑ 2/);
    // Across teams: the "Needs you" strip lists the two waiting agents.
    await expect.poll(() => page.getByTestId('needs-item').count(), { timeout: 30_000 }).toBe(2);
    await page.screenshot({ path: join(shots, 'teams-01-sidebar.png') });

    // Folding a team hides its members (and their ⌘ numbers); unfolding brings them back.
    await page.getByTestId('team').first().getByTestId('team-head').click();
    await expect.poll(() => page.getByTestId('team').first().getByTestId('rail-item').count()).toBe(0);
    await page.getByTestId('team').first().getByTestId('team-head').click();
    await expect.poll(() => page.getByTestId('team').first().getByTestId('rail-item').count()).toBe(3);

    // Clicking an agent opens it without reshuffling the list (looking is not working with it).
    const order = () => page.getByTestId('rail-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-alias')).join(','));
    const before = await order();
    await page.getByTestId('rail-item').nth(2).click();
    await page.waitForTimeout(500);
    expect(await order()).toBe(before);
    expect(await page.getByTestId('team').evaluateAll((els) => els.map((e) => e.getAttribute('data-project')).join(','))).toBe('demo-shop,legal-docs');
    await page.getByRole('button', { name: /^Overview/ }).click();

    // The sidebar's edge drags wider, and stays so.
    const sidebarW = async () => (await page.locator('.sidebar').boundingBox())!.width;
    const w0 = await sidebarW();
    const edge = (await page.getByTestId('sidebar-resizer').boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 300);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + 100, edge.y + 300, { steps: 5 });
    await page.mouse.up();
    expect(Math.round((await sidebarW()) - w0)).toBe(100);
    expect(await page.evaluate(() => localStorage.getItem('amw.sidebar.width'))).toBe(String(Math.round(w0 + 100)));
    await page.screenshot({ path: join(shots, 'teams-00-wide-sidebar.png') });
    await page.getByTestId('sidebar-resizer').dblclick();
    expect(Math.round(await sidebarW())).toBe(252);
    // Dragged as narrow as it goes, it stops where the app's name still shows whole beside the window buttons.
    const edge2 = (await page.getByTestId('sidebar-resizer').boundingBox())!;
    await page.mouse.move(edge2.x + edge2.width / 2, edge2.y + 300);
    await page.mouse.down();
    await page.mouse.move(edge2.x - 200, edge2.y + 300, { steps: 5 });
    await page.mouse.up();
    expect(await sidebarW()).toBeLessThan(252);
    const fit = await page.evaluate(() => {
      const brand = document.querySelector('.sidebar .brand')!.getBoundingClientRect();
      const bar = document.querySelector('.sidebar')!.getBoundingClientRect();
      return brand.right <= bar.right - 8;
    });
    expect(fit).toBe(true);
    await page.getByTestId('sidebar-resizer').dblclick();

    // Overview layout with one tile: the agent waiting longest gets it; the rest wait on the left.
    await page.getByTestId('layout-1').click();
    await expect.poll(() => page.getByTestId('agent-card').count()).toBe(1);
    await expect.poll(async () => (await page.getByTestId('agent-card').first().getAttribute('data-alias')) ?? '').toBe('Alice');
    await expect.poll(() => page.getByTestId('overview-more').innerText()).toMatch(/3 more/);
    // Two tiles: both agents waiting on you, ahead of the ones that are working or done.
    await page.getByTestId('layout-2').click();
    await expect.poll(async () => (await page.getByTestId('agent-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-alias')).sort())).join(',')).toBe('Alice,Charlie');
    await page.screenshot({ path: join(shots, 'teams-02-layout-2.png') });
    // Automatic: every busy or recently busy agent.
    await page.getByTestId('layout-0').click();
    await expect.poll(() => page.getByTestId('agent-card').count()).toBe(4);
    await page.screenshot({ path: join(shots, 'teams-03-auto.png') });
  }, 120_000);
});
