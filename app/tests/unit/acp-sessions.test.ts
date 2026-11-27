// The ACP adapter's saved-session features against the fake ACP agent: "Continue a session"
// (session/list, session/load as history), side questions (a session/fork copy, else a new session
// given the conversation), forks (session/fork, else a seeded copy) and fork points; and the tool
// content the real CLIs send (OpenCode, Antigravity) as observed.
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acpAgent } from '../../src/shared/acp-agents';
import { AcpAdapter, conversationCopy, COPY_NOTE, parseCopy } from '../../src/main/providers/acp';
import { acpToolInfo, mergeAcpTool } from '../../src/main/providers/acp-content';
import type { ProviderEvent, ProviderSession } from '../../src/main/providers/types';

const FAKE = join(__dirname, '../fixtures/fake-acp-agent.mjs');
const spec = acpAgent('opencode')!;
let dir: string;
const sessions: ProviderSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amw-acp-s-'));
  process.env.FAKE_ACP_DIR = join(dir, 'store');
  delete process.env.FAKE_ACP_LOG;
  delete process.env.FAKE_ACP_FORK;
  delete process.env.FAKE_ACP_MODES;
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  delete process.env.FAKE_ACP_FORK;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

/** An adapter on the fake agent, and a session in a fresh folder that has had two turns. */
async function talked() {
  const adapter = new AcpAdapter(spec, { command: ['node', FAKE] });
  const cwd = mkdtempSync(join(tmpdir(), 'amw-acp-s-work-'));
  const events: ProviderEvent[] = [];
  const session = adapter.createSession({ cwd, title: 't', permissionMode: 'ask' }, (e) => events.push(e));
  sessions.push(session);
  await session.start();
  const done = (n: number) => until(() => events.filter((e) => e.type === 'turnCompleted').length >= n);
  await session.send('first words');
  await done(1);
  await session.send('second words');
  await done(2);
  return { adapter, cwd, session, events, done, id: session.nativeSessionId()! };
}
const texts = (events: ProviderEvent[], role: string) => events.filter((e): e is Extract<ProviderEvent, { type: 'transcriptItem' }> => e.type === 'transcriptItem' && e.role === role).map((e) => e.text);
const stored = () => readdirSync(join(dir, 'store')).filter((f) => f.endsWith('.json')).length;

