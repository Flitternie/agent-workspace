// The main agent end to end with the real CLIs (opt-in, small real model calls):
//   AMW_E2E_REAL=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/main-agent.test.ts
// Demo workspace (mock workers Alice/Bob/Charlie) + a real Claude Code or Codex main agent.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';

const enabled = process.env.AMW_E2E_REAL === '1';
const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;

type Item = { role: string; text: string; via?: string; tool?: { name?: string } };
type Snap = { main?: { taskId: string; provider: string; status: string }; tasks: Array<{ taskId: string; alias: string }> };

async function launch(dataDir: string, provider: string): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    cwd: appDir,
    env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: provider, AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_MOCK_DELAY_MS: '50', AMW_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  await page.waitForSelector('.app');
  return page;
}

const invoke = (page: Page, c: string, p: unknown) => page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c, p), [c, p] as const);
const snap = (page: Page) => invoke(page, 'workspace:snapshot', {}) as Promise<Snap>;
const transcriptOf = async (page: Page, alias: string) => {
  const s = await snap(page);
  const id = alias === 'main' ? s.main!.taskId : s.tasks.find((t) => t.alias === alias)!.taskId;
  return (await invoke(page, 'transcript:get', { taskId: id })) as Item[];
};
const say = async (page: Page, text: string) => {
  await page.getByTestId('dock-input').fill(text);
  await page.getByTestId('dock-input').press('Enter');
};

afterEach(async () => {
  await app?.close().catch(() => {});
});

describe.runIf(enabled).each(['claude', 'codex'])('main agent on %s', (provider) => {
  it('takes unaddressed messages, delegates through its tools, and lets named messages go direct', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), `amw-main-${provider}-`));
    let page = await launch(dataDir, provider);
    await expect.poll(async () => (await snap(page)).main?.provider, { timeout: 30_000 }).toBe(provider);
    await expect.poll(async () => (await snap(page)).tasks.length).toBe(3);
    await expect.poll(() => page.getByTestId('main-agent-row').count()).toBe(1);

    // Unaddressed: goes to the main agent, which forwards it to the frontend agent (Bob).
    await say(page, 'Please tell whoever works on the frontend dashboard to use the shared Button component. Forward it, do not do it yourself.');
    await expect
      .poll(async () => (await transcriptOf(page, 'Bob')).some((i) => i.role === 'user' && i.via === 'main' && /button/i.test(i.text)), { timeout: 240_000 })
      .toBe(true)
      .catch(async (e) => {
        // Show what the main agent did instead.
        console.log((await transcriptOf(page, 'main')).map((i) => `[${i.role}] ${(i.tool?.name ?? '') + ' ' + i.text}`.slice(0, 300)).join('\n'));
        throw e;
      });
    expect((await transcriptOf(page, 'Alice')).some((i) => i.via === 'main')).toBe(false);
    await expect.poll(() => page.getByTestId('main-reply').innerText(), { timeout: 120_000 }).toMatch(/Bob|frontend|Button/i);
    await page.screenshot({ path: join(shots, `main-${provider}-01-delegated.png`) });

    // Status question: answered from list_agents (Alice and Charlie are waiting on the user).
    await expect.poll(async () => (await snap(page)).main?.status, { timeout: 120_000 }).not.toBe('running');
    await say(page, 'Which agents are waiting for my answer right now? Reply with their names only.');
    await expect.poll(async () => (await transcriptOf(page, 'main')).filter((i) => i.role === 'assistant').at(-1)?.text ?? '', { timeout: 240_000 }).toMatch(/Alice[\s\S]*Charlie|Charlie[\s\S]*Alice/);

    // Decisions from one place: the main agent relays a sub-agent's question and the user's answer.
    await expect.poll(async () => (await snap(page)).main?.status, { timeout: 120_000 }).not.toBe('running');
    // No agent named (that would go straight to it): the main agent finds whose question this answers.
    await say(page, 'About the question on the old /v1/orders tests: keep the compatibility adapter for one release, then update the tests to v2. Pass that on as my answer.');
    await expect.poll(async () => (await transcriptOf(page, 'Alice')).some((i) => i.role === 'user' && i.via === 'main' && /compatib|adapter/i.test(i.text)), { timeout: 240_000 }).toBe(true);
    await page.getByTestId('main-agent-row').click();
    await expect.poll(() => page.getByTestId('waiting-on-you').innerText()).toMatch(/Charlie/);
    await page.screenshot({ path: join(shots, `main-${provider}-01b-waiting.png`) });
    await page.keyboard.press('Escape');

    // Named outright: straight to Charlie, not through the main agent.
    const talk = async () => (await transcriptOf(page, 'main')).filter((i) => i.role === 'user' || i.role === 'assistant').length;
    const before = await talk();
    await say(page, 'Charlie, add a backfill step first.');
    await expect.poll(async () => (await transcriptOf(page, 'Charlie')).some((i) => i.role === 'user' && i.text === 'Charlie, add a backfill step first.' && i.via === 'text'), { timeout: 30_000 }).toBe(true);
    expect(await talk()).toBe(before); // the main agent was not involved…
    // …but its conversation notes that Charlie's question is settled (one state for every view).
    await expect.poll(async () => (await transcriptOf(page, 'main')).some((i) => i.role === 'system' && /Charlie's request is settled/.test(i.text))).toBe(true);

    // Restart: the main agent resumes with its tools.
    await expect.poll(async () => (await snap(page)).main?.status, { timeout: 120_000 }).not.toBe('running');
    await app!.close();
    page = await launch(dataDir, provider);
    await expect.poll(() => page.getByTestId('main-agent-row').count(), { timeout: 30_000 }).toBe(1);
    // (No role handle like "backend agent" here: that would count as naming Alice and go to her directly.)
    await say(page, 'Ask whoever handles the API endpoints to keep the compatibility adapter. Forward it, do not do it yourself.');
    await expect.poll(async () => (await transcriptOf(page, 'Alice')).some((i) => i.role === 'user' && i.via === 'main' && /compatib/i.test(i.text)), { timeout: 240_000 }).toBe(true);
    await page.getByTestId('main-agent-row').click();
    await page.screenshot({ path: join(shots, `main-${provider}-02-conversation.png`) });
  }, 900_000);
});
