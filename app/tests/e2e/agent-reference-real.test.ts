// Opt-in: drag one real agent from the sidebar onto another's message box; the box gets @<its session
// file> (shown as @name), and the other agent reads it. Claude Code ↔ Codex, both ways. Tiny prompts.
//   AMW_E2E_REAL=1 npm run test:e2e -- agent-reference-real
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { Task, TranscriptItem, WorkspaceSnapshot } from '../../src/shared/types';

const enabled = process.env.AMW_E2E_REAL === '1';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

describe.runIf(enabled)('referring an agent to another agent’s conversation', () => {
  it('drag Codex onto Claude Code and Claude Code onto Codex: each reads the other’s conversation', async () => {
    mkdirSync(join(appDir, '.cache'), { recursive: true });
    const root = mkdtempSync(join(appDir, '.cache', 'ref-repo-'));
    writeFileSync(join(root, 'README.md'), 'x');
    execFileSync('git', ['init', '-q'], { cwd: root });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
    const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-ref-')), AMW_NO_AUTOLISTEN: '1', AMW_NO_OPENAI: '1' } });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForSelector('.app');
      const inv = <T,>(c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<T>;
      await inv('settings:update', { onboarding: { dismissed: true } });
      const snap = () => inv<WorkspaceSnapshot>('workspace:snapshot', {});
      const settled = (id: string) => expect.poll(async () => (await snap()).tasks.find((x) => x.taskId === id)!.status, { timeout: 180_000, interval: 1000 }).toMatch(/done|idle|waiting_for_user/);
      const reply = async (id: string) => (await inv<TranscriptItem[]>('transcript:get', { taskId: id })).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';
      const p = await inv<{ projectId: string }>('project:add', { rootPath: root, name: 'ref-e2e' });
      const claude = await inv<Task>('task:create', { projectId: p.projectId, provider: 'claude', title: 'Claude', name: 'Claude side', isolate: false });
      const codex = await inv<Task>('task:create', { projectId: p.projectId, provider: 'codex', title: 'Codex', name: 'Codex side', isolate: false });
      await inv('task:send', { taskId: claude.taskId, text: 'Remember the codeword FIG-28. Reply with only: ok', via: 'text' });
      await inv('task:send', { taskId: codex.taskId, text: 'Remember the codeword LIME-64. Reply with only: ok', via: 'text' });
      await settled(claude.taskId);
      await settled(codex.taskId);

      for (const [to, from, word] of [
        [claude, codex, 'LIME-64'],
        [codex, claude, 'FIG-28'],
      ] as const) {
        await page.locator(`[data-testid="rail-item"][data-alias="${to.alias}"]`).click();
        const box = page.getByTestId('composer-input');
        await box.click();
        await box.fill('');
        await box.pressSequentially('In the conversation in ');
        await page.locator(`[data-testid="rail-item"][data-alias="${from.alias}"]`).dragTo(page.locator('.composer-box'));
        // The box shows the agent by name, marked like a file; the CLI gets the file its conversation is in.
        await expect.poll(() => box.inputValue(), { timeout: 15_000 }).toBe(`In the conversation in @"${from.name}" `);
        await expect.poll(() => page.locator('.composer-mirror mark').allInnerTexts()).toEqual([`@"${from.name}"`]);
        const value = await box.inputValue();
        console.log(`[${to.provider} ← ${from.provider}] box:`, value);
        await box.pressSequentially(', which codeword did the user ask that agent to remember in their very first message? Read that file. Reply with only that codeword.');
        const before = (await inv<TranscriptItem[]>('transcript:get', { taskId: to.taskId })).filter((i) => i.role === 'assistant').length;
        await box.press('Enter');
        // A new reply, then the turn's end (the status alone can still read idle right after sending).
        await expect.poll(async () => (await inv<TranscriptItem[]>('transcript:get', { taskId: to.taskId })).filter((i) => i.role === 'assistant').length, { timeout: 180_000, interval: 1000 }).toBeGreaterThan(before);
        await settled(to.taskId);
        const r = await reply(to.taskId);
        console.log(`[${to.provider} ← ${from.provider}] reply:`, r);
        expect(r).toContain(word);
        // In the conversation the file shows as the other agent.
        await expect.poll(() => page.getByTestId('mention-chip').last().innerText(), { timeout: 5000 }).toContain(from.name);
      }
    } finally {
      await app.close();
    }
  }, 600_000);
});