describe('ACP saved sessions', () => {
  it('lists saved sessions per folder (leaving out ones nothing was said in) and reads their history', async () => {
    const { adapter, cwd, id } = await talked();
    // A session nothing was said in ("New session - …" as OpenCode titles them).
    const empty = adapter.createSession({ cwd, title: 'e' }, () => {});
    sessions.push(empty);
    await empty.start();
    const found = await adapter.discoverSessions({ cwd });
    expect(found.map((s) => s.nativeSessionId)).toEqual([id]);
    expect(found[0]).toMatchObject({ provider: 'opencode', cwd, title: 'first words' });
    expect((await adapter.discoverSessions({})).some((s) => s.nativeSessionId === id)).toBe(true);
    const history = await adapter.readHistory(id, cwd);
    expect(texts(history, 'user')).toEqual(['first words', 'second words']);
    expect(texts(history, 'assistant')).toEqual(['Echo: first words', 'Echo: second words']);
    expect(history.every((e) => e.type === 'transcriptItem' && e.history)).toBe(true);
  });

  it('answers a side question in a deleted copy of the session (session/fork), leaving the conversation as it was', async () => {
    process.env.FAKE_ACP_FORK = '1';
    const { adapter, cwd, session, id, events } = await talked();
    const before = stored();
    expect(await session.askSide!('what did I say?', [])).toBe('Side answer: I know 2 earlier prompts.');
    expect(stored()).toBe(before); // the copy is gone again
    expect(texts(events, 'assistant').some((t) => t.includes('Side answer'))).toBe(false);
    expect(texts(await adapter.readHistory(id, cwd), 'user')).toEqual(['first words', 'second words']);
  });

  it('answers a side question in a new session given the conversation when the CLI cannot fork (as Antigravity)', async () => {
    const { adapter, cwd, session, id, events } = await talked();
    expect(await session.askSide!('what did I say?', [{ question: 'q0', response: 'a0' }])).toBe('Side answer: I know 2 earlier prompts.');
    expect(texts(events, 'assistant').some((t) => t.includes('Side answer'))).toBe(false);
    expect(texts(await adapter.readHistory(id, cwd), 'user')).toEqual(['first words', 'second words']);
    // That session is not in the agent's folder, so not offered to continue there.
    expect((await adapter.discoverSessions({ cwd })).map((s) => s.nativeSessionId)).toEqual([id]);
  });

  it('forks a whole conversation with session/fork', async () => {
    process.env.FAKE_ACP_FORK = '1';
    const { adapter, cwd, id } = await talked();
    const target = mkdtempSync(join(tmpdir(), 'amw-acp-s-fork-'));
    const fork = await adapter.forkSession(id, { cwd, targetCwd: target });
    expect(fork).not.toBe(id);
    expect(texts(await adapter.readHistory(fork, target), 'user')).toEqual(['first words', 'second words']);
  });

  it('forks into another folder (its own worktree) as a copy, since OpenCode keeps sessions to their folder', async () => {
    process.env.FAKE_ACP_FORK = '1';
    const { adapter, cwd, id } = await talked();
    const target = mkdtempSync(join(tmpdir(), 'amw-acp-s-wt-'));
    const fork = await adapter.forkSession(id, { cwd, targetCwd: target });
    const { readFileSync } = await import('node:fs');
    const raw = JSON.parse(readFileSync(join(dir, 'store', `${fork}.json`), 'utf8'));
    expect(raw.cwd).toBe(target);
    expect(raw.history[0].content.text).toContain('<conversation-copy>');
    expect(texts(await adapter.readHistory(fork, target), 'user')).toEqual(['first words', 'second words']);
  });

  it('forks without session/fork by a seeded copy that replays as the conversation it copies, also from an earlier prompt', async () => {
    const { adapter, cwd, id } = await talked();
    const points = await adapter.forkPoints(id, cwd);
    expect(points).toEqual([{ upToMessageId: 'said:2', prompt: 'second words' }]);
    const whole = await adapter.forkSession(id, { cwd });
    const history = await adapter.readHistory(whole, cwd);
    expect(texts(history, 'user')).toEqual(['first words', 'second words']);
    expect(texts(history, 'assistant')).toEqual(['Echo: first words', 'Echo: second words']); // the "ok" is not shown
    const early = await adapter.forkSession(id, { cwd, upToMessageId: points[0].upToMessageId });
    expect(texts(await adapter.readHistory(early, cwd), 'user')).toEqual(['first words']);
    // A fork of the fork carries the copied conversation on, plus what was said since.
    const s = adapter.createSession({ cwd, title: 'f', resumeNativeSessionId: early }, () => {});
    sessions.push(s);
    await s.start();
    expect(await s.askSide!('and?', [])).toBe('Side answer: I know 1 earlier prompts.');
  });

  it('carries a conversation as text and reads it back', () => {
    const lines = [
      { role: 'user' as const, text: 'hi\n"quoted"' },
      { role: 'tool' as const, text: 'Edit a.ts' },
      { role: 'assistant' as const, text: 'done' },
    ];
    expect(parseCopy(conversationCopy(lines, COPY_NOTE))).toEqual({ lines, rest: undefined });
    expect(parseCopy(conversationCopy(lines, 'next please'))?.rest).toBe('next please');
    expect(parseCopy('hello <conversation-copy></conversation-copy>')).toBeUndefined();
  });
});

describe('ACP tool content as the real CLIs send it', () => {
  it('keeps the diff OpenCode sent with its permission request after the result replaces the content', () => {
    let t = mergeAcpTool(undefined, { toolCallId: 'c1', title: 'write', kind: 'edit', status: 'pending', rawInput: {} });
    t = mergeAcpTool(t, { toolCallId: 'c1', kind: 'edit', title: 'hello.txt', content: [{ type: 'diff', path: '/w/hello.txt', oldText: null, newText: 'hi' }] });
    t = mergeAcpTool(t, { toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Created file successfully: hello.txt' } }] });
    const info = acpToolInfo(t, '/w');
    expect(info.content.map((c) => c.type)).toEqual(['diff', 'text']);
    expect(info.content[0]).toMatchObject({ type: 'diff', diff: { path: 'hello.txt', operation: 'add', phase: 'applied' } });
  });

  it('shows a diff from a file tool input when none was sent (OpenCode allowed without asking)', () => {
    const t = mergeAcpTool(undefined, { toolCallId: 'c2', title: 'edit', kind: 'edit', status: 'completed', rawInput: { filePath: '/w/a.ts', oldString: 'a = 1', newString: 'a = 2' } });
    const d = acpToolInfo(t, '/w').content[0];
    expect(d).toMatchObject({ type: 'diff', diff: { path: 'a.ts', operation: 'modify', added: 1, removed: 1 } });
  });

  it("reads Antigravity's command and its output without the header it adds", () => {
    const t = mergeAcpTool(undefined, {
      toolCallId: 'c3',
      kind: 'execute',
      title: 'echo hi',
      status: 'completed',
      rawInput: { CommandLine: 'echo hi', WaitMsBeforeAsync: 5000 },
      rawOutput: { output: 'Created At: 2026-11-26T15:04:26-06:00\nCompleted At: 2026-11-26T15:04:26-06:00\nCommand exited with code 0.\n\nCommand output:\nhi\r\n', exit_code: 0 },
      content: [{ type: 'content', content: { type: 'text', text: 'Created At: 2026-11-26T15:04:26-06:00\nCompleted At: 2026-11-26T15:04:26-06:00\nCommand exited with code 3.\n\nCommand output:\nhi\r\n' } }],
    });
    expect(acpToolInfo(t, '/w').content[0]).toEqual({ type: 'terminal', command: 'echo hi', output: 'hi\n', exitCode: 0 });
  });

  it("merges the registry's environment over the user's own JSON value", () => {
    const adapter = new AcpAdapter(spec);
    const env = adapter.agentEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'x/y', permission: { read: 'deny', bash: 'allow' } }) });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({ model: 'x/y', permission: { read: 'deny', bash: 'ask', edit: 'ask', webfetch: 'ask' } });
    expect(JSON.parse(adapter.agentEnv({}).OPENCODE_CONFIG_CONTENT)).toEqual({ permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } });
    expect(new AcpAdapter(acpAgent('antigravity')!).agentEnv({})).toEqual({});
  });
});

