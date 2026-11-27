// What an ACP CLI reports beyond the protocol's basics, as the app shows it: sub-agents (OpenCode's
// background `subagent` with its child-session updates, Antigravity's invoke_subagent), the round an
// agent starts by itself when a sub-agent reports back, OpenCode's retry notice, Antigravity's quota
// error, and a turn that goes quiet.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acpAgent } from '../../src/shared/acp-agents';
import { AcpAdapter, type AcpAdapterOptions } from '../../src/main/providers/acp';
import { AcpSubtasks } from '../../src/main/providers/subtasks';
import type { ProviderEvent, ProviderSession, StartArgs } from '../../src/main/providers/types';

const FAKE = join(__dirname, '../fixtures/fake-acp-agent.mjs');
const sessions: ProviderSession[] = [];
let logFile: string;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'amw-acp-sub-'));
  process.env.FAKE_ACP_DIR = join(dir, 'store');
  logFile = join(dir, 'log.jsonl');
  process.env.FAKE_ACP_LOG = logFile;
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  delete process.env.FAKE_ACP_LOG;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}

function open(id: 'opencode' | 'antigravity', args: Partial<StartArgs> = {}, opts: AcpAdapterOptions = {}) {
  const adapter = new AcpAdapter(acpAgent(id)!, { command: ['node', FAKE], idleMs: 300, ...opts });
  const events: ProviderEvent[] = [];
  const session = adapter.createSession({ cwd: mkdtempSync(join(tmpdir(), 'amw-acp-subw-')), title: 't', permissionMode: 'ask', ...args }, (e) => events.push(e));
  sessions.push(session);
  const of = <T extends ProviderEvent['type']>(type: T) => events.filter((e): e is Extract<ProviderEvent, { type: T }> => e.type === type);
  return { session, events, of };
}

