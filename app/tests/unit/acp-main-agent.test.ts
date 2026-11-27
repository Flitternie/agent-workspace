// The main agent on a CLI reached through ACP: the workspace tools served as an MCP server (stdio
// bridge → this process), passed in session/new; its own tool calls allowed, edits and commands
// refused without asking the user; instructions through Antigravity's system-prompt field.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { acpAgent } from '../../src/shared/acp-agents';
import { AcpAdapter } from '../../src/main/providers/acp';
import { startMcpBridge } from '../../src/main/providers/acp-mcp';
import type { WorkspaceTool } from '../../src/main/main-agent';
import { pickMainProvider } from '../../src/main/main-agent';
import type { ProviderEvent, ProviderSession } from '../../src/main/providers/types';

const FAKE = join(__dirname, '../fixtures/fake-acp-agent.mjs');
let dir: string;
let logFile: string;
const sessions: ProviderSession[] = [];
const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

const tools: WorkspaceTool[] = [
  { name: 'list_workspace_agents', description: 'List agents', schema: z.object({}), run: async () => 'Alice — mock, idle' },
  {
    name: 'create_agent',
    description: 'Create an agent',
    schema: z.object({ project: z.string(), title: z.string(), provider: z.string().optional() }),
    run: async (a) => {
      calls.push({ name: 'create_agent', args: a });
      return `Started Bob (${String(a.provider)}) on ${String(a.project)}: "${String(a.title)}".`;
    },
  },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amw-acp-main-'));
  logFile = join(dir, 'log.jsonl');
  process.env.FAKE_ACP_DIR = join(dir, 'store');
  process.env.FAKE_ACP_LOG = logFile;
  delete process.env.FAKE_ACP_MODES;
  delete process.env.FAKE_ACP_AGY_SYSPROMPT;
  calls.length = 0;
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  delete process.env.FAKE_ACP_AGY_SYSPROMPT;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}
const received = (): Array<{ method?: string; params?: Record<string, unknown> }> =>
  existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

function open(withTools = true) {
  const adapter = new AcpAdapter(acpAgent('antigravity')!, { command: ['node', FAKE] });
  const events: ProviderEvent[] = [];
  const session = adapter.createSession(
    { cwd: mkdtempSync(join(tmpdir(), 'amw-acp-main-work-')), title: 'Main agent', permissionMode: 'ask', developerInstructions: 'You are the main agent.', ...(withTools ? { tools } : {}) },
    (e) => events.push(e),
  );
  sessions.push(session);
  const of = <T extends ProviderEvent['type']>(type: T) => events.filter((e): e is Extract<ProviderEvent, { type: T }> => e.type === type);
  return { session, events, of };
}

describe('MCP bridge', () => {
  it('serves the tools over MCP stdio, validates arguments and refuses a wrong token', async () => {
    const bridge = await startMcpBridge(tools, { node: process.execPath });
    try {
      const env = { ...process.env, ...Object.fromEntries(bridge.server.env.map((e) => [e.name, e.value])) };
      const child = spawn(bridge.server.command, bridge.server.args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
      const replies = new Map<number, Record<string, unknown>>();
      createInterface({ input: child.stdout }).on('line', (l) => {
        const m = JSON.parse(l);
        replies.set(m.id, m);
      });
      let id = 0;
      const rpc = async (method: string, params: unknown) => {
        const n = ++id;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
        await until(() => replies.has(n), 10_000, method);
        return replies.get(n)! as { result?: Record<string, unknown>; error?: { message: string } };
      };
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      expect(init.result).toMatchObject({ capabilities: { tools: {} }, protocolVersion: '2025-06-18' });
      const list = await rpc('tools/list', {});
      const listed = (list.result!.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>);
      expect(listed.map((t) => t.name)).toEqual(['list_workspace_agents', 'create_agent']);
      expect(Object.keys(listed[1].inputSchema.properties ?? {})).toEqual(['project', 'title', 'provider']);
      const ok = await rpc('tools/call', { name: 'create_agent', arguments: { project: 'shop', title: 'Fix it', provider: 'mock' } });
      expect(ok.result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'Started Bob (mock) on shop: "Fix it".' }] });
      const bad = await rpc('tools/call', { name: 'create_agent', arguments: { title: 1 } });
      expect(bad.result).toMatchObject({ isError: true });
      expect(calls).toHaveLength(1);
      child.kill();
      // Without the token: nothing runs.
      const url = bridge.server.env.find((e) => e.name === 'AMW_MCP_URL')!.value;
      expect((await fetch(`${url}/call`, { method: 'POST', body: JSON.stringify({ name: 'create_agent', arguments: { project: 'x', title: 'y' } }) })).status).toBe(401);
      expect(calls).toHaveLength(1);
      expect(bridge.owns('workspace_create_agent')).toBe(true);
      expect(bridge.owns('mcp__workspace__list_workspace_agents')).toBe(true);
      expect(bridge.owns('write_file')).toBe(false);
    } finally {
      bridge.close();
    }
  }, 30_000);
});

