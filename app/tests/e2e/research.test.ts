// A project's research page, end to end (demo workspace: its example research, mock agents).
// The page shows the tree; changes are made by talking to the agents (who have the research tools).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '../../src/shared/types';
import type { ResearchDoc } from '../../src/shared/research';

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

describe('research page (demo)', () => {
  it('one row in the sidebar; a graph by level; each level its question to read; talking to the agent over the selection', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-research-')), AMW_MOCK_DELAY_MS: '80', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1480, 920));
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const snap = () => invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
    await expect.poll(async () => (await snap()).research.length, { timeout: 30_000 }).toBe(1);
    const projectId = (await snap()).research[0].projectId;
    const doc = () => invoke<ResearchDoc>(page, 'research:get', { researchId: projectId });

    // The entry: one row in its project's team.
    const row = page.getByTestId('research-row');
    await expect.poll(() => row.count()).toBe(1);
    await row.click();
    await expect.poll(() => page.getByTestId('research').isVisible()).toBe(true);

    // The goal: which aspects matter, from the ablations; nothing to fill in, a hint to talk instead.
    const panel = page.getByTestId('research-panel');
    await expect.poll(() => panel.innerText()).toContain('Which aspects move the end result?');
    expect(await page.getByTestId('research-contrib').innerText()).toMatch(/Architecture[\s\S]*1 ablation\n[\s\S]*Data[\s\S]*2 ablations/);
    expect(await panel.innerText()).toMatch(/Manage it by talking/);
    // The summary the main agent keeps (markdown in .research/summary.md), with how fresh it is.
    expect(await page.getByTestId('research-summary').innerText()).toMatch(/Summary[\s\S]*updated[\s\S]*Where things stand[\s\S]*Which aspects matter/);
    expect(await panel.locator('input, textarea, select').count()).toBe(0);
    await page.screenshot({ path: join(shots, 'research-01-goal.png') });

    // Levels.
    const kinds = async () => page.getByTestId('research-node').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    await page.getByTestId('research-depth-aspect').click();
    expect((await kinds()).filter((k) => k === 'method')).toHaveLength(0);
    await page.getByTestId('research-depth-experiment').click();
    expect((await kinds()).filter((k) => k === 'runs')).toHaveLength(0);
    await page.getByTestId('research-depth-method').click();
    expect((await kinds()).filter((k) => k === 'runs').length).toBeGreaterThan(5);
    expect(await page.locator('.rg-link').count()).toBe(4);

    // An aspect: its question, read only; no agent yet, so what is said below starts one.
    const node = (kind: string, title: string) => page.locator(`[data-testid="research-node"][data-kind="${kind}"][data-title="${title}"]`);
    await node('aspect', 'Data').click();
    await expect.poll(() => panel.innerText()).toContain('Which methods are there for "Data"?');
    expect(await panel.innerText()).toMatch(/the first thing you say to it below starts one/);
    expect(await page.getByTestId('research-notes').innerText()).toMatch(/Notes[\s\S]*Tried[\s\S]*0\.85 best/);
    // The aspect at a glance: start → best, how many ran and work; each method's best and its change from the start.
    expect(await page.getByTestId('research-kpis').innerText()).toMatch(/start → best[\s\S]*71\.0 → 77\.9[\s\S]*experiments[\s\S]*work/);
    expect(await page.getByTestId('research-panel').locator('.rs-table').first().innerText()).toMatch(/Best\s+vs start\s+Experiments[\s\S]*\+\d/);
    // Questions that fit, offered while the box is empty: a click fills it.
    await page.getByTestId('composer-chips').getByText('What has worked so far?').click();
    expect(await page.getByTestId('composer-input').inputValue()).toBe('What has worked so far?');
    await page.getByTestId('composer-input').fill('');
    expect(await panel.locator('input, textarea, select, .btn').count()).toBe(0);
    expect(await page.getByTestId('research-to').innerText()).toMatch(/a new agent for "Data"/);
    // The box is the agent page's own: its round send button, "To: …" in its foot, the selection above it.
    expect(await page.locator('.research-composer .composer .send-btn').count()).toBe(1);
    // It floats on the graph: the canvas runs to the bottom of the page, the box over it.
    const geo = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      return { canvas: r('.research-canvas').bottom, page: r('.research').bottom, box: r('.research-composer .composer-box').bottom };
    });
    expect(Math.abs(geo.canvas - geo.page)).toBeLessThanOrEqual(1);
    expect(geo.box).toBeLessThan(geo.canvas);
    // The legend is out of the way until asked for.
    expect(await page.getByTestId('research-legend').count()).toBe(0);
    await page.getByTestId('research-legend-toggle').click();
    expect(await page.getByTestId('research-legend').innerText()).toMatch(/double-click: open its conversation/);
    await page.getByTestId('research-legend-toggle').click();
    expect(await page.getByTestId('composer-target').innerText()).toMatch(/To: a new agent for "Data"/);
    expect(await page.getByTestId('composer-about').innerText()).toMatch(/About\s*Data/);
    await page.getByTestId('composer-input').fill('Which method would you try first?');
    await page.getByTestId('composer-send').click();
    await expect.poll(() => page.getByTestId('research-sent').innerText(), { timeout: 20_000 }).toMatch(/Sent to/);
    await expect.poll(async () => (await doc()).nodes.find((n) => n.title === 'Data')?.taskId ?? '').not.toBe('');
    const dataAgent = (await doc()).nodes.find((n) => n.title === 'Data')!.taskId!;
    await expect.poll(() => page.getByTestId('research-to').innerText()).toMatch(/\(Data aspect\)/);
    // Its brief and the message, in its conversation; not one of the team's rows.
    const first = (await invoke<Array<{ role: string; text: string }>>(page, 'transcript:get', { taskId: dataAgent })).find((i) => i.role === 'user')!.text;
    expect(first).toMatch(/You own the "Data" aspect[\s\S]*research_try[\s\S]*Which method would you try first\?/);
    const alias = (await snap()).tasks.find((x) => x.taskId === dataAgent)!.alias;
    expect(await page.locator(`[data-testid="rail-item"][data-alias="${alias}"]`).count()).toBe(0);
    await expect.poll(() => row.innerText()).toMatch(/1 agent\b/);
    // A double-click opens a node's agent (a method's: its aspect's); Esc comes back.
    await node('aspect', 'Data').dblclick();
    await expect.poll(() => page.getByTestId('research').count()).toBe(0);
    expect(await page.getByTestId('composer-target').innerText()).toMatch(new RegExp(`To: ${alias}`));
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByTestId('research').isVisible()).toBe(true);
    await node('method', 'Deduplication').dblclick();
    await expect.poll(() => page.getByTestId('research').count()).toBe(0);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByTestId('research').isVisible()).toBe(true);
    // No agent behind it: a double-click just selects it.
    await node('aspect', 'Training').dblclick();
    await expect.poll(() => panel.innerText()).toContain('Which methods are there for "Training"?');
    expect(await page.getByTestId('research').isVisible()).toBe(true);
    await node('aspect', 'Data').click();
    // Its context when wanted: open its conversation; Esc comes back to the research.
    await page.getByTestId('research-open-agent').click();
    await expect.poll(() => page.getByTestId('research').count()).toBe(0);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByTestId('research').isVisible()).toBe(true);

    // When an agent changes the tree (its tool writes the file), the page follows.
    const d = await doc();
    const dedup = d.nodes.find((n) => n.title === 'Deduplication')!;
    await invoke(page, 'research:save', { researchId: projectId, doc: { ...d, nodes: [...d.nodes, { id: 'x-new', type: 'experiment', parent: dedup.id, title: 'threshold 0.87', status: 'pass', value: 78.2, createdAt: new Date().toISOString(), findings: [{ id: 'f-new', text: '0.87 keeps the code samples', at: new Date().toISOString() }] }], updatedAt: new Date().toISOString() } });
    await node('method', 'Deduplication').click();
    await expect.poll(() => panel.innerText()).toMatch(/threshold 0\.87[\s\S]*78\.2[\s\S]*0\.87 keeps the code samples/);
    // Changes from the start, tinted by size; the best variant starred.
    expect(await page.getByTestId('research-results').innerText()).toMatch(/★ threshold 0\.87[\s\S]*\+10%/);
    await page.screenshot({ path: join(shots, 'research-02-method.png') });

    // Several selected: to the agent over them all.
    await page.getByTestId('research-depth-experiment').click();
    await node('experiment', 'threshold 0.8').click();
    await node('experiment', 'threshold 0.87').click({ modifiers: ['Shift'] });
    await expect.poll(() => page.getByTestId('research-to').innerText()).toMatch(/\(Data aspect\)/);
    expect(await page.getByTestId('composer-about').innerText()).toMatch(/threshold 0\.8 and 1 more/);
    await page.getByTestId('research-depth-method').click();
    await node('method', 'Optimizer').click();
    await node('method', 'Activation').click({ modifiers: ['Shift'] });
    // Across aspects: the research's own lead (none yet: the first message starts it).
    await expect.poll(() => page.getByTestId('research-to').innerText()).toMatch(/To: a new research lead/);
    expect(await page.getByTestId('composer-about').innerText()).toMatch(/Optimizer and 1 more/);
    expect(await page.getByTestId('composer-input').isDisabled()).toBe(false);
    await page.screenshot({ path: join(shots, 'research-03-multi.png') });

    // The goal's agent is the research's lead: the first message starts it; a double-click on the goal opens it.
    await page.getByTestId('research-panel').locator('.side-head').click();
    await page.locator('[data-testid="research-node"][data-kind="goal"]').click();
    await expect.poll(() => panel.innerText()).toMatch(/No research lead yet/);
    await page.getByTestId('composer-input').fill('Help me lay out the next aspect.');
    await page.getByTestId('composer-send').click();
    await expect.poll(async () => (await doc()).leadTaskId ?? '', { timeout: 20_000 }).not.toBe('');
    const leadId = (await doc()).leadTaskId!;
    expect((await invoke<Array<{ role: string; text: string }>>(page, 'transcript:get', { taskId: leadId })).find((i) => i.role === 'user')!.text).toMatch(/You lead the research[\s\S]*Help me lay out the next aspect\./);
    await expect.poll(() => page.getByTestId('research-to').innerText()).toMatch(/research lead/);
    await page.locator('[data-testid="research-node"][data-kind="goal"]').dblclick();
    await expect.poll(() => page.getByTestId('research').count()).toBe(0);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByTestId('research').isVisible()).toBe(true);

    // Starting one in another project: offered on its team.
    const other = join(mkdtempSync(join(tmpdir(), 'amw-research-p-')), 'notes');
    mkdirSync(other);
    execFileSync('git', ['init', '-q'], { cwd: other });
    writeFileSync(join(other, 'README.md'), '# notes\n');
    execFileSync('git', ['add', '.'], { cwd: other });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: other });
    const p2 = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: other, name: 'notes' });
    await invoke(page, 'task:create', { projectId: p2.projectId, provider: 'mock', title: 'Notes', mockScript: 'work', instruction: 'go', isolate: false });
    const team = page.locator('[data-testid="team"][data-project="notes"]');
    await expect.poll(() => team.count()).toBe(1);
    await team.hover();
    await team.getByTestId('new-research').click();
    await page.getByTestId('research-new').locator('input').fill('Note quality');
    await page.getByTestId('research-create').click();
    await expect.poll(() => page.locator('.research-title h1').innerText()).toBe('Note quality');
    expect(await page.getByTestId('research-row').count()).toBe(2);
  }, 180_000);
});
