#!/usr/bin/env node
// A fake coding agent speaking the Agent Client Protocol (v1) over stdio, for tests: what it does is
// chosen by words in the prompt. Sessions are kept as JSON files (FAKE_ACP_DIR) so session/load can
// replay them from another process; every message received is appended to FAKE_ACP_LOG when set.
//   tool  an edit with a diff, after asking permission      run   a command, after asking permission
//   read  a read (asks permission; a client may allow it)   plan  a checklist
//   slow  streams for a few seconds (cancel, dropped links) fail  a failed prompt
//   auth  "authentication required"                         else  an echo, in chunks
//   mcp <tool> [json]  calls that tool on the first MCP server it was given (after asking permission)
// Its own commands (as the CLIs' status and login): `auth list`, `models`, `--login` (prints a link, reads
// the code: "good-code" signs in). Signed in unless FAKE_ACP_AUTH_FILE names a missing file (login creates it)
// or FAKE_ACP_SIGNED_OUT=1.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// `-p /usage --output-format json` (as Antigravity): the account's limits as JSON, then exit.
if (process.argv.includes('/usage')) {
  process.stdout.write(
    `${JSON.stringify({
      status: 'SUCCESS',
      num_turns: 0,
      command: {
        name: 'usage',
        data: {
          groups: [
            { name: 'Fake Models', buckets: [{ id: 'fake-5h', window: '5h', remaining_fraction: 0.75, reset_time: '2030-01-01T00:00:00Z' }, { id: 'fake-weekly', window: 'weekly', remaining_fraction: 0.9, reset_time: '2030-01-05T00:00:00Z' }] },
            { name: 'Other models', buckets: [{ id: 'other-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' }] },
          ],
        },
      },
    })}\n`,
  );
  process.exit(0);
}

const authFile = process.env.FAKE_ACP_AUTH_FILE;
const signedIn = () => (authFile ? existsSync(authFile) : process.env.FAKE_ACP_SIGNED_OUT !== '1');
if (process.argv.includes('auth') && process.argv.includes('list')) {
  process.stdout.write(`${JSON.stringify(signedIn() ? [{ id: 'fakeco', name: 'FakeCo', connections: [{ type: 'credential', id: 'c1', label: 'Personal', method: 'oauth' }] }] : [])}\n`);
  process.exit(0);
}
if (process.argv.includes('models')) {
  if (!signedIn()) {
    process.stderr.write('Error: Please sign in to view available models.\n');
    process.exit(1);
  }
  process.stdout.write('fakeco/fake-small\nfakeco/fake-large\n');
  process.exit(0);
}
if (process.argv.includes('--login')) {
  process.stdout.write('Open this link in a browser to log in:\n\n  https://example.test/oauth?state=fake\n\nThen paste the authorization code and press Enter:\n');
  const rl = createInterface({ input: process.stdin });
  rl.on('close', () => setTimeout(() => process.exit(1), 50));
  rl.once('line', (code) => {
    if (code.trim() !== 'good-code') {
      process.stdout.write('couldn\'t log in: token exchange failed: "invalid_grant"\n');
      process.exit(1);
    }
    if (authFile) writeFileSync(authFile, 'ok');
    process.stdout.write('Logged in.\n');
    process.exit(0);
  });
  // Waits for the code (stdin stays open).
  setInterval(() => {}, 1000);
}

