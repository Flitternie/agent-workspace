// Opt-in: an imported Claude Code session gets a role from its conversation, with no OpenAI key
// (the user's own Claude Code names it in the background).
//   AMW_E2E_REAL=1 npm run test:e2e -- naming-real
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task, WorkspaceSnapshot } from '../../src/shared/types';

const enabled = process.env.AMW_E2E_REAL === '1';
const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;

afterEach(async () => {
  await app?.close().catch(() => {});
});

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

describe.runIf(enabled)('naming an imported session', () => {
  it('names it from its conversation with the user’s Claude Code, no OpenAI key', async () => {
    mkdirSync(join(appDir, '.cache'), { recursive: true });
    const root = realpathSync(mkdtempSync(join(appDir, '.cache', 'naming-repo-')));
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'README.md'), '# contracts\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: root });

    // A real session to import, about contract deadlines (no keyword the guesser knows).
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    const out = execFileSync('claude', ['-p', '--output-format', 'json', '--model', 'haiku', '帮我梳理合同里所有和时效、期限、通知期相关的条款，先只回复：好的'], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
    const sessionId = (JSON.parse(out) as { session_id: string }).session_id;

    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-naming-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
    await page.waitForSelector('.app');
    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    await invoke(page, 'settings:update', { language: 'zh' });
    // Claude Code must be detected as signed in before the background naming can use it.
    await expect.poll(async () => (await snap()).capabilities.find((c) => c.provider === 'claude')?.available, { timeout: 30_000 }).toBe(true);

    const project = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: 'legal-docs' });
    const t = await invoke<Task>(page, 'task:importSession', { projectId: project.projectId, provider: 'claude', nativeSessionId: sessionId, cwd: root, title: 'Untitled' });
    expect(t.name).toBe('LegalDocs');
    const name = await expect
      .poll(async () => (await snap()).tasks.find((x) => x.taskId === t.taskId)!.name, { timeout: 90_000, interval: 1000 })
      .toMatch(/^[一-鿿]{2,4}$/)
      .then(async () => (await snap()).tasks.find((x) => x.taskId === t.taskId)!.name);
    console.log(`named: ${name}`);
    await page.screenshot({ path: join(shots, 'naming-01-imported.png') });
  }, 300_000);
});