describe('sub-agents', () => {
  it('OpenCode: its background sub-agent as a sub-agent with steps and report; its report-back round is a turn of its own', async () => {
    const { session, events, of } = open('opencode');
    await session.start();
    // Asked for the child sessions' updates.
    const init = readFileSync(logFile, 'utf8').split('\n').map((l) => (l ? JSON.parse(l) : {})).find((m) => m.method === 'initialize');
    expect(init.params.clientCapabilities._meta).toEqual({ 'opencode/child-session-updates': true });
    await session.send('use a subagent');
    await until(() => of('turnCompleted').length >= 2, 8000, 'the report-back round');
    const sub = of('subtask');
    expect(sub[0]).toMatchObject({ id: 'call-sub-0', status: 'running' });
    expect(sub.find((e) => e.description === 'Find the secret word')).toBeTruthy();
    expect(sub.filter((e) => e.step).map((e) => e.step)).toEqual(['read', 'read README.md']);
    expect(sub.at(-1)).toMatchObject({ id: 'call-sub-0', status: 'done', result: 'pineapple' });
    // The launch turn ends while it works; the agent then speaks by itself: turnStarted … turnCompleted.
    const order = events.filter((e) => e.type === 'turnStarted' || e.type === 'turnCompleted').map((e) => e.type);
    expect(order).toEqual(['turnStarted', 'turnCompleted', 'turnStarted', 'turnCompleted']);
    expect(of('turnCompleted').map((t) => t.finalText)).toEqual(['Launched a sub-agent.', 'The secret word is pineapple.']);
    // The tool in the transcript says what the sub-agent is for.
    expect(of('transcriptItem').filter((e) => e.itemId === 'call-sub-0').at(-1)?.tool?.title).toBe('Sub-agent: Find the secret word');
  });

  it('OpenCode: a background sub-agent asking permission after the turn ended is put to the user', async () => {
    const { session, of } = open('opencode');
    await session.start();
    await session.send('subagent ask');
    await until(() => of('approvalRequested').length > 0, 8000, 'the approval');
    expect(of('turnCompleted')).toHaveLength(1);
    const req = of('approvalRequested')[0];
    expect(req.headline).toMatch(/README\.md/);
    // Not part of the main transcript.
    expect(of('transcriptItem').some((e) => e.itemId.includes(':edit-1'))).toBe(false);
    await session.respond(req.requestId, { decision: 'once' });
    await until(() => of('subtask').some((e) => e.status === 'done'));
    expect(of('subtask').find((e) => e.status === 'done')?.result).toBe('pineapple');
    // The choice reached it (its message before the report).
    expect(readFileSync(logFile, 'utf8')).toContain('"optionId":"once"');
    await until(() => of('turnCompleted').length >= 2);
  });

  it('Antigravity: invoke_subagent is a sub-agent named by its role, done when the turn that waited for it ends', async () => {
    const { session, of } = open('antigravity');
    await session.start();
    await session.send('delegate this');
    await until(() => of('turnCompleted').length >= 1);
    expect(of('subtask')).toEqual([
      { type: 'subtask', id: 'agy-sub-0', description: 'Readme Reader', status: 'running' },
      { type: 'subtask', id: 'agy-sub-0', status: 'done', step: '' },
    ]);
  });

  it('pure bookkeeping with the shapes OpenCode 2.4.2 sent (child created before the call names it)', () => {
    const s = new AcpSubtasks();
    const step = (u: Record<string, unknown>) => String(u.title).replace(/^.*: /, '');
    const out = [
      ...s.tool({ id: 'call_1', name: 'subagent', status: 'pending', rawInput: {} }),
      ...s.tool({ id: 'call_1', name: 'subagent', status: 'in_progress', rawInput: { agent: 'general', description: 'Read README secret word', prompt: 'Read the file README.md…' } }),
      ...s.child({ rootSessionId: 'ses_root', childSessionId: 'ses_child', parentSessionId: 'ses_root', depth: 1, title: 'Read README secret word', type: 'status', status: 'created' }, step),
      ...s.tool({ id: 'call_1', name: 'subagent', status: 'completed', rawInput: { description: 'Read README secret word' }, rawOutput: { metadata: { sessionID: 'ses_child', status: 'running', truncated: false } } }, 'The subagent is working in the background (sessionID: ses_child).'),
      ...s.child({ childSessionId: 'ses_child', parentSessionId: 'ses_root', depth: 1, title: 'Read README secret word', type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'ses_child:call_2', name: 'read', title: 'Read README secret word: read', kind: 'read', status: 'pending' } }, step),
      // A helper of the helper: a step of the first.
      ...s.child({ childSessionId: 'ses_grand', parentSessionId: 'ses_child', depth: 2, title: 'Deeper', type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'g1', title: 'Deeper: grep', kind: 'search', status: 'pending' } }, step),
      ...s.child({ childSessionId: 'ses_grand', parentSessionId: 'ses_child', depth: 2, title: 'Deeper', type: 'status', status: 'completed' }, step),
      ...s.child({ childSessionId: 'ses_child', depth: 1, title: 'Read README secret word', type: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg_a', content: { type: 'text', text: 'draft' } } }, step),
      ...s.child({ childSessionId: 'ses_child', depth: 1, title: 'Read README secret word', type: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg_b', content: { type: 'text', text: 'pineapple' } } }, step),
      ...s.child({ childSessionId: 'ses_child', depth: 1, title: 'Read README secret word', type: 'status', status: 'completed' }, step),
    ];
    expect(out).toEqual([
      { type: 'subtask', id: 'call_1', description: 'Sub-agent', status: 'running' },
      { type: 'subtask', id: 'call_1', description: 'Read README secret word' },
      { type: 'subtask', id: 'call_1', step: 'read' },
      { type: 'subtask', id: 'call_1', step: 'grep' },
      { type: 'subtask', id: 'call_1', status: 'done', step: '', result: 'pineapple' },
    ]);
    // OpenCode 1.x's task tool runs within the call: its output is the report.
    const old = new AcpSubtasks();
    expect(old.tool({ id: 't', name: 'task', status: 'completed', rawInput: { description: 'Look around', subagent_type: 'general' } }, 'Found it.')).toEqual([
      { type: 'subtask', id: 't', description: 'Look around', status: 'running' },
      { type: 'subtask', id: 't', status: 'done', step: '', result: 'Found it.' },
    ]);
  });
});

describe('retries, quota and silence', () => {
  it("OpenCode's retry notice becomes the app's retry status (no maximum: it decides), and the turn goes on", async () => {
    const { session, of } = open('opencode');
    await session.start();
    await session.send('retry please');
    await until(() => of('turnCompleted').length >= 1);
    const r = of('retrying');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'rate_limit', attempt: 1, maxAttempts: 0, error: 'Rate limit exceeded (429)' });
    expect(r[0].delayMs).toBeGreaterThan(0);
    expect(r[0].delayMs).toBeLessThanOrEqual(1000);
    expect(of('turnCompleted')[0]).toMatchObject({ status: 'completed', finalText: 'Done after a retry.' });
  });

  it("Antigravity's quota error says so, and is not retried as if the model were busy", async () => {
    const { session, of } = open('antigravity');
    await session.start();
    await session.send('quota');
    await until(() => of('turnCompleted').length >= 1);
    const t = of('turnCompleted')[0];
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/^Antigravity is out of quota for this model \(RESOURCE_EXHAUSTED/);
    expect(t.transient).toBeUndefined();
  });

  it('a turn that goes quiet says so, once', async () => {
    const { session, of } = open('opencode', {}, { stallMs: 300 });
    await session.start();
    await session.send('silent');
    await until(() => of('turnCompleted').length >= 1);
    expect(of('progress').filter((p) => p.text.startsWith('No update from OpenCode'))).toHaveLength(1);
  });
});