describe('main agent on an ACP CLI', () => {
  it('passes the tools as an MCP server, runs its tool call without asking, and refuses edits', async () => {
    const { session, of } = open();
    await session.start();
    const created = received().find((m) => m.method === 'session/new')!;
    const servers = created.params!.mcpServers as Array<{ name: string; command: string; env: Array<{ name: string }> }>;
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('workspace');
    expect(servers[0].env.map((e) => e.name)).toContain('AMW_MCP_TOKEN');

    await session.send('mcp create_agent {"project":"shop","title":"Fix the cart","provider":"mock"}');
    await until(() => of('turnCompleted').length >= 1, 20_000, 'tool turn');
    expect(calls).toEqual([{ name: 'create_agent', args: { project: 'shop', title: 'Fix the cart', provider: 'mock' } }]);
    expect(of('approvalRequested')).toHaveLength(0);
    const reply = of('transcriptItem').filter((e) => e.role === 'assistant').pop()!;
    expect(reply.text).toContain('Tools: list_workspace_agents,create_agent.');
    expect(reply.text).toContain('Started Bob (mock) on shop');
    const toolItem = of('transcriptItem').filter((e) => e.role === 'tool' && e.itemId.startsWith('mcp-')).pop()!;
    expect(toolItem.toolStatus).toBe('completed');

    // An edit: refused at once, never put to the user.
    await session.send('now make a tool call');
    await until(() => of('turnCompleted').length >= 2, 20_000, 'edit turn');
    expect(of('approvalRequested')).toHaveLength(0);
    expect(of('transcriptItem').filter((e) => e.role === 'assistant').pop()!.text).toContain('I left it alone');
    const answers = received().filter((m) => (m as { result?: { outcome?: { optionId?: string } } }).result?.outcome);
    expect(answers.map((m) => (m as { result: { outcome: { optionId: string } } }).result.outcome.optionId)).toEqual(['once', 'reject']);
  }, 40_000);

  it('delivers the instructions in session/new where the agent takes a system prompt (Antigravity), else with the first prompt', async () => {
    process.env.FAKE_ACP_AGY_SYSPROMPT = '1';
    const a = open(false);
    await a.session.start();
    expect(received().find((m) => m.method === 'session/new')!.params!._meta).toEqual({ antigravity: { systemPrompt: { append: 'You are the main agent.' } } });
    await a.session.send('hello');
    await until(() => a.of('turnCompleted').length >= 1, 10_000, 'turn');
    const prompt = received().filter((m) => m.method === 'session/prompt').pop()!.params!.prompt as Array<{ text: string }>;
    expect(prompt.map((b) => b.text).join('')).not.toContain('system-reminder');

    delete process.env.FAKE_ACP_AGY_SYSPROMPT;
    const b = open(false);
    await b.session.start();
    expect(received().filter((m) => m.method === 'session/new').pop()!.params!._meta).toBeUndefined();
    await b.session.send('hello');
    await until(() => b.of('turnCompleted').length >= 1, 10_000, 'turn');
    const first = received().filter((m) => m.method === 'session/prompt').pop()!.params!.prompt as Array<{ text: string }>;
    expect(first[0].text).toContain('<system-reminder>\nYou are the main agent.');
  }, 30_000);

  it("sets an agent with its own permission modes to asking (what it asks is decided here)", async () => {
    process.env.FAKE_ACP_MODES = '1';
    const { session } = open();
    await session.start();
    expect(received().find((m) => m.method === 'session/set_mode')?.params).toMatchObject({ modeId: 'default' });
    delete process.env.FAKE_ACP_MODES;
  }, 20_000);

  it('picks an ACP CLI for the main agent only when chosen', () => {
    const ready = () => true;
    expect(pickMainProvider(undefined, ready)).toBe('claude');
    expect(pickMainProvider('opencode', ready)).toBe('opencode');
    expect(pickMainProvider('antigravity', (p) => p !== 'antigravity')).toBeUndefined();
    expect(pickMainProvider('off', ready)).toBeUndefined();
  });
});
