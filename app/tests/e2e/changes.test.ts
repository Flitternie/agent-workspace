// Changed this turn: the list, each file's diff in the preview (File / Changes), and Follow (mock agents).
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

    // The header counts the files this turn changed; the list names them with their +/−.
    await expect.poll(() => page.getByTestId('changes-count').innerText(), { timeout: 30_000 }).toBe('2');
    await page.getByTestId('show-changes').click();
    await expect.poll(() => page.getByTestId('changes-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['src/orders.ts', 'README.md']);
    await expect.poll(() => page.getByTestId('changes-panel').innerText()).toContain('+7');
    await page.screenshot({ path: join(shots, 'changes-01-list.png') });

    // A file from the list opens on its changes; File shows the file itself.
    await page.getByTestId('changes-item').filter({ hasText: 'orders.ts' }).click();
    await expect.poll(() => page.getByTestId('preview-diffs').innerText()).toContain('api.get');
    await page.screenshot({ path: join(shots, 'changes-02-diff.png') });
    await page.getByTestId('show-file').click();
    await expect.poll(() => page.getByTestId('preview-diffs').count()).toBe(0);
    await expect.poll(() => page.getByTestId('file-preview').innerText()).toContain('listOrders');
    // Closing the preview brings the list back.
    await page.getByRole('button', { name: 'Close preview' }).click();
    await expect.poll(() => page.getByTestId('changes-panel').count()).toBe(1);

    // Follow: the next file the agent changes opens by itself, on its diff.
    await page.getByTestId('follow-agent').check();
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'edit notes.md', via: 'text' });
    await expect.poll(() => page.getByTestId('file-preview').getAttribute('data-path'), { timeout: 30_000 }).toBe('notes.md');
    await expect.poll(() => page.getByTestId('preview-diffs').innerText()).toContain('Edited in request 2');
    // A new turn: the count is this turn's files only.
    await expect.poll(() => page.getByTestId('changes-count').innerText()).toBe('1');
    await page.screenshot({ path: join(shots, 'changes-03-follow.png') });
    // Follow off: a further change leaves the preview alone.
    await page.getByRole('button', { name: 'Close preview' }).click();
    await page.getByTestId('follow-agent').uncheck();
    await invoke(page, 'task:send', { taskId: a.taskId, text: 'edit README.md', via: 'text' });
    await expect.poll(() => page.getByTestId('changes-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-path'))), { timeout: 30_000 }).toEqual(['README.md']);
    expect(await page.getByTestId('file-preview').count()).toBe(0);
  }, 120_000);
});
