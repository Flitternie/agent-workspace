// A change in the conversation opens in the preview, on its file or its diff (no separate Changes panel);
// forking back to before a message leaves that message in the new agent's reply box (mock agents).
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
const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

function repo(): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-changes-'))), 'shop');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# shop\n\nA tiny demo repository for Agent Workspace.\n\nThe dashboard reads orders from the v2 API.\n');
  writeFileSync(join(dir, 'src/orders.ts'), "import { api } from './api';\n\nexport async function listOrders(page = 1) {\n  return (await api.get(`/v2/orders?page=${page}`)).items;\n}\n");
  writeFileSync(join(dir, 'notes.md'), '# notes.md\nEdited.\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('changed this turn', () => {
  it('lists the files the turn changed, shows each one’s diff, and follows the agent', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-changes-data-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo(), name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', mockScript: 'work', instruction: 'Do orders.', isolate: false });
    await expect.poll(() => page.getByTestId('agent-card').count(), { timeout: 30_000 }).toBe(1);
    await page.locator('[data-testid="rail-item"],[data-testid="needs-item"]').filter({ hasText: 'Orders' }).first().click();

    // No Changes button (or panel): a change's row in the conversation opens it.
    expect(await page.getByTestId('show-changes').count()).toBe(0);
    const row = page.locator('[data-testid="tool-call"][data-kind="edit"]').filter({ hasText: 'src/orders.ts' }).first();
    await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
    await row.getByTestId('preview-file').click();
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('data-path')).toContain('orders.ts');
    // It changed in this turn: its diff is a tab away.
    await page.getByTestId('show-diff').click();
    await expect.poll(() => page.getByTestId('preview-diffs').innerText()).toContain('api.get');
    await page.screenshot({ path: join(shots, 'changes-01-diff.png') });
    await page.getByTestId('show-file').click();
    await expect.poll(() => page.getByTestId('file-preview').innerText()).toContain('listOrders');
    await page.getByRole('button', { name: 'Close preview' }).click();

    // Forking back to before a message: no instruction box; that message waits in the fork's reply box.
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'Now the refunds.', via: 'text' });
    await expect.poll(async () => !['running', 'starting'].includes((await invoke<{ tasks: Task[] }>(page, 'workspace:snapshot', {})).tasks.find((t) => t.taskId === a.taskId)!.status), { timeout: 30_000 }).toBe(true);
    await page.getByTestId('fork-task').click();
    expect(await page.getByTestId('fork-instruction').count()).toBe(0);
    await page.getByTestId('fork-points').getByText('Now the refunds.').click();
    // (Same folder: this test's repository has no commit to start a worktree from.)
    await page.locator('.modal label').filter({ hasText: 'own git worktree' }).locator('input[type="checkbox"]').uncheck();
    await page.getByTestId('fork-confirm').click();
    await expect.poll(() => page.locator('.focus-head').innerText(), { timeout: 15_000 }).toContain('fork');
    await expect.poll(() => page.getByTestId('composer-input').inputValue()).toBe('Now the refunds.');
  }, 120_000);
});