const dir = process.env.FAKE_ACP_DIR || join(tmpdir(), 'fake-acp');
mkdirSync(dir, { recursive: true });
const log = process.env.FAKE_ACP_LOG;
const withModes = process.env.FAKE_ACP_MODES === '1';
// FAKE_ACP_FORK=1: session/fork and session/delete too (as OpenCode); else list and close only (as Antigravity).
const withFork = process.env.FAKE_ACP_FORK === '1';
const MODELS = [
  { value: 'fake-small', name: 'Fake Small' },
  { value: 'fake-large', name: 'Fake Large' },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const waiting = new Map();
/** A request to the client; resolves with its result. */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `agent-${++seq}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const sessions = new Map();
const file = (id) => join(dir, `${id}.json`);
function session(id) {
  if (!sessions.has(id) && existsSync(file(id))) sessions.set(id, JSON.parse(readFileSync(file(id), 'utf8')));
  return sessions.get(id);
}
const save = (s) => writeFileSync(file(s.id), JSON.stringify({ ...s, updated: Date.now() }));
const config = (s) => ({
  configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: MODELS }],
  ...(withModes
    ? {
        modes: {
          currentModeId: s.mode,
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'accept-edits', name: 'Accept edits' },
            { id: 'auto', name: 'Auto' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      }
    : {}),
});

/** A session update, recorded for replay. */
function update(s, u, record = true) {
  send({ method: 'session/update', params: { sessionId: s.id, update: u } });
  if (record) s.history.push(u);
}

async function stream(s, kind, text, messageId) {
  for (const piece of text.match(/.{1,6}/gs) ?? []) {
    if (s.cancelled) return;
    update(s, { sessionUpdate: kind, content: { type: 'text', text: piece }, ...(messageId ? { messageId } : {}) });
    await sleep(5);
  }
}

async function permission(s, toolCall, options) {
  const r = await ask('session/request_permission', { sessionId: s.id, toolCall, options });
  return r?.outcome?.outcome === 'selected' ? r.outcome.optionId : 'cancelled';
}

const OPTIONS = [
  { optionId: 'once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

/** One call on a stdio MCP server (ACP's McpServerStdio): initialize, tools/list, tools/call. */
async function mcpCall(server, name, args) {
  const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value])) };
  const child = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let n = 0;
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = ++n; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await rpc('tools/list', {});
    const r = await rpc('tools/call', { name, arguments: args });
    return { tools: (list.result?.tools ?? []).map((t) => t.name), text: r.result?.content?.[0]?.text ?? r.error?.message, isError: !!r.result?.isError };
  } finally {
    child.kill();
  }
}

async function prompt(s, text) {
  const n = s.turns++;
  const user = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '');
  s.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
  if (user.includes('<conversation-copy>') && /reply with only: ok$/i.test(user.trim())) {
    await stream(s, 'agent_message_chunk', 'ok', `m-${n}`);
    return 'end_turn';
  }
  if (user.includes('(A side question')) {
    // How much of the conversation it knows: its own history (a fork), or the copy it was given.
    const copied = (user.match(/^\{"role":"user"/gm) ?? []).length;
    const own = s.history.filter((u) => u.sessionUpdate === 'user_message_chunk').length - 1;
    await stream(s, 'agent_message_chunk', `Side answer: I know ${copied || own} earlier prompts.`, `m-${n}`);
    return 'end_turn';
  }
  if (/\bfail\b/.test(user)) throw { code: -32603, message: 'Model exploded' };
  if (/\bauth\b/.test(user)) throw { code: -32000, message: 'Authentication required' };
  const mcp = user.match(/\bmcp (\w+)(?: (\{.*\}))?/);
  if (mcp) {
    const server = (s.mcpServers ?? [])[0];
    if (!server) {
      await stream(s, 'agent_message_chunk', 'No MCP server.');
      return 'end_turn';
    }
    const id = `mcp-${s.id}-${n}`;
    const title = `${server.name}_${mcp[1]}`;
    update(s, { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'other', status: 'pending', rawInput: JSON.parse(mcp[2] ?? '{}') });
    const choice = await permission(s, { toolCallId: id, title, kind: 'other' }, OPTIONS);
    if (choice !== 'once' && choice !== 'always') {
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' });
      await stream(s, 'agent_message_chunk', 'Tool refused.');
      return 'end_turn';
    }
    const r = await mcpCall(server, mcp[1], JSON.parse(mcp[2] ?? '{}'));
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: r.isError ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: r.text } }] });
    await stream(s, 'agent_message_chunk', `Tools: ${r.tools.join(',')}. Result: ${r.text}`);
    return 'end_turn';
  }
  await stream(s, 'agent_thought_chunk', `Thinking about ${user.slice(0, 20)}`);
  if (/\btool\b/.test(user)) {
    const id = `edit-${s.id}-${n}`;
    const path = join(s.cwd, 'src', 'app.ts');
    const diff = { type: 'diff', path, oldText: 'const a = 1;\nconst b = 2;\n', newText: 'const a = 1;\nconst b = 3;\n' };
    await stream(s, 'agent_message_chunk', 'I will edit the file.', `m-${n}-a`);
    update(s, { sessionUpdate: 'tool_call', toolCallId: id, title: 'Edit src/app.ts', kind: 'edit', status: 'pending', content: [diff], locations: [{ path, line: 2 }] });
    const choice = await permission(s, { toolCallId: id, title: 'Edit src/app.ts', kind: 'edit', content: [diff], locations: [{ path }] }, OPTIONS);
    if (s.cancelled) return 'cancelled';
    if (choice === 'reject' || choice === 'cancelled') {
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' });
      await stream(s, 'agent_message_chunk', 'Okay, I left it alone.', `m-${n}-b`);
      return 'end_turn';
    }
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' });
    await sleep(20);
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [diff] });
    await stream(s, 'agent_message_chunk', 'Edited src/app.ts.', `m-${n}-b`);
    return 'end_turn';
  }
  if (/\brun\b/.test(user)) {
    const id = `run-${s.id}-${n}`;
    update(s, { sessionUpdate: 'tool_call', toolCallId: id, title: 'npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
    const choice = await permission(s, { toolCallId: id, title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } }, OPTIONS);
    if (s.cancelled) return 'cancelled';
    const ok = choice === 'once' || choice === 'always';
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', ...(ok ? { content: [{ type: 'content', content: { type: 'text', text: '3 passing' } }], rawOutput: { exitCode: 0 } } : {}) });
    await stream(s, 'agent_message_chunk', ok ? 'Tests pass.' : 'Did not run them.');
    return 'end_turn';
  }
  if (/\bread\b/.test(user)) {
    const id = `read-${s.id}-${n}`;
    update(s, { sessionUpdate: 'tool_call', toolCallId: id, title: 'Read README.md', kind: 'read', status: 'pending', locations: [{ path: join(s.cwd, 'README.md') }] });
    const choice = await permission(s, { toolCallId: id, kind: 'read', title: 'Read README.md' }, OPTIONS);
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: choice === 'once' || choice === 'always' ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: '# readme' } }] });
    await stream(s, 'agent_message_chunk', `Read it (${choice}).`);
    return 'end_turn';
  }
  if (/\bform\b/.test(user)) {
    const r = await ask('elicitation/create', {
      sessionId: s.id,
      mode: 'form',
      message: 'Pick a drink',
      requestedSchema: { type: 'object', properties: { drink: { type: 'string', title: 'Drink', description: 'Tea or coffee?', enum: ['tea', 'coffee'] }, sugar: { type: 'boolean', description: 'Sugar?' }, note: { type: 'string', description: 'Anything else?' } }, required: ['drink'] },
    });
    await stream(s, 'agent_message_chunk', r?.action === 'accept' ? `Got ${JSON.stringify(r.content)}` : `Form ${r?.action}`);
    return 'end_turn';
  }
  if (/\bplan\b/.test(user)) {
    update(s, { sessionUpdate: 'plan', entries: [{ content: 'Look around', priority: 'high', status: 'completed' }, { content: 'Write the fix', priority: 'high', status: 'in_progress' }] });
    await stream(s, 'agent_message_chunk', 'Planned.');
    return 'end_turn';
  }
  if (/\bslow\b/.test(user)) {
    for (let i = 0; i < 30; i++) {
      if (s.cancelled) return 'cancelled';
      update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `tick${i} ` }, messageId: `m-${n}` });
      await sleep(100);
    }
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'slow done' }, messageId: `m-${n}` });
    return 'end_turn';
  }
  await stream(s, 'agent_message_chunk', `Echo: ${user}`, `m-${n}`);
  update(s, { sessionUpdate: 'usage_update', used: 1200 + n, size: 200000, cost: { amount: 0.01 * (n + 1), currency: 'USD' } }, false);
  return 'end_turn';
}

async function handle(msg) {
  if (log) appendFileSync(log, `${JSON.stringify(msg)}\n`);
  if (msg.id !== undefined && !msg.method) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  const p = msg.params ?? {};
  const reply = (result) => send({ id: msg.id, result });
  const fail = (code, message) => send({ id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: false }, sessionCapabilities: { list: {}, close: {}, additionalDirectories: {}, ...(withFork ? { fork: {}, delete: {} } : {}) }, ...(process.env.FAKE_ACP_AGY_SYSPROMPT === '1' ? { _meta: { antigravity: { systemPrompt: { append: true } } } } : {}) },
        authMethods: [{ id: 'fake-login', name: 'Log in', description: 'Run fake login' }],
        agentInfo: { name: 'Fake ACP', version: '9.9.9' },
      });
    case 'session/new': {
      const s = { id: `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, cwd: p.cwd, model: 'fake-small', mode: 'default', history: [], turns: 0, mcpServers: p.mcpServers ?? [] };
      sessions.set(s.id, s);
      save(s);
      return reply({ sessionId: s.id, ...config(s), _meta: { fake: { tier: { name: 'Fake Tier' } } } });
    }
    case 'session/load': {
      const s = session(p.sessionId);
      if (!s) return fail(-32002, `Session not found: ${p.sessionId}`);
      s.mcpServers = p.mcpServers ?? [];
      for (const u of s.history) update(s, u, false);
      return reply(config(s));
    }
    case 'session/list': {
      const { readdirSync } = await import('node:fs');
      const all = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
        .filter((x) => !p.cwd || x.cwd === p.cwd)
        .map((x) => ({ sessionId: x.id, cwd: x.cwd, title: x.history.find((u) => u.sessionUpdate === 'user_message_chunk')?.content.text.slice(0, 40) ?? 'New session - 2026-01-01T00:00:00Z', updatedAt: new Date(x.updated ?? 0).toISOString() }));
      return reply({ sessions: all });
    }
    case 'session/fork': {
      const from = session(p.sessionId);
      if (!withFork || !from) return fail(-32601, 'Method not found: session/fork');
      const s = { ...from, id: `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, cwd: p.cwd ?? from.cwd, history: [...from.history] };
      sessions.set(s.id, s);
      save(s);
      return reply({ sessionId: s.id, ...config(s) });
    }
    case 'session/delete': {
      const { rmSync } = await import('node:fs');
      sessions.delete(p.sessionId);
      rmSync(file(p.sessionId), { force: true });
      return reply({});
    }
    case 'session/close':
      return reply({});
    case 'authenticate':
      // As Antigravity's browser sign-in: answers once the browser is done (here: at once, or never for FAKE_ACP_AUTH_HANG).
      if (process.env.FAKE_ACP_AUTH_HANG === '1') return;
      await sleep(100);
      if (authFile) writeFileSync(authFile, 'ok');
      return reply({});
    case 'session/set_mode': {
      const s = session(p.sessionId);
      s.mode = p.modeId;
      update(s, { sessionUpdate: 'current_mode_update', currentModeId: p.modeId }, false);
      return reply({});
    }
    case 'session/set_config_option': {
      const s = session(p.sessionId);
      if (p.configId !== 'model' || !MODELS.some((m) => m.value === p.value)) return fail(-32602, 'Unknown option');
      s.model = p.value;
      save(s);
      return reply({ configOptions: config(s).configOptions });
    }
    case 'session/prompt': {
      const s = session(p.sessionId);
      if (!s) return fail(-32002, 'Session not found');
      s.cancelled = false;
      const text = (p.prompt ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      try {
        const stopReason = await prompt(s, text);
        save(s);
        return reply({ stopReason: s.cancelled ? 'cancelled' : stopReason, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
      } catch (e) {
        save(s);
        return fail(e.code ?? -32603, e.message ?? String(e));
      }
    }
    case 'session/cancel': {
      const s = session(p.sessionId);
      if (s) s.cancelled = true;
      return;
    }
    default:
      if (msg.id !== undefined) fail(-32601, `Method not found: ${msg.method}`);
  }
}

if (!process.argv.includes('--login'))
  createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return;
    void handle(JSON.parse(line));
  })
  .on('close', () => process.exit(0));