describe('read-only commands (Decide automatically)', () => {
  it('allows one plain looking command, nothing that chains, redirects or writes', async () => {
    const { readOnlyCommand } = await import('../../src/main/providers/acp-content');
    for (const c of ['echo hi', 'ls -la src', 'git status --short', 'git diff HEAD~1', 'cat "a b.txt"', 'rg foo src']) expect(readOnlyCommand(c), c).toBe(true);
    for (const c of ['rm -rf x', 'echo hi > f', 'ls; rm x', 'cat a | sh', 'echo $(whoami)', 'git push', 'git commit -m x', 'find . -delete', 'npm test', 'echo `id`', 'ls && touch x', 'git log --output=x'])
      expect(readOnlyCommand(c), c).toBe(false);
  });

  it('an approval refused is a declined decision (by kind, else by label)', async () => {
    const { declinedOption } = await import('../../src/main/workspace');
    expect(declinedOption({ kind: 'reject_once', label: 'Reject' })).toBe(true);
    expect(declinedOption({ kind: 'allow_once', label: 'Allow once' })).toBe(false);
    expect(declinedOption({ label: 'Deny' })).toBe(true);
    expect(declinedOption({ label: 'Yes, allow' })).toBe(false);
  });
});

describe('forms the agent asks to fill in (ACP elicitation)', () => {
  it('become questions; the answers go back typed', async () => {
    const adapter = new AcpAdapter(spec, { command: ['node', FAKE] });
    const events: ProviderEvent[] = [];
    const session = adapter.createSession({ cwd: mkdtempSync(join(tmpdir(), 'amw-acp-f-')), title: 't' }, (e) => events.push(e));
    sessions.push(session);
    await session.start();
    await session.send('fill a form please');
    await until(() => events.some((e) => e.type === 'userInputRequested'));
    const q = events.find((e): e is Extract<ProviderEvent, { type: 'userInputRequested' }> => e.type === 'userInputRequested')!;
    expect(q.headline).toBe('Pick a drink');
    expect(q.questions.map((x) => [x.id, x.question, x.options.map((o) => o.id), !!x.allowOther])).toEqual([
      ['drink', 'Tea or coffee?', ['tea', 'coffee'], false],
      ['sugar', 'Sugar?', ['true', 'false'], false],
      ['note', 'Anything else?', [], true],
    ]);
    await session.respond(q.requestId, { answers: { drink: 'tea', sugar: 'Yes', note: 'hot' } });
    await until(() => events.some((e) => e.type === 'turnCompleted'));
    expect(texts(events, 'assistant').at(-1)).toBe('Got {"drink":"tea","sugar":true,"note":"hot"}');
  });

  it("folds OpenCode's own-answer field into its question", async () => {
    const { formQuestions } = await import('../../src/main/providers/acp');
    const { questions, fields } = formQuestions({
      type: 'object',
      properties: { q0: { type: 'string', title: 'Tea or coffee', description: 'Tea or coffee?', oneOf: [{ const: 'Tea', title: 'Tea' }, { const: 'Coffee', title: 'Coffee' }] }, q0_custom: { type: 'string', description: 'Type your own answer' } },
    });
    expect(questions).toEqual([{ id: 'q0', question: 'Tea or coffee?', header: 'Tea or coffee', options: [{ id: 'Tea', label: 'Tea' }, { id: 'Coffee', label: 'Coffee' }], allowOther: true }]);
    expect(fields).toEqual([{ name: 'q0', type: 'string', multi: false, values: ['Tea', 'Coffee'], other: 'q0_custom' }]);
  });
});
