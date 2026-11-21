// One right-click menu everywhere (agent rows, project heads, the agent's header, messages), and
// renaming agents, titles and projects in place from it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task, WorkspaceSnapshot } from '../../src/shared/types';

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
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-rename-'))), 'shop');
  mkdirSync(dir);
  writeFileSync(join(dir, 'README.md'), '# shop\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function launch(dataDir: string): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    cwd: appDir,
    env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: dataDir, AMW_MOCK_DELAY_MS: '30', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.app');
  return page;
}

describe('right-click menu and renaming', () => {
  it('renames agents, titles and projects in place; one menu style; renames survive a relaunch', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-rename-data-'));
    let page = await launch(dataDir);
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo(), name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', mockScript: 'work', instruction: 'Do orders.', isolate: false });
    const b = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Charts', name: 'Charts', mockScript: 'work', instruction: 'Do charts.', isolate: false });
    const row = (alias: string) => page.locator(`[data-testid="rail-item"][data-alias="${alias}"]`);
    const menu = page.getByTestId('context-menu');
    const items = () => menu.getByRole('menuitem').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    await row(a.alias).waitFor();
    await expect.poll(() => row(a.alias).getByTestId('row-dot').getAttribute('data-dot'), { timeout: 30_000 }).toBe('done');

    // Sidebar row: the agent's items, in the shared menu; the keyboard moves the highlight, Esc closes.
    await row(a.alias).click({ button: 'right' });
    await menu.waitFor();
    expect(await items()).toEqual(['menu-rename-agent', 'menu-rename-title', 'menu-set-aside', 'menu-open']);
    // From the pointer nothing is highlighted until a key or the pointer moves.
    expect(await menu.locator('button.active').count()).toBe(0);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await menu.locator('button.active').getAttribute('data-testid')).toBe('menu-rename-title');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect(await menu.locator('button.active').getAttribute('data-testid')).toBe('menu-open');
    const box = (await menu.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(1440);
    await page.screenshot({ path: join(shots, 'rename-01-row-menu.png') });
    await page.keyboard.press('Escape');
    await expect.poll(() => menu.count()).toBe(0);
    // Esc closed the menu only: still on the Overview, nothing else stepped back.
    expect(await page.getByTestId('agent-card').count()).toBe(2);
    // From the keyboard (Shift+F10 on a focused row): under the row, its first item highlighted.
    await row(b.alias).focus();
    await page.keyboard.press('Shift+F10');
    await menu.waitFor();
    expect(await menu.locator('button.active').getAttribute('data-testid')).toBe('menu-rename-agent');
    await page.keyboard.press('Escape');
    await expect.poll(() => menu.count()).toBe(0);
    // F2 on a row renames its title; Esc leaves it as it was.
    await row(b.alias).focus();
    await page.keyboard.press('F2');
    await page.getByTestId('rename-title-input').waitFor();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByTestId('rename-title-input').count()).toBe(0);
    // Opened at the window's bottom-right corner, it opens inward; a click elsewhere closes it.
    await row(a.alias).evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1438, clientY: 898 })));
    await menu.waitFor();
    const corner = (await menu.boundingBox())!;
    expect(corner.x + corner.width).toBeLessThanOrEqual(1440);
    expect(corner.y + corner.height).toBeLessThanOrEqual(900);
    expect(corner.x).toBeLessThan(1438 - 100);
    await page.mouse.click(700, 450);
    await expect.poll(() => menu.count()).toBe(0);

    // Rename the agent in place, chosen with the keyboard.
    await row(a.alias).click({ button: 'right' });
    await menu.waitFor();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const aliasInput = page.getByTestId('rename-agent-input');
    await aliasInput.waitFor();
    expect(await aliasInput.inputValue()).toBe(a.alias);
    await aliasInput.fill('Rosa');
    await aliasInput.press('Enter');
    await row('Rosa').waitFor();
    expect(await row('Rosa').innerText()).toMatch(/Orders\s*Rosa/);

    // A name another agent has is refused, with a message under the field; Esc cancels.
    await row(b.alias).click({ button: 'right' });
    await page.getByTestId('menu-rename-agent').click();
    await page.getByTestId('rename-agent-input').fill('rosa');
    await page.getByTestId('rename-agent-input').press('Enter');
    await expect.poll(() => page.getByTestId('rename-agent-input-problem').innerText()).toMatch(/already has this name/);
    await page.screenshot({ path: join(shots, 'rename-02-in-place-refused.png') });
    await page.getByTestId('rename-agent-input').fill('main');
    await page.getByTestId('rename-agent-input').press('Enter');
    await expect.poll(() => page.getByTestId('rename-agent-input-problem').innerText()).toMatch(/already means something/);
    await page.getByTestId('rename-agent-input').press('Escape');
    await expect.poll(() => page.getByTestId('rename-agent-input').count()).toBe(0);
    expect(await row(b.alias).count()).toBe(1);

    // Rename the title from the row; then from the header, where Esc cancels.
    await row(b.alias).click({ button: 'right' });
    await page.getByTestId('menu-rename-title').click();
    await page.getByTestId('rename-title-input').fill('合并65、67并发布');
    await page.screenshot({ path: join(shots, 'rename-03-in-place-title.png') });
    await page.getByTestId('rename-title-input').press('Enter');
    await expect.poll(() => row(b.alias).innerText()).toMatch(/合并65、67并发布/);

    await row('Rosa').click();
    const title = page.getByTestId('focus-title');
    await expect.poll(() => title.innerText()).toMatch(/Orders\s*Rosa/);
    await title.click({ button: 'right' });
    expect(await items()).toEqual(['menu-rename-agent', 'menu-rename-title']);
    await page.getByTestId('menu-rename-title').click();
    await page.getByTestId('rename-title-input').fill('Never saved');
    await page.getByTestId('rename-title-input').press('Escape');
    await expect.poll(() => page.getByTestId('rename-title-input').count()).toBe(0);
    expect(await title.innerText()).toMatch(/Orders/);
    // Esc in the field did not leave the agent's page.
    expect(await page.locator('.focus').count()).toBe(1);
    await title.click({ button: 'right' });
    await page.getByTestId('menu-rename-title').click();
    await page.getByTestId('rename-title-input').fill('Refunds');
    await page.getByTestId('rename-title-input').press('Enter');
    await expect.poll(() => title.innerText()).toMatch(/Refunds\s*Rosa/);
    // Leaving the field saves too.
    await title.click({ button: 'right' });
    await page.getByTestId('menu-rename-agent').click();
    await page.getByTestId('rename-agent-input').fill('Rosalind');
    await page.locator('.transcript').click({ position: { x: 5, y: 5 } });
    await expect.poll(() => title.innerText()).toMatch(/Refunds\s*Rosalind/);
    await row('Rosalind').waitFor();

    // Messages: the same menu, with Keep as memory on the user's own and Copy on both.
    const user = page.locator('.msg.user').first();
    await user.click({ button: 'right' });
    const msgMenu = page.getByTestId('message-menu');
    await msgMenu.waitFor();
    expect(await msgMenu.getByRole('menuitem').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(['menu-remember', 'menu-copy']);
    expect(await msgMenu.evaluate((e) => e.className)).toBe('context-menu');
    await page.screenshot({ path: join(shots, 'rename-04-message-menu.png') });
    await page.getByTestId('menu-copy').click();
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('Do orders.');
    const reply = page.locator('.msg.assistant').last();
    await reply.click({ button: 'right' });
    expect(await msgMenu.getByRole('menuitem').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(['menu-copy']);
    await page.keyboard.press('Escape');
    await user.click({ button: 'right' });
    await page.getByTestId('menu-remember').click();
    await expect.poll(() => page.locator('.modal').count()).toBe(1);
    await page.keyboard.press('Escape');

    // Project: right-click its head, rename in place.
    await page.getByTestId('team-head').first().click({ button: 'right' });
    expect(await items()).toEqual(['menu-rename-project']);
    await page.getByTestId('menu-rename-project').click();
    await page.getByTestId('rename-project-input').fill('Shop front');
    await page.getByTestId('rename-project-input').press('Enter');
    await page.locator('[data-testid="team"][data-project="Shop front"]').waitFor();

    // The Overview tile: the same agent items.
    await page.getByRole('button', { name: /^Overview/ }).click();
    await page.locator(`[data-testid="agent-card"][data-alias="Rosalind"] .tile-head`).click({ button: 'right' });
    expect(await items()).toEqual(['menu-rename-agent', 'menu-rename-title', 'menu-set-aside', 'menu-open']);
    await page.keyboard.press('Escape');

    // Relaunch: every rename is still there.
    await app!.close();
    page = await launch(dataDir);
    const snap = await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    expect(snap.projects.find((x) => x.projectId === p.projectId)!.name).toBe('Shop front');
    expect(snap.tasks.find((x) => x.taskId === a.taskId)).toMatchObject({ alias: 'Rosalind', name: 'Refunds', nameSource: 'user' });
    expect(snap.tasks.find((x) => x.taskId === b.taskId)).toMatchObject({ alias: b.alias, name: '合并65、67并发布', nameSource: 'user' });
    await page.locator('[data-testid="rail-item"][data-alias="Rosalind"]').waitFor();
    await page.locator('[data-testid="team"][data-project="Shop front"]').waitFor();
  });
});
