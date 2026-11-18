// Side questions ("btw"): asked from the same reply box another way, answered in the side column,
// never part of the agent's conversation, never interrupting its turn (mock agent).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task, TranscriptItem } from '../../src/shared/types';

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

describe('side questions', () => {
  it('answers in the side column while the turn goes on, and stays out of the conversation', async () => {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-btw-'))), 'shop');
    mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '# shop\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    // A slow mock: its turn is still running while the side questions are asked.
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-btw-data-')), AMW_MOCK_DELAY_MS: '1500', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
    const page = await app.firstWindow();
    // A renderer error (an effect returning a value, say) blanks the window: fail on any.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: dir, name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Orders', name: 'Orders', mockScript: 'work', instruction: 'Migrate the orders page.', isolate: false });
    await page.locator(`[data-testid="rail-item"][data-alias="${a.alias}"],[data-testid="needs-item"][data-alias="${a.alias}"]`).first().click();
    const status = async () => (await invoke<{ tasks: Task[] }>(page, 'workspace:snapshot', {})).tasks.find((t) => t.taskId === a.taskId)!.status;
    await expect.poll(status).toBe('running');

    // ⌥↵ in the same box: a side question. The side column opens with it and its answer.
    const box = page.getByTestId('composer-input');
    await box.click();
    await box.fill('Which file holds the totals?');
    await box.press('Alt+Enter');
    await expect.poll(() => page.getByTestId('btw-panel').count()).toBe(1);
    expect(await box.inputValue()).toBe('');
    await expect.poll(() => page.getByTestId('btw-answer').first().innerText(), { timeout: 15_000 }).toContain('Side answer to "Which file holds the totals?"');
    // The turn was never interrupted, and the question is not in the conversation.
    expect(await page.getByTestId('btw-answer').first().innerText()).toContain('still running');
    const said = async () => (await invoke<TranscriptItem[]>(page, 'transcript:get', { taskId: a.taskId })).map((i) => i.text).join('\n');
    expect(await said()).not.toContain('Which file holds the totals?');
    await page.screenshot({ path: join(shots, 'btw-01-answer.png') });

    // A follow-up, typed as /btw … and sent with ↵: it sees the earlier side question.
    await box.fill('/btw and the tests?');
    await box.press('Enter');
    await expect.poll(() => page.getByTestId('btw-answer').nth(1).innerText(), { timeout: 15_000 }).toContain('Side answer to "and the tests?" (saw 1 earlier side question');
    expect(await said()).not.toContain('and the tests?');

    // One that fails says so, in place.
    await box.fill('please fail');
    await box.press('Alt+Enter');
    await expect.poll(() => page.getByTestId('btw-error').count(), { timeout: 15_000 }).toBe(1);

    // An answer brought into the conversation goes into the box, to edit before sending.
    await page.getByTestId('btw-bring').first().click();
    await expect.poll(() => box.inputValue()).toContain('Which file holds the totals?');
    expect(await box.inputValue()).toContain('> Side answer to');
    await box.fill('');

    // Closed, the bubble button with nothing typed opens them again; they are kept per agent.
    await page.getByTestId('btw-panel').getByRole('button', { name: 'Close' }).click();
    expect(await page.getByTestId('btw-panel').count()).toBe(0);
    await page.getByTestId('btw-send').click();
    await expect.poll(() => page.getByTestId('btw-exchange').count()).toBe(3);
    // Cleared: gone.
    await page.getByTestId('btw-clear').click();
    await expect.poll(() => page.getByTestId('btw-exchange').count()).toBe(0);
    expect(await invoke<unknown[]>(page, 'btw:list', { taskId: a.taskId })).toEqual([]);
    expect(errors).toEqual([]);
  }, 120_000);
});
