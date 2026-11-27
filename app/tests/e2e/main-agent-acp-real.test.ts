// The main agent on the user's real OpenCode / Antigravity (opt-in; a few tiny prompts each):
//   AMW_E2E_ACP_REAL=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/main-agent-acp-real.test.ts
// Mechanical support only (not how well a model orchestrates): its workspace tools reach the app
// through the MCP bridge and their results come back; its instructions arrive; workers are mock
// agents (the demo workspace), so no extra CLI usage. The CLIs keep their own sign-in (real HOME).
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';

const enabled = process.env.AMW_E2E_ACP_REAL === '1';
const only = process.env.AMW_E2E_ACP_ONLY; // "opencode" or "antigravity"
const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
/** What happened, kept beside the screenshots (test-results/main-acp-real.log). */
const note = (line: string) => {
  console.log(line);
  appendFileSync(join(shots, 'main-acp-real.log'), `${new Date().toISOString()} ${line}\n`);
};

type Item = { role: string; text: string; via?: string; toolStatus?: string; tool?: { name: string; title: string; kind: string } };
type Snap = { main?: { taskId: string; provider: string; status: string }; projects: Array<{ projectId: string; name: string }>; tasks: Array<{ taskId: string; alias: string; provider: string; title: string }> };

async function launch(dataDir: string, provider: string): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    cwd: appDir,
    env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: provider, AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_MOCK_DELAY_MS: '50', AMW_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.app');
  await invoke(page, 'settings:update', { onboarding: { dismissed: true }, language: 'en' });
  return page;
}
const invoke = (page: Page, c: string, p: unknown) => page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c, p), [c, p] as const);
const snap = (page: Page) => invoke(page, 'workspace:snapshot', {}) as Promise<Snap>;
const mainItems = async (page: Page) => (await invoke(page, 'transcript:get', { taskId: (await snap(page)).main!.taskId })) as Item[];
const replies = async (page: Page) => (await mainItems(page)).filter((i) => i.role === 'assistant').length;
/** Says it to the main agent and waits for that turn's reply (a new reply, and the agent idle again). */
const say = async (page: Page, text: string, direct = false) => {
  const n = await replies(page);
  // Direct: to the main agent itself (a message naming an agent would go straight to that agent).
  if (direct) await invoke(page, 'task:send', { taskId: (await snap(page)).main!.taskId, text, via: 'text' });
  else {
    await page.getByTestId('dock-input').fill(text);
    await page.getByTestId('dock-input').press('Enter');
  }
  try {
    await expect.poll(() => replies(page), { timeout: 240_000, interval: 1000 }).toBeGreaterThan(n);
  } catch (e) {
    // What the main agent was doing when no reply came.
    const m = (await snap(page)).main as unknown as { status: string; summary?: string; lastError?: string };
    console.log('[diag] main', JSON.stringify({ status: m?.status, summary: m?.summary, lastError: m?.lastError }));
    console.log('[diag] items', JSON.stringify((await mainItems(page)).slice(-6).map((i) => [i.role, (i.text ?? '').slice(0, 160), i.toolStatus])));
    throw e;
  }
};
const idle = (page: Page) => expect.poll(async () => (await snap(page)).main?.status, { timeout: 240_000, interval: 1000 }).not.toMatch(/running|starting/);
const lastReply = async (page: Page) => (await mainItems(page)).filter((i) => i.role === 'assistant').at(-1)?.text ?? '';

afterEach(async () => {
  await app?.close().catch(() => {});
});

describe.runIf(enabled).each(['opencode', 'antigravity'].filter((p) => !only || p === only))('main agent on %s (real CLI)', (provider) => {
  it('calls its workspace tools through the bridge and gets the results back', async () => {
    const page = await launch(mkdtempSync(join(tmpdir(), `amw-main-acp-${provider}-`)), provider);
    await expect.poll(async () => (await snap(page)).main?.provider, { timeout: 60_000 }).toBe(provider);
    await expect.poll(async () => (await snap(page)).tasks.length).toBeGreaterThan(0);
    const before = await snap(page);

    // 1. A read tool: the reply can only name the agents if the result came back.
    await say(page, 'Call the list_workspace_agents tool once. Then reply with only the agent names, comma-separated.');
    await idle(page);
    const items = await mainItems(page);
    const toolItems = items.filter((i) => i.role === 'tool');
    note(`[${provider}] tools: ${toolItems.map((i) => `${i.tool?.kind}|${i.tool?.name}|${i.tool?.title}|${i.toolStatus}`).join(' ; ')}`);
    note(`[${provider}] reply 1: ${await lastReply(page)}`);
    if (process.env.AMW_E2E_DEBUG) console.log(JSON.stringify(toolItems, null, 1).slice(0, 4000));
    // The names come only from the tool's result; no command ran (the main agent's commands are refused).
    for (const t of before.tasks) expect(await lastReply(page)).toContain(t.alias);
    expect(toolItems.filter((i) => i.tool?.kind === 'execute' && i.toolStatus === 'completed')).toEqual([]);
    await page.screenshot({ path: join(shots, `main-acp-${provider}-01-list.png`) });

    // 2. A tool that acts: the app delivers the message to a (mock) agent.
    const target = before.tasks[0];
    await say(page, `Call the send_to_agent tool exactly once with agent "${target.alias}" and message "Ping from main: reply with ok." Do not call any other tool. Then reply with only: done`, true);
    await idle(page);
    note(`[${provider}] reply 2: ${await lastReply(page)}`);
    if (process.env.AMW_E2E_DEBUG) console.log(JSON.stringify((await mainItems(page)).filter((i) => i.role === 'tool').slice(-3), null, 1).slice(0, 3000));
    const targetItems = async () => (await invoke(page, 'transcript:get', { taskId: target.taskId })) as Item[];
    await expect.poll(async () => (await targetItems()).some((i) => i.role === 'user' && i.via === 'main' && /Ping from main/.test(i.text)), { timeout: 30_000 }).toBe(true);

    // 3. Its instructions arrived (the app's main-agent prompt names the app).
    await say(page, 'Without calling any tool: in at most six words, which app are you the main agent of?');
    await idle(page);
    const role = await lastReply(page);
    note(`[${provider}] reply 3: ${role}`);
    note(`[${provider}] all tool calls: ${(await mainItems(page)).filter((i) => i.role === 'tool').map((i) => `${i.tool?.kind}|${i.tool?.name}|${i.tool?.title}|${i.toolStatus}`).join(' ; ')}`);
    expect(role).toMatch(/Agent Workspace/i);
    await page.screenshot({ path: join(shots, `main-acp-${provider}-02-done.png`) });
  }, 600_000);
});
