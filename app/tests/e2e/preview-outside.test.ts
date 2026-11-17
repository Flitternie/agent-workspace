// A file outside the agent's folder previews without a "show anyway?" step; keys and credentials stay refused.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
// Short, fixed paths: they go into the mock agent's reply (its script is at most 50 characters).
const OUT = '/tmp/amw-o';
let app: ElectronApplication | undefined;
afterAll(async () => {
  await app?.close().catch(() => {});
  rmSync(OUT, { recursive: true, force: true });
});
const invoke = <T,>(page: Page, c: string, p: unknown) => page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [c, p] as const) as Promise<T>;

describe('preview outside the agent folder', () => {
  it('shows it straight away, and still refuses credential files', async () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'n.md'), '# Notes from elsewhere\n\nOutside the project.\n');
    writeFileSync(join(OUT, 'token.json'), '{"secret": "do-not-show"}\n');
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-out-'))), 'shop');
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '# shop\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-out-data-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: dir, name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Notes', mockScript: `ask:${OUT}/n.md ${OUT}/token.json`, instruction: 'Where are the notes?', isolate: false });
    await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"],[data-testid="needs-item"][data-alias="${a.alias}"]`).first().click();

    // Outside the agent's folder and the project: shown at once, no question asked.
    await page.locator(`[data-testid="md-file"][data-path="${OUT}/n.md"]`).first().click({ timeout: 30_000 });
    await expect.poll(() => page.getByTestId('file-preview').innerText()).toContain('Notes from elsewhere');
    expect(await page.getByTestId('preview-show-anyway').count()).toBe(0);
    // A credential file: refused, whatever the location.
    await page.locator(`[data-testid="md-file"][data-path="${OUT}/token.json"]`).first().click();
    await expect.poll(() => page.getByTestId('file-preview').innerText()).toContain('private location');
    expect(await page.getByTestId('file-preview').innerText()).not.toContain('do-not-show');
  }, 120_000);
});
