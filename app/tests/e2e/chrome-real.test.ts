// Opt-in: a real Claude Code agent started by the app has Claude in Chrome's tools and reads a page
// in the user's Chrome (needs the extension installed and Chrome running). Tiny prompt.
//   AMW_E2E_REAL=1 AMW_E2E_CHROME=1 npm run test:e2e -- chrome-real
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { Task, TranscriptItem, WorkspaceSnapshot } from '../../src/shared/types';

const enabled = process.env.AMW_E2E_REAL === '1' && process.env.AMW_E2E_CHROME === '1';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

describe.runIf(enabled)('Claude in Chrome', () => {
  it('a Claude agent reads a web page through the user’s Chrome', async () => {
    mkdirSync(join(appDir, '.cache'), { recursive: true });
    const root = mkdtempSync(join(appDir, '.cache', 'chrome-repo-'));
    writeFileSync(join(root, 'README.md'), 'x');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-chr-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('.app');
      const inv = <T,>(c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<T>;
      await inv('settings:update', { onboarding: { dismissed: true } });
      const p = await inv<{ projectId: string }>('project:add', { rootPath: root, name: 'chrome-e2e' });
      const t = await inv<Task>('task:create', { projectId: p.projectId, provider: 'claude', title: 'Read a page', isolate: false });
      await inv('task:send', { taskId: t.taskId, text: 'Use the Claude in Chrome browser tools to open https://example.com in a new tab, then reply with only the page’s main heading.', via: 'text' });
      await expect.poll(async () => (await inv<WorkspaceSnapshot>('workspace:snapshot', {})).tasks.find((x) => x.taskId === t.taskId)!.status, { timeout: 240_000, interval: 1000 }).toMatch(/done|idle|waiting_for_user/);
      const items = await inv<TranscriptItem[]>('transcript:get', { taskId: t.taskId });
      const tools = items.filter((i) => i.role === 'tool').map((i) => i.tool?.name ?? i.toolLabel ?? '');
      const reply = items.filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
      console.log('[chrome] tools:', tools.join(', '), '| reply:', reply);
      expect(tools.some((n) => /claude-in-chrome/.test(n))).toBe(true);
      expect(reply).toMatch(/Example Domain/i);
    } finally {
      await app.close();
    }
  }, 300_000);
});
