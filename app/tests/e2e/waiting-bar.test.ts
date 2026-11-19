// The main agent's "waiting on you" line: right above the reply box, aligned with the conversation,
// unfolding to answer requests; gone when nothing waits. Demo workspace (mock workers) and a main
// agent on the installed Claude Code, which starts a session but is sent nothing (no model calls).
// Skipped when Claude Code is not installed. Screenshots in test-results/.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const hasClaude = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await app?.close().catch(() => {});
});

const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

describe.runIf(hasClaude)('main agent: waiting on you', () => {
  it('one line above the reply box, aligned with it, unfolding to answer; gone at zero', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-waiting-'));
    const launch = async () => {
      app = await electron.launch({
        executablePath: electronPath,
        args: [appDir],
        cwd: appDir,
        env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: 'claude', AMW_DATA_DIR: dataDir, AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
      });
      const p = await app.firstWindow();
      await p.waitForSelector('.app');
      return p;
    };
    let page = await launch();
    const resize = (width: number, height: number) => app!.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height] as const);
    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    const openCount = async () => (await snap()).attention.filter((a) => a.state === 'open' && a.kind !== 'completion').length;
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    await expect.poll(async () => (await snap()).main?.provider, { timeout: 30_000 }).toBe('claude');
    await expect.poll(openCount, { timeout: 30_000 }).toBe(2);
    // The main agent has handed work to Alice (as if through its tool), so its map stands beside the
    // conversation, the layout where the old list was off the column. Written while the app is closed.
    const first = await snap();
    const mainId = first.main!.taskId;
    const alice = first.tasks[0];
    await app!.close();
    const file = join(dataDir, 'transcripts', `${mainId}.json`);
    const items = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    const at = new Date().toISOString();
    items.push(
      { id: 'seed-ask', taskId: mainId, role: 'user', text: 'Tell the backend agent to keep the adapter.', createdAt: at },
      { id: 'seed-send', taskId: mainId, role: 'tool', text: '', toolStatus: 'completed', createdAt: at, tool: { name: 'mcp__workspace__send_to_agent', kind: 'other', title: 'workspace / send_to_agent', locations: [], content: [{ type: 'text', text: `Sent to ${alice.alias}; it will answer in its own conversation.` }] } },
    );
    writeFileSync(file, JSON.stringify(items));
    page = await launch();
    await resize(1440, 920);
    // The demo's two questions (kept over the restart), plus a permission request and a question with options.
    await expect.poll(openCount, { timeout: 30_000 }).toBe(2);
    const project = (await snap()).projects[0];
    const mk = (title: string, mockScript: string) => invoke<Task>(page, 'task:create', { projectId: project.projectId, provider: 'mock', title, mockScript, instruction: 'go', isolate: false });
    await mk('Deploy', 'approval:deploy --prod');
    await mk('Pick a store', 'choice:Which database should the cache use?');
    await expect.poll(openCount, { timeout: 30_000 }).toBe(4);

    await page.getByTestId('main-agent-row').click();
    const bar = page.getByTestId('waiting-on-you');
    const toggle = page.getByTestId('waiting-bar-toggle');
    // Folded: one line, "4 waiting on you", right above the reply box.
    await expect.poll(() => toggle.innerText()).toMatch(/^4 waiting on you/);
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    expect(await page.getByTestId('waiting-bar-list').count()).toBe(0);
    const order = await page.evaluate(() => {
      const thread = document.querySelector('.focus-thread')!;
      const kids = [...thread.children];
      const i = kids.findIndex((k) => k.matches('[data-testid="waiting-on-you"]'));
      return { next: kids[i + 1]?.className ?? '', beforeTranscript: kids.findIndex((k) => k.matches('.transcript')) > i };
    });
    expect(order.next).toMatch(/\bcomposer\b/);
    expect(order.beforeTranscript).toBe(false);
    const lineH = (await toggle.boundingBox())!.height;
    expect(lineH).toBeLessThanOrEqual(36);

    /** Left and right edges of the line, the reply box and the conversation column's content. */
    const edges = () =>
      page.evaluate(() => {
        const r = (sel: string) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          const b = e.getBoundingClientRect();
          return { l: Math.round(b.left), r: Math.round(b.right) };
        };
        const inner = document.querySelector('.focus-thread .transcript-inner') as HTMLElement | null;
        const pad = inner ? parseFloat(getComputedStyle(inner).paddingLeft) : 0;
        const t = r('.focus-thread .transcript-inner');
        return {
          line: r('[data-testid="waiting-on-you"] .waiting-bar-box'),
          composer: r('.focus-thread .composer-box'),
          column: t ? { l: Math.round(t.l + pad), r: Math.round(t.r - pad) } : null,
          map: !!document.querySelector('[data-testid="session-map-beside"]'),
          width: window.innerWidth,
        };
      });
    const aligned = (e: Awaited<ReturnType<typeof edges>>) => {
      expect(e.line).not.toBeNull();
      expect(Math.abs(e.line!.l - e.composer!.l)).toBeLessThanOrEqual(1);
      expect(Math.abs(e.line!.r - e.composer!.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(e.line!.l - e.column!.l)).toBeLessThanOrEqual(1);
      expect(Math.abs(e.line!.r - e.column!.r)).toBeLessThanOrEqual(1);
    };
    await expect.poll(async () => (await edges()).map, { timeout: 10_000 }).toBe(true);
    const wide = await edges();
    console.log('wide', JSON.stringify(wide));
    aligned(wide);
    await page.mouse.move(700, 300);
    await page.screenshot({ path: join(shots, 'waiting-01-wide-folded.png') });

    // Unfolded: one row per request (who, what kind, what), the same however many there are.
    await toggle.click();
    const rows = page.getByTestId('waiting-bar-list').getByTestId('waiting-row');
    await expect.poll(() => rows.count()).toBe(4);
    expect(await page.getByTestId('waiting-detail').count()).toBe(0);
    aligned(await edges());
    await page.screenshot({ path: join(shots, 'waiting-02-wide-unfolded.png') });
    // The permission request: allowed right on its row, nothing to unfold.
    await rows.filter({ hasText: 'deploy --prod' }).getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(openCount).toBe(3);
    await expect.poll(() => toggle.innerText()).toMatch(/^3 waiting on you/);
    // The question with options: "Answer" unfolds it under its row, flat (no card inside the bar), lined up with the name.
    await rows.filter({ hasText: 'cache use' }).getByRole('button', { name: 'Answer' }).click();
    const detail = page.getByTestId('waiting-detail');
    await expect.poll(() => detail.count()).toBe(1);
    const look = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="waiting-detail"] .attention')!;
      const row = card.closest('.wb-row')!;
      return { border: getComputedStyle(card).borderTopWidth, card: Math.round(card.getBoundingClientRect().left), name: Math.round(row.querySelector('.wb-name')!.getBoundingClientRect().left) };
    });
    expect(look.border).toBe('0px');
    expect(Math.abs(look.card - look.name)).toBeLessThanOrEqual(1);
    // Unfolded by the user: the reply box says what a message will be taken as answering; × says it is not.
    const chip = page.getByTestId('composer-about');
    await expect.poll(() => chip.innerText()).toMatch(/About Ethan’s request\s*Which database should the cache use\?/);
    await page.getByTestId('composer-about-clear').click();
    await expect.poll(() => chip.count()).toBe(0);
    expect(await detail.count()).toBe(1);
    await page.screenshot({ path: join(shots, 'waiting-03-answer.png') });
    await detail.getByRole('button', { name: 'Option B' }).click();
    await detail.getByRole('button', { name: 'Send answer' }).click();
    await expect.poll(openCount).toBe(2);
    // Two left: still one row each, none open.
    await expect.poll(() => rows.count()).toBe(2);
    expect(await detail.count()).toBe(0);

    // One: a question opened from its row and dismissed; folded it reads "1 waiting on you".
    await rows.first().locator('.wb-main').click();
    await detail.getByRole('button', { name: 'Dismiss' }).click();
    await expect.poll(openCount).toBe(1);
    await toggle.click();
    await expect.poll(() => toggle.innerText()).toMatch(/^1 waiting on you/);
    aligned(await edges());
    await page.screenshot({ path: join(shots, 'waiting-04-one.png') });

    // Narrow window: still the reply box's edges.
    await resize(960, 820);
    await page.waitForTimeout(400);
    const narrow = await edges();
    console.log('narrow', JSON.stringify(narrow));
    aligned(narrow);
    await page.screenshot({ path: join(shots, 'waiting-05-narrow.png') });
    // A lone request opens by itself when unfolded; not picked by the user, so no "about" hint.
    await toggle.click();
    await expect.poll(() => detail.count()).toBe(1);
    expect(await page.getByTestId('composer-about').count()).toBe(0);
    aligned(await edges());
    await page.screenshot({ path: join(shots, 'waiting-06-narrow-unfolded.png') });

    // Zero: the line goes and leaves no room behind (the reply box sits right under the conversation).
    await detail.getByRole('button', { name: 'Dismiss' }).click();
    await expect.poll(openCount).toBe(0);
    await expect.poll(() => bar.count()).toBe(0);
    const gap = await page.evaluate(() => {
      const t = document.querySelector('.focus-thread .transcript')!.getBoundingClientRect();
      const c = document.querySelector('.focus-thread .composer')!.getBoundingClientRect();
      return Math.round(c.top - t.bottom);
    });
    expect(gap).toBeLessThanOrEqual(1);
    await resize(1440, 920);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'waiting-07-none.png') });

    // A new request comes in folded, as one line again.
    await mk('Deploy again', 'approval:deploy --staging');
    await expect.poll(() => toggle.innerText(), { timeout: 30_000 }).toMatch(/^1 waiting on you/);
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
  }, 180_000);
});
