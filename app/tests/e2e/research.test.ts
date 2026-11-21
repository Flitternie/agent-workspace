// A project's research page, end to end (demo workspace: its example research, mock agents).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '../../src/shared/types';

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
  it('a project’s research: one row in the sidebar, a graph by level, each level its own questions, agents behind the nodes', async () => {
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
    const doc = () => invoke<{ nodes: Array<{ id: string; type: string; title: string; taskId?: string; status: string; value?: number; findings?: unknown[]; links?: Array<{ kind: string }> }> }>(page, 'research:get', { projectId });

    // The entry: one row in its project's team.
    const row = page.getByTestId('research-row');
    await expect.poll(() => row.count()).toBe(1);
    expect(await row.innerText()).toMatch(/nanochat pretraining[\s\S]*Research/);
    await row.click();
    await expect.poll(() => page.getByTestId('research').isVisible()).toBe(true);
    expect(await page.getByTestId('research-progress').innerText()).toMatch(/\d+ experiments/);

    // Nothing selected: the goal's question, and which aspects matter (from the ablations).
    const panel = page.getByTestId('research-panel');
    await expect.poll(() => panel.innerText()).toContain('Which aspects move the end result?');
    expect(await page.getByTestId('research-contrib').innerText()).toMatch(/Architecture[\s\S]*1 ablation\n[\s\S]*Data[\s\S]*2 ablations/);
    await page.screenshot({ path: join(shots, 'research-01-goal.png') });

    // Levels: aspects only, methods (experiments folded per method), every experiment.
    const kinds = async () => page.getByTestId('research-node').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    await page.getByTestId('research-depth-aspect').click();
    expect((await kinds()).filter((k) => k === 'method')).toHaveLength(0);
    expect((await kinds()).filter((k) => k === 'aspect')).toHaveLength(4);
    await page.getByTestId('research-depth-experiment').click();
    expect((await kinds()).filter((k) => k === 'experiment').length).toBeGreaterThan(15);
    expect((await kinds()).filter((k) => k === 'runs')).toHaveLength(0);
    await page.getByTestId('research-depth-method').click();
    expect((await kinds()).filter((k) => k === 'runs').length).toBeGreaterThan(5);
    // Combined / mutated / borrowed methods are linked across.
    expect(await page.locator('.rg-link').count()).toBe(4);
    await page.screenshot({ path: join(shots, 'research-02-methods.png') });

    // An aspect: its question; no agent yet, so the box would start one; start it from the panel.
    const node = (kind: string, title: string) => page.locator(`[data-testid="research-node"][data-kind="${kind}"][data-title="${title}"]`);
    await node('aspect', 'Data').click();
    await expect.poll(() => panel.innerText()).toContain('Which methods are there for "Data"?');
    expect(await page.getByTestId('research-to').innerText()).toMatch(/a new agent for "Data"/);
    await page.getByTestId('research-start-agent').click();
    await expect.poll(async () => (await doc()).nodes.find((n) => n.title === 'Data')?.taskId ?? '', { timeout: 20_000 }).not.toBe('');
    const dataAgent = (await doc()).nodes.find((n) => n.title === 'Data')!.taskId!;
    await expect.poll(() => page.getByTestId('research-to').innerText()).toMatch(/\(Data aspect\)/);
    // Its agent is on the research's row, not in the team's list.
    await expect.poll(() => row.innerText()).toMatch(/1 agents/);
    const alias = (await snap()).tasks.find((x) => x.taskId === dataAgent)!.alias;
    expect(await page.locator(`[data-testid="rail-item"][data-alias="${alias}"]`).count()).toBe(0);
    expect((await snap()).research[0].taskIds).toContain(dataAgent);

    // Talking to it from the box: sent to that agent; open its conversation; Esc comes back here.
    await page.getByTestId('research-input').fill('Which method would you try first?');
    await page.getByTestId('research-send').click();
    await expect.poll(() => page.getByTestId('research-sent').innerText()).toMatch(/Sent to/);
    await page.getByTestId('research-open-agent').click();
    await expect.poll(() => page.getByTestId('research').count()).toBe(0);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByTestId('research').isVisible()).toBe(true);

    // A method: design and results; try two variants in parallel, one agent each, in its own worktree.
    await node('method', 'Deduplication').click();
    await expect.poll(() => panel.innerText()).toContain('How is "Deduplication" designed, and how well does it work?');
    expect(await page.getByTestId('research-bars').locator('rect').count()).toBe(3);
    await page.getByTestId('research-try-variants').click();
    await page.getByTestId('research-variants-form').locator('input').fill('0.82 / 0.87');
    await page.getByTestId('research-start-variants').click();
    await expect.poll(async () => (await doc()).nodes.filter((n) => n.type === 'experiment' && ['0.82', '0.87'].includes(n.title) && n.taskId).length, { timeout: 30_000 }).toBe(2);
    const variant = (await doc()).nodes.find((n) => n.title === '0.87')!;
    const variantTask = (await snap()).tasks.find((x) => x.taskId === variant.taskId)!;
    expect(variantTask.worktree).toBeTruthy();
    // The method is opened on the graph: its experiments one by one.
    await expect.poll(() => node('experiment', '0.87').count()).toBe(1);
    await page.screenshot({ path: join(shots, 'research-03-variants.png') });

    // An experiment: record its result (judged against the aspect's start) and a finding.
    await node('experiment', '0.87').click();
    await page.getByTestId('research-result-input').fill('78.2');
    await page.getByTestId('research-result-save').click();
    await page.getByTestId('research-finding-input').fill('0.87 keeps the code samples');
    await page.getByTestId('research-finding-input').press('Enter');
    await expect.poll(async () => (await doc()).nodes.find((n) => n.id === variant.id)).toMatchObject({ value: 78.2, status: 'pass', findings: [{ text: '0.87 keeps the code samples' }] });

    // Two methods from different aspects: combined under "Across aspects", linked to both.
    await page.getByTestId('research-depth-method').click();
    await node('method', 'Optimizer').click();
    await node('method', 'Activation').click({ modifiers: ['Shift'] });
    await expect.poll(() => panel.innerText()).toContain('From different aspects');
    await page.getByTestId('research-combine').click();
    await expect.poll(async () => (await doc()).nodes.find((n) => n.title === 'Optimizer + Activation')?.links?.map((l) => l.kind)).toEqual(['combine', 'combine']);
    expect(await page.locator('.rg-link').count()).toBe(6);

    // It is all in the repository.
    const file = JSON.parse(readFileSync(join((await snap()).projects.find((p) => p.projectId === projectId)!.rootPath, '.research', 'research.json'), 'utf8'));
    expect(file.nodes.some((n: { title: string }) => n.title === 'Optimizer + Activation')).toBe(true);
    await page.screenshot({ path: join(shots, 'research-04-combined.png') });

    // Starting one in another project: offered on its team, opens empty with a hint.
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
    await expect.poll(() => page.locator('.research-hint').count()).toBe(1);
    expect(await page.getByTestId('research-row').count()).toBe(2);
  }, 180_000);
});
