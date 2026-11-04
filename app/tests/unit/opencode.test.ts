import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpenCodeAdapter } from '../../src/main/providers/opencode';
import { openCodeHistory, openCodePart } from '../../src/main/providers/opencode-content';
import { readOpenCodeEvents } from '../../src/main/providers/opencode-server';
import type { ProviderEvent, ProviderSession } from '../../src/main/providers/types';
import { Workspace } from '../../src/main/workspace';
import { workspaceTools } from '../../src/main/main-agent';
import { ipcSchemas } from '../../src/shared/ipc';
import { NewTaskDialog } from '../../src/renderer/components/Dialogs';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), find: vi.fn(), run: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }));
vi.mock('../../src/main/util/exec', async (original) => {
  const actual = await original<typeof import('../../src/main/util/exec')>();
  return { ...actual, findExecutable: mocks.find, run: (cmd: string, args: string[], opts: unknown) => cmd === '/fake/opencode' ? mocks.run(cmd, args, opts) : actual.run(cmd, args, opts as never) };
});

type Call = { path: string; method: string; body: Record<string, unknown>; url: URL; init: RequestInit };
let stream: ReadableStreamDefaultController<Uint8Array>;
let proc: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> };
let calls: Call[];
let events: ProviderEvent[];
let session: ProviderSession | undefined;
let ws: Workspace | undefined;
let failPath = '';
let completeInline = false;
let replyInline = false;
let history: unknown[];
let v2 = false;
let responseOverride: { path: string; body: string; status?: number; contentType?: string } | undefined;
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'amw-opencode-test-')); dirs.push(dir); return dir; };
const emit = (type: string, properties: Record<string, unknown> = {}) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties: { sessionID: 'ses_test', ...properties } })}\r\n\r\n`));
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const request = (id: string, permission = 'bash') => emit('permission.asked', { id, permission, patterns: ['npm test'], metadata: { command: 'npm test' }, tool: { messageID: 'msg_1', callID: 'call_1' } });
const part = (overrides = {}) => ({ id: 'prt_1', sessionID: 'ses_test', messageID: 'msg_1', type: 'text', text: 'Ready', ...overrides });

beforeEach(() => {
  calls = []; events = []; history = []; failPath = ''; completeInline = false; replyInline = false; v2 = false; responseOverride = undefined;
  mocks.find.mockReturnValue('/fake/opencode');
  mocks.run.mockResolvedValue({ code: 0, stdout: '1.2.27\n', stderr: '' });
  mocks.spawn.mockImplementation(() => {
    proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => proc.stdout.write('opencode server listening on http://127.0.0.1:45678\n'));
    return proc;
  });
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    const path = url.pathname;
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : {}, url, init });
    if (path === responseOverride?.path) return new Response(responseOverride.body, { status: responseOverride.status ?? 200, headers: { 'Content-Type': responseOverride.contentType ?? 'text/html' } });
    if (path === failPath) return new Response('error', { status: 500 });
    if (replyInline && /\/permission\/[^/]+\/reply$/.test(path)) {
      const requestID = path.split('/').at(-2);
      if (v2) emitV2('permission.replied', { requestID, reply: 'once' });
      else emit('permission.replied', { requestID, response: 'once' });
      await flush();
      return new Response(null, { status: 204 });
    }
    // OpenCode 2.2.5's embedded server/SDK schemas: /api routes, data envelopes,
    // location[directory], permissions, prompt text, and event.data. Unknown web
    // paths return index.html (including /agent), not a JSON 404.
    if (v2) {
      if (path === '/api/info') return Response.json({ version: '2.2.5', pid: 123, urls: ['http://127.0.0.1:45678'], paths: { tmp: '/tmp' } });
      if (path === '/api/agent') return Response.json({ location: { directory: url.searchParams.get('location[directory]') }, data: [{ id: 'build', name: 'build', permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: 'read', resource: '*.env', effect: 'ask' }, { action: 'read', resource: '*.secret', effect: 'deny' }, { action: 'shell', resource: 'rm *', effect: 'deny' }] }] });
      if (path === '/api/session' || path === '/api/session/ses_test') return Response.json({ data: { id: 'ses_test', permissions: [{ action: '*', resource: '*', effect: 'ask' }] } });
      if (path.includes('/instructions/entries/') || path.endsWith('/reply')) return new Response(null, { status: 204 });
      if (path === '/api/event') return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
      if (path.endsWith('/prompt')) {
        if (completeInline) {
          emitV2('session.execution.started');
          emitV2('session.text.ended', { assistantMessageID: 'msg_1', ordinal: 0, text: 'Completed quickly.' });
          emitV2('session.execution.succeeded');
          await flush();
        }
        return Response.json({ data: { id: 'msg_input', sessionID: 'ses_test', type: 'user', payload: { text: JSON.parse(String(init.body)).text }, delivery: 'steer' } });
      }
      if (path.endsWith('/interrupt')) { emitV2('session.execution.interrupted', { reason: 'user' }); return Response.json({ interrupted: true }); }
      if (path.endsWith('/message')) return Response.json({ data: history, cursor: {} });
      if (path.startsWith('/api/')) return new Response('Unknown API route', { status: 404 });
      return new Response('<!doctype html><html><title>OpenCode</title></html>', { headers: { 'Content-Type': 'text/html' } });
    }
    if (path === '/event') {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (path.endsWith('/abort')) { emit('session.status', { status: { type: 'idle' } }); return Response.json(true); }
    if (path.endsWith('/prompt_async')) {
      if (completeInline) {
        emit('message.updated', { info: { id: 'msg_1', sessionID: 'ses_test', role: 'assistant' } });
        emit('message.part.updated', { part: part({ text: 'Completed quickly.' }) });
        emit('session.status', { status: { type: 'idle' } });
        await flush();
      }
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/message')) return Response.json(history);
    if (path === '/agent') return Response.json([{ name: 'build', permission: [{ permission: 'read', pattern: '*.secret', action: 'deny' }, { permission: 'read', pattern: '*.env', action: 'ask' }, { permission: 'bash', pattern: 'rm *', action: 'deny' }, { permission: 'question', pattern: '*', action: 'deny' }, { permission: 'question', pattern: '*', action: 'allow' }] }]);
    if (path === '/session' || path === '/session/ses_test') return Response.json({ id: 'ses_test', permission: [{ permission: '*', pattern: '*', action: 'ask' }] });
    return Response.json(true);
  }));
});

const emitV2 = (type: string, data: Record<string, unknown> = {}) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'evt_test', type, data: { sessionID: 'ses_test', ...data } })}\n\n`));

describe('OpenCode 2.2.5 first-message regression', () => {
  beforeEach(() => { v2 = true; mocks.run.mockResolvedValue({ code: 0, stdout: 'opencode v2.2.5\n', stderr: '' }); });

  it('delivers send_to_agent to a fresh idle worker using the installed CLI API contract', async () => {
    ws = new Workspace({ dataDir: temp(), adapters: { opencode: new OpenCodeAdapter() } });
    const project = await ws.addProject(temp());
    const task = await ws.createTask({ projectId: project.projectId, provider: 'opencode', title: 'Ethan', isolate: false });
    expect(task.status).toBe('idle');
    expect(task.summary).toBe('Not started yet.');
    completeInline = true;
    const send = workspaceTools(ws).find((tool) => tool.name === 'send_to_agent')!;
    expect(await send.run({ agent: task.alias, message: 'Reply READY without tools.' })).toContain(`Sent to ${task.alias}`);
    expect(calls.find((c) => c.path === '/api/agent')?.url.searchParams.get('location[directory]')).toBe(task.cwd);
    expect(calls.find((c) => c.path === '/api/session')?.body).toMatchObject({ agent: 'build', location: { directory: task.cwd }, permissions: expect.arrayContaining([{ action: '*', resource: '*', effect: 'ask' }]) });
    expect(calls.find((c) => c.path.endsWith('/prompt'))?.body).toMatchObject({ text: 'Reply READY without tools.' });
    expect(calls.some((c) => c.path === '/agent' || c.path.endsWith('/prompt_async'))).toBe(false);
    expect(ws.snapshot().tasks[0].status).toBe('done');
    expect(ws.transcript(task.taskId)).toContainEqual(expect.objectContaining({ role: 'assistant', text: 'Completed quickly.' }));
  });

  it('subscribes before prompting, persists instructions, and overrides the v2 password variable', async () => {
    const s = await start();
    await s.send('Hello');
    const env = mocks.spawn.mock.calls[0][2].env;
    expect(env.OPENCODE_PASSWORD).toBe(env.OPENCODE_SERVER_PASSWORD);
    expect(calls.find((c) => c.path.endsWith('/instructions/entries/agent-workspace'))).toMatchObject({ method: 'PUT', body: { value: 'Use project conventions.' } });
    expect(calls.findIndex((c) => c.path === '/api/event')).toBeLessThan(calls.findIndex((c) => c.path.endsWith('/prompt')));
    expect(calls.find((c) => c.path === '/api/session')?.body.permissions).toContainEqual({ action: 'subagent', resource: '*', effect: 'deny' });
  });

  it('can retry the same never-started workspace agent after an HTML startup failure', async () => {
    ws = new Workspace({ dataDir: temp(), adapters: { opencode: new OpenCodeAdapter() } });
    const project = await ws.addProject(temp());
    const task = await ws.createTask({ projectId: project.projectId, provider: 'opencode', title: 'Ethan', isolate: false });
    const send = workspaceTools(ws).find((tool) => tool.name === 'send_to_agent')!;
    responseOverride = { path: '/api/agent', body: '<!doctype html><title>Wrong route</title>' };
    const failure = await send.run({ agent: task.alias, message: 'Hello' });
    expect(failure).toContain('HTTP 200');
    expect(failure).toContain('/api/agent');
    expect(task.status).toBe('failed');
    responseOverride = undefined;
    completeInline = true;
    expect(await send.run({ agent: task.alias, message: 'Try again' })).toContain(`Sent to ${task.alias}`);
    expect(task.status).toBe('done');
  });

  it('streams v2 text, reasoning, shell output and edit patches, filtering other sessions', async () => {
    const s = await start(); await s.send('Go');
    emitV2('session.execution.started');
    emitV2('session.text.started', { assistantMessageID: 'msg_1', ordinal: 0 });
    emitV2('session.text.delta', { assistantMessageID: 'msg_1', ordinal: 0, delta: 'Re' });
    emitV2('session.text.delta', { assistantMessageID: 'msg_1', ordinal: 0, delta: 'ady' });
    emitV2('session.text.ended', { assistantMessageID: 'msg_1', ordinal: 0, text: 'Ready' });
    emitV2('session.reasoning.ended', { assistantMessageID: 'msg_1', ordinal: 1, text: 'Thought' });
    const tool = { assistantMessageID: 'msg_1', id: 'call_1' };
    emitV2('session.tool.input.started', { ...tool, name: 'shell' });
    emitV2('session.tool.called', { ...tool, input: { command: 'npm test' } });
    emitV2('session.tool.success', { ...tool, content: [{ type: 'text', text: 'passed' }], metadata: { exit: 0 } });
    const edit = { assistantMessageID: 'msg_1', id: 'edit' };
    emitV2('session.tool.input.started', { ...edit, name: 'edit' });
    emitV2('session.tool.called', { ...edit, input: { path: '/repo/a.ts' } });
    emitV2('permission.asked', { id: 'edit', action: 'edit', resources: ['a.ts'], source: { type: 'tool', messageID: 'msg_1', id: 'edit' }, metadata: { files: [{ file: 'a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }] } });
    await flush();
    emitV2('session.tool.success', { ...edit, content: [{ type: 'text', text: 'Edited' }] });
    emitV2('session.text.ended', { sessionID: 'ses_other', assistantMessageID: 'foreign', ordinal: 0, text: 'foreign output' });
    emitV2('session.execution.succeeded'); await flush();
    expect(events).toContainEqual(expect.objectContaining({ role: 'assistant', text: 'Ready' }));
    expect(events).toContainEqual(expect.objectContaining({ role: 'thought', text: 'Thought' }));
    expect(events).toContainEqual(expect.objectContaining({ tool: expect.objectContaining({ kind: 'execute', content: [expect.objectContaining({ command: 'npm test', output: 'passed', exitCode: 0 })] }) }));
    expect(events).toContainEqual(expect.objectContaining({ toolStatus: 'completed', tool: expect.objectContaining({ content: [expect.objectContaining({ type: 'diff', diff: expect.objectContaining({ phase: 'applied', added: 1, removed: 1 }) })] }) }));
    expect(JSON.stringify(events)).not.toContain('foreign output');
    expect(events.filter((event) => event.type === 'turnCompleted')).toEqual([{ type: 'turnCompleted', status: 'completed', finalText: 'Ready', error: undefined }]);
  });

  it('relays v2 permissions and typed forms through workspace attention', async () => {
    ws = new Workspace({ dataDir: temp(), adapters: { opencode: new OpenCodeAdapter() } });
    ws.updateSettings({ permissionMode: 'edits' });
    const project = await ws.addProject(temp());
    const task = await ws.createTask({ projectId: project.projectId, provider: 'opencode', title: 'Approval', isolate: false, instruction: 'Go' });
    emitV2('permission.asked', { id: 'per_shell', action: 'shell', resources: ['npm test'], source: { type: 'tool', messageID: 'msg_1', id: 'call_1' } });
    await flush();
    expect(task.status).toBe('waiting_for_user');
    await ws.respondAttention(ws.snapshot().attention.find((a) => a.providerRequestId === 'per_shell')!.id, 'reject');
    expect(calls.at(-1)).toMatchObject({ path: '/api/session/ses_test/permission/per_shell/reply', body: { decision: 'reject' } });
    expect(task.status).toBe('running');
    emitV2('form.created', { form: { id: 'frm_1', sessionID: 'ses_test', title: 'Choose', fields: [
      { key: 'color', type: 'string', title: 'Color?', options: [{ value: 'blue', label: 'Blue' }], custom: false },
      { key: 'many', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { key: 'count', type: 'integer' }, { key: 'confirm', type: 'boolean' },
    ] } });
    await flush();
    expect(task.status).toBe('waiting_for_user');
    await ws.respondAttention(ws.snapshot().attention.find((a) => a.providerRequestId === 'frm_1')!.id, undefined, { color: 'Blue', many: 'A, B', count: '2', confirm: 'Yes' });
    expect(calls.at(-1)).toMatchObject({ path: '/api/session/ses_test/form/frm_1/reply', body: { answer: { color: 'blue', many: ['a', 'b'], count: 2, confirm: true } } });
    expect(task.status).toBe('running');
  });

  it('preserves sensitive-read asks and fails closed when a subagent denial cannot be sent', async () => {
    const s = await start(); await s.send('Go');
    emitV2('permission.asked', { id: 'per_env', action: 'read', resources: ['/repo/.env'] }); await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'approvalRequested', requestId: 'per_env' }));
    failPath = '/api/session/ses_test/permission/per_child/reply';
    emitV2('permission.asked', { id: 'per_child', action: 'subagent', resources: ['build'] }); await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'sessionFailed' }));
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('steers, interrupts, resumes history and sends another turn through v2 routes', async () => {
    const s = await start(); await s.send('First');
    expect(await s.send('Second')).toBe('steer');
    expect(calls.some((c) => c.path.endsWith('/interrupt'))).toBe(false);
    expect(await s.send('Third', { interrupt: true })).toBe('interrupt');
    expect(events).toContainEqual(expect.objectContaining({ type: 'turnCompleted', status: 'interrupted' }));
    emitV2('session.execution.failed', { error: { type: 'auth', message: 'Configure a model' } }); await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'turnCompleted', status: 'failed', error: 'Configure a model' }));
    await s.close(); calls = []; events = [];
    history = [{ id: 'msg_old', type: 'user', text: 'Remember 42' }, { id: 'msg_reply', type: 'assistant', content: [{ type: 'text', text: 'Remembered' }] }];
    const resumed = await start({ resumeNativeSessionId: 'ses_test' });
    expect(calls.some((c) => c.path === '/api/session' && c.method === 'POST')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'transcriptItem', role: 'user', text: 'Remember 42', history: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'transcriptItem', role: 'assistant', text: 'Remembered', history: true }));
    expect(await resumed.send('Again')).toBe('turn');
    stream.close(); await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'sessionDisconnected' }));
  });

  it.each([
    ['/api/info', 200, 'text/html', '<!doctype html><title>Wrong server</title>', 'expected JSON'],
    ['/api/agent', 200, 'application/json', '<!doctype html>bad proxy body', 'invalid JSON'],
    ['/api/agent', 502, 'text/html', '<html>Bad gateway</html>', 'request failed'],
    ['/api/event', 200, 'text/html', '<!doctype html><title>OpenCode</title>', 'expected an SSE event stream'],
  ])('reports the URL, HTTP status and body when %s returns an unexpected response', async (path, status, contentType, body, reason) => {
    responseOverride = { path, status, contentType, body: body + 'x'.repeat(5000) };
    const error = await start().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`http://127.0.0.1:45678${path}`);
    expect(message).toContain(`HTTP ${status}`);
    expect(message).toContain(`Content-Type: ${contentType}`);
    expect(message).toContain(reason);
    expect(message).toContain(body);
    expect(message.length).toBeLessThan(850);
    expect(message).not.toContain('Unexpected token');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

afterEach(async () => {
  await ws?.shutdown(); ws = undefined;
  await session?.close(); session = undefined;
  vi.unstubAllGlobals(); vi.clearAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(extra = {}) {
  session = new OpenCodeAdapter().createSession({ cwd: '/repo', title: 'Test', developerInstructions: 'Use project conventions.', permissionMode: 'edits', ...extra }, (event) => events.push(event));
  await session.start();
  return session;
}

describe.each([1, 2])('OpenCode %i native auto mode', (version) => {
  beforeEach(() => {
    v2 = version === 2;
    mocks.run.mockResolvedValue({ code: 0, stdout: v2 ? 'opencode v2.2.5\n' : '1.2.27\n', stderr: '' });
  });
  const shell = () => v2 ? 'shell' : 'bash';
  const permission = (id: string, action = shell(), resource = 'npm test') => v2
    ? emitV2('permission.asked', { id, action, resources: [resource] })
    : emit('permission.asked', { id, permission: action, patterns: [resource] });
  const replyPath = (id: string) => v2 ? `/api/session/ses_test/permission/${id}/reply` : `/permission/${id}/reply`;
  const decision = (id: string) => {
    const body = calls.find((c) => c.path === replyPath(id))?.body;
    return body?.[v2 ? 'decision' : 'reply'];
  };
  const question = () => v2
    ? emitV2('form.created', { form: { id: 'question', sessionID: 'ses_test', title: 'Name?', fields: [{ key: 'name', type: 'string', title: 'Name?' }] } })
    : emit('question.asked', { id: 'question', questions: [{ question: 'Name?', options: [] }] });

  it('automatically approves non-denied requests, including configured asks, without saving allowances', async () => {
    const s = await start({ permissionMode: undefined }); await s.send('Go');
    permission('command'); permission('command');
    permission('outside', 'external_directory', '/tmp/*');
    permission('sensitive', 'read', '/repo/.env');
    await flush();
    for (const id of ['command', 'outside', 'sensitive']) expect(decision(id)).toBe('once');
    expect(calls.filter((c) => c.path === replyPath('command'))).toHaveLength(1);
    expect(events.some((event) => event.type === 'approvalRequested')).toBe(false);
    expect(calls.some((c) => c.body.reply === 'always' || c.body.decision === 'always')).toBe(false);
  });

  it('retains deny rules and never automatically answers questions', async () => {
    const s = await start({ permissionMode: 'auto' }); await s.send('Go');
    permission('secret', 'read', '/repo/key.secret');
    permission('denied-command', shell(), 'rm -rf build');
    permission('child', v2 ? 'subagent' : 'task');
    question(); await flush();
    for (const id of ['secret', 'denied-command', 'child']) expect(decision(id)).toBe('reject');
    expect(events).toContainEqual(expect.objectContaining({ type: 'userInputRequested', requestId: 'question' }));
    expect(calls.some((c) => c.path.includes('/question/reply'))).toBe(false);
    await s.setPermissionMode!('auto');
    expect(events.some((e) => e.type === 'requestResolved' && e.requestId === 'question')).toBe(false);
  });

  it('switches a waiting workspace agent to auto immediately and restores prompts when switched back', async () => {
    ws = new Workspace({ dataDir: temp(), adapters: { opencode: new OpenCodeAdapter() } });
    ws.updateSettings({ permissionMode: 'ask' });
    const project = await ws.addProject(temp());
    const task = await ws.createTask({ projectId: project.projectId, provider: 'opencode', title: 'Auto switch', isolate: false, instruction: 'Go' });
    permission('pending'); await flush();
    expect(task.status).toBe('waiting_for_user');
    expect(decision('pending')).toBeUndefined();
    replyInline = true; // Native reply event can precede the HTTP acknowledgement.
    await ws.setPermissionMode(task.taskId, 'auto');
    expect(decision('pending')).toBe('once');
    expect(task.status).toBe('running');
    expect(ws.snapshot().attention.find((a) => a.providerRequestId === 'pending')?.state).toBe('resolved');
    await ws.setPermissionMode(task.taskId, 'edits');
    permission('ask-command'); permission('edit', 'edit', 'a.ts'); await flush();
    expect(decision('ask-command')).toBeUndefined();
    expect(decision('edit')).toBe('once');
    await ws.setPermissionMode(task.taskId, 'ask');
    permission('ask-edit', 'edit', 'a.ts'); await flush();
    expect(decision('ask-edit')).toBeUndefined();
    expect(task.status).toBe('waiting_for_user');
  });

  it('keeps a failed automatic reply available for the user and retries it only when requested', async () => {
    const s = await start({ permissionMode: 'auto' }); await s.send('Go');
    failPath = replyPath('failed'); permission('failed'); await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'approvalRequested', requestId: 'failed' }));
    expect(events.some((e) => e.type === 'requestResolved' && e.requestId === 'failed')).toBe(false);
    failPath = '';
    await s.setPermissionMode!('auto');
    expect(events).toContainEqual({ type: 'requestResolved', requestId: 'failed', reason: 'once', answered: true });
  });
});

describe('OpenCode provider contract', () => {
  it('renders OpenCode in the picker and disables it when the CLI is unavailable', async () => {
    ws = new Workspace({ dataDir: temp(), adapters: { opencode: new OpenCodeAdapter() } });
    mocks.find.mockReturnValue(null);
    await ws.refreshCapabilities();
    const render = () => renderToStaticMarkup(createElement(NewTaskDialog, { snapshot: ws!.snapshot(), onClose() {}, onCreated() {} }));
    const unavailable = render().match(/<label[^>]*>[^<]*<input[^>]*name="provider"[\s\S]*?<\/label>/g)?.find((label) => label.includes('OpenCode'));
    expect(unavailable).toContain('disabled=""');
    mocks.find.mockReturnValue('/fake/opencode');
    await ws.refreshCapabilities();
    const available = render().match(/<label[^>]*>[^<]*<input[^>]*name="provider"[\s\S]*?<\/label>/g)?.find((label) => label.includes('OpenCode'));
    expect(available).toContain('OpenCode');
    expect(available).not.toContain('disabled=""');
  });

  it('detects a missing or broken executable without starting a process', async () => {
    mocks.find.mockReturnValue(null);
    expect(await new OpenCodeAdapter().capabilities()).toMatchObject({ available: false, createSession: false, detail: expect.stringContaining('not found') });
    await expect(start()).rejects.toThrow(/not found/);
    expect(mocks.spawn).not.toHaveBeenCalled();
    mocks.find.mockReturnValue('/fake/opencode');
    mocks.run.mockResolvedValue({ code: 1, stdout: '', stderr: 'private diagnostic' });
    const cap = await new OpenCodeAdapter().capabilities();
    expect(cap.available).toBe(false);
    expect(JSON.stringify(cap)).not.toContain('private diagnostic');
  });

  it('owns an authenticated loopback server, subscribes before prompts and injects instructions', async () => {
    const s = await start();
    expect(mocks.spawn.mock.calls[0][1]).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0']);
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ cwd: '/repo', env: { OPENCODE_SERVER_PASSWORD: expect.any(String), OPENCODE_ENABLE_QUESTION_TOOL: 'true' } });
    expect(calls.find((c) => c.path === '/session')?.body).toMatchObject({ title: 'Test', permission: expect.arrayContaining([{ permission: '*', pattern: '*', action: 'ask' }, { permission: 'read', pattern: '*.secret', action: 'deny' }]) });
    expect((calls.find((c) => c.path === '/session')?.body.permission as Array<{ permission: string; action: string }>).filter((r) => r.permission === 'question').at(-1)?.action).toBe('ask');
    expect(calls.find((c) => c.path === '/session')?.body.permission).toContainEqual({ permission: 'task', pattern: '*', action: 'deny' });
    expect(await s.send('Do the task.')).toBe('turn');
    expect(calls.at(-1)).toMatchObject({ path: '/session/ses_test/prompt_async', body: { agent: 'build', system: 'Use project conventions.', parts: [{ type: 'text', text: 'Do the task.' }] } });
    expect(calls.findIndex((c) => c.path === '/event')).toBeLessThan(calls.findIndex((c) => c.path.endsWith('/prompt_async')));
    expect(calls.every((c) => c.url.searchParams.get('directory') === '/repo' && String((c.init.headers as Record<string, string>).Authorization).startsWith('Basic '))).toBe(true);
    expect(events).toContainEqual({ type: 'sessionStarted', nativeSessionId: 'ses_test', resumed: false });
  });

  it('upserts streamed text, thoughts, tools and diffs, ignores other sessions and completes once', async () => {
    const s = await start(); await s.send('Go');
    emit('message.updated', { info: { id: 'msg_1', sessionID: 'ses_test', role: 'assistant' } });
    emit('message.part.updated', { part: part({ text: 'Re' }) });
    emit('message.part.delta', { messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'ady' });
    emit('message.part.updated', { part: part({ id: 'thought', type: 'reasoning', text: 'Considering' }) });
    emit('message.part.updated', { part: part({ id: 'tool', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'npm test' }, output: 'passed', metadata: { exit: 0 } } }) });
    emit('message.part.updated', { part: part({ sessionID: 'ses_child', text: 'foreign output' }) });
    emit('session.diff', { diff: [{ file: '/repo/a.ts', before: 'old', after: 'new' }] });
    emit('todo.updated', { todos: [{ content: 'Implement', status: 'completed' }] });
    emit('session.status', { sessionID: 'ses_other', status: { type: 'idle' } });
    emit('session.status', { status: { type: 'idle' } }); emit('session.idle'); await flush();
    expect(events.filter((e) => e.type === 'turnCompleted')).toEqual([{ type: 'turnCompleted', status: 'completed', finalText: 'Ready', error: undefined }]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'transcriptItem', itemId: 'oc-prt_1', text: 'Ready' }));
    expect(events).toContainEqual(expect.objectContaining({ role: 'thought', text: 'Considering' }));
    expect(events).toContainEqual(expect.objectContaining({ tool: expect.objectContaining({ kind: 'execute', content: [expect.objectContaining({ command: 'npm test', output: 'passed', exitCode: 0 })] }) }));
    expect(events).toContainEqual(expect.objectContaining({ tool: expect.objectContaining({ name: 'session.diff', content: [expect.objectContaining({ type: 'diff' })] }) }));
    expect(JSON.stringify(events)).not.toContain('foreign output');
    expect(await s.send('Follow up')).toBe('turn');
  });

  it('relays approval/denial and structured multi-question answers; only resolves successful replies', async () => {
    const s = await start(); await s.send('Go');
    request('perm'); request('perm'); await flush();
    expect(events.filter((e) => e.type === 'approvalRequested')).toHaveLength(1);
    expect(events.find((e) => e.type === 'approvalRequested')).toMatchObject({ toolCallId: 'oc-tool-msg_1-call_1', options: [{ id: 'once' }, { id: 'reject' }], preview: [{ type: 'terminal', command: 'npm test' }] });
    await expect(s.respond('perm', { decision: 'always' })).rejects.toThrow(/decision/);
    failPath = '/permission/perm/reply';
    await expect(s.respond('perm', { decision: 'once' })).rejects.toThrow(/HTTP 500/);
    failPath = '';
    await s.respond('perm', { decision: 'reject' });
    expect(calls.at(-1)).toMatchObject({ path: '/permission/perm/reply', body: { reply: 'reject' } });
    await expect(s.respond('perm', { decision: 'once' })).rejects.toThrow(/no longer pending/);
    emit('question.asked', { id: 'q1', questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiple: true }, { question: 'Why?', options: [] }] });
    await flush();
    expect(events.find((e) => e.type === 'userInputRequested')).toMatchObject({ requestId: 'q1', questions: [{ id: '0', multiSelect: true }, { id: '1', allowOther: true }] });
    await expect(s.respond('q1', { answers: { '0': 'A' } })).rejects.toThrow(/every/);
    await s.respond('q1', { answers: { '0': 'A, B', '1': 'A custom answer, with commas' } });
    expect(calls.at(-1)).toMatchObject({ path: '/question/q1/reply', body: { answers: [['A', 'B'], ['A custom answer, with commas']] } });
  });

  it('carries a write permission patch into the completed tool when OpenCode omits it from the result', async () => {
    const s = await start(); await s.send('Edit');
    emit('message.updated', { info: { id: 'msg_1', sessionID: 'ses_test', role: 'assistant' } });
    emit('permission.asked', { id: 'write', permission: 'edit', patterns: ['a.ts'], metadata: { filepath: '/repo/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' }, tool: { messageID: 'msg_1', callID: 'write' } });
    emit('message.part.updated', { part: part({ type: 'tool', tool: 'write', callID: 'write', state: { status: 'completed', input: { filePath: '/repo/a.ts', content: 'new' }, metadata: { exists: true, filepath: '/repo/a.ts' }, output: 'Wrote file successfully.' } }) });
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'transcriptItem', tool: expect.objectContaining({ content: [expect.objectContaining({ type: 'diff', diff: expect.objectContaining({ phase: 'applied', added: 1, removed: 1 }) })] }) }));
  });

  it('keeps command and external-directory approval in edits and ask modes', async () => {
    const s = await start(); await s.send('Go');
    request('edit1', 'edit'); await flush();
    expect(calls.at(-1)).toMatchObject({ path: '/permission/edit1/reply', body: { reply: 'once' } });
    await s.setPermissionMode!('ask'); request('edit2', 'edit'); request('outside', 'external_directory'); request('shell', 'bash'); await flush();
    expect(events.filter((e) => e.type === 'approvalRequested').map((e) => e.requestId)).toEqual(['edit2', 'outside', 'shell']);
  });

  it('preserves configured asks for sensitive reads instead of auto-approving them as ordinary reads', async () => {
    const s = await start(); await s.send('Go');
    emit('permission.asked', { id: 'env', permission: 'read', patterns: ['/repo/.env'], metadata: {} });
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'approvalRequested', requestId: 'env' }));
    expect(calls.some((c) => c.path === '/permission/env/reply')).toBe(false);
  });

  it('fails closed if the server cannot reject a prohibited native subagent request', async () => {
    const s = await start(); await s.send('Go');
    failPath = '/permission/child/reply';
    request('child', 'task'); await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'sessionFailed' }));
    expect(events.some((e) => e.type === 'approvalRequested' && e.requestId === 'child')).toBe(false);
  });

  it('interrupts before another message, withdraws pending requests, and can run again', async () => {
    const s = await start(); await s.send('First'); request('perm'); await flush();
    expect(await s.send('Second', { interrupt: true })).toBe('interrupt');
    expect(calls.filter((c) => c.path.endsWith('/abort') || c.path.endsWith('/prompt_async')).map((c) => c.path)).toEqual(['/session/ses_test/prompt_async', '/session/ses_test/abort', '/session/ses_test/prompt_async']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'turnCompleted', status: 'interrupted' }));
    await expect(s.respond('perm', { decision: 'once' })).rejects.toThrow(/no longer pending/);
    // OpenCode also emits the legacy idle event; a late copy from the aborted
    // turn must not complete the new prompt before it has begun processing.
    emit('session.idle'); await flush();
    expect(events.filter((e) => e.type === 'turnCompleted')).toHaveLength(1);
    await s.interrupt();
    expect(await s.send('Third')).toBe('turn');
    await s.close();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(s.send('Fourth')).rejects.toThrow(/not connected/);
  });

  it('resumes persisted context and replays native history without creating a second session', async () => {
    history = [{ info: { role: 'user' }, parts: [part({ id: 'user', text: 'Remember 42' })] }, { info: { role: 'assistant' }, parts: [part()] }];
    await start({ resumeNativeSessionId: 'ses_test' });
    expect(calls.some((c) => c.path === '/session' && c.method === 'POST')).toBe(false);
    expect(events).toContainEqual({ type: 'sessionStarted', nativeSessionId: 'ses_test', resumed: true });
    expect(events.filter((e) => e.type === 'transcriptItem')).toMatchObject([{ history: true, role: 'user', text: 'Remember 42' }, { history: true, role: 'assistant', text: 'Ready' }]);
  });

  it('surfaces model errors and event/process failures, cleaning up pending requests', async () => {
    const s = await start(); await s.send('Go');
    emit('session.error', { error: { name: 'ProviderAuthError', data: { message: 'Configure a model' } } });
    emit('session.idle'); await flush();
    expect(events.filter((e) => e.type === 'turnCompleted')).toMatchObject([{ status: 'failed', error: 'Configure a model' }]);
    await s.send('Try again'); request('perm'); await flush();
    stream.close(); await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'sessionDisconnected' }));
    expect(events).toContainEqual({ type: 'requestResolved', requestId: 'perm', reason: 'disconnected' });
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kills the server if setup fails', async () => {
    failPath = '/agent';
    await expect(start()).rejects.toThrow(/HTTP 500/);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('OpenCode content and transport', () => {
  it('decodes split UTF-8 and CRLF SSE frames, comments and multiline data', async () => {
    const wire = new TextEncoder().encode(': heartbeat\r\ndata: {"type":"text",\r\ndata: "text":"你好"}\r\n\r\ndata: {"type":"done"}\n\n');
    const received: unknown[] = [];
    await readOpenCodeEvents(new ReadableStream({ start(controller) { for (const byte of wire) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), (e) => received.push(e));
    expect(received).toEqual([{ type: 'text', text: '你好' }, { type: 'done' }]);
  });

  it('maps applied edit patches and leaves failed proposals unapplied', () => {
    const value = part({ type: 'tool', callID: 'edit', tool: 'edit', state: { status: 'completed', input: { filePath: '/repo/a.ts' }, metadata: { diff: '@@ -1 +1 @@\n-old\n+new' } } });
    expect(openCodePart(value, 'assistant', '/repo')).toMatchObject({ toolStatus: 'completed', tool: { content: [{ type: 'diff', diff: { path: 'a.ts', phase: 'applied', added: 1, removed: 1, hunks: [{ oldStart: 1, newStart: 1 }] } }] } });
    const failed = part({ type: 'tool', callID: 'write', tool: 'write', state: { status: 'error', input: { filePath: '/repo/a.ts', content: 'new' }, error: 'denied' } });
    expect(openCodePart(failed, 'assistant', '/repo')).toMatchObject({ toolStatus: 'failed', tool: { content: [{ type: 'diff', diff: { phase: 'proposed' } }, { type: 'text', text: 'denied' }] } });
    expect(openCodePart(part(), 'user', '/repo')).toBeUndefined();
    expect(openCodeHistory([{ info: { role: 'assistant' }, parts: [part({ type: 'tool', callID: 'c', tool: 'bash', state: { status: 'running' } })] }], '/repo')).toMatchObject([{ toolStatus: 'interrupted', history: true }]);
  });
});

it('keeps a fast completed turn done when SSE finishes before the prompt HTTP acknowledgement', async () => {
  ws = new Workspace({ dataDir: temp(), adapters: { opencode: new OpenCodeAdapter() } });
  const project = await ws.addProject(temp());
  completeInline = true;
  const task = await ws.createTask({ projectId: project.projectId, provider: 'opencode', title: 'Fast', instruction: 'Reply.', isolate: false });
  expect(task.status).toBe('done');
  expect(task.summary).toBe('Completed quickly.');
  expect(ws.snapshot().attention).toContainEqual(expect.objectContaining({ taskId: task.taskId, kind: 'completion', state: 'open' }));
});

it('creates an isolated OpenCode worker through main-agent tooling and drives workspace status/attention', async () => {
  const root = temp();
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'], { cwd: root });
  ws = new Workspace({ dataDir: temp(), adapters: { opencode: new OpenCodeAdapter() } });
  await ws.refreshCapabilities();
  ws.updateSettings({ permissionMode: 'edits' });
  await ws.addProject(root, 'fixture');
  const tool = workspaceTools(ws).find((t) => t.name === 'create_agent')!;
  const args = { project: 'fixture', title: 'Implement', instruction: 'Do the work.', provider: 'opencode' };
  expect(tool.schema.safeParse(args).success).toBe(true);
  expect(ipcSchemas['task:create'].safeParse({ projectId: 'p', provider: 'opencode', title: 'Test', isolate: true }).success).toBe(true);
  expect(await tool.run(args)).toContain('(opencode)');
  const task = ws.snapshot().tasks[0];
  expect(task.cwd).not.toBe(root); expect(task.worktree?.branch).toMatch(/^amw\//);
  expect(existsSync(join(task.cwd, 'README.md'))).toBe(true);
  const status = () => ws!.snapshot().tasks[0].status;
  expect(status()).toBe('running');
  request('perm'); await flush(); expect(status()).toBe('waiting_for_user');
  const approval = ws.snapshot().attention.find((a) => a.providerRequestId === 'perm')!;
  await ws.respondAttention(approval.id, 'reject'); expect(status()).toBe('running');
  emit('question.asked', { id: 'question', questions: [{ question: 'Which name?', options: [] }] }); await flush();
  expect(status()).toBe('waiting_for_user');
  await ws.respondAttention(ws.snapshot().attention.find((a) => a.providerRequestId === 'question')!.id, undefined, { '0': 'Example' });
  emit('message.updated', { info: { id: 'msg_1', sessionID: 'ses_test', role: 'assistant' } });
  emit('message.part.updated', { part: part({ text: 'Implemented.' }) }); emit('session.idle'); await flush();
  expect(status()).toBe('done');
  expect(ws.transcript(task.taskId)).toContainEqual(expect.objectContaining({ role: 'assistant', text: 'Implemented.' }));
  await ws.send(task.taskId, 'Continue', 'text');
  expect((await ws.send(task.taskId, 'Change direction', 'text')).delivery).toBe('interrupt');
  expect(ws.transcript(task.taskId).find((i) => i.text === 'Change direction')?.delivery).toBe('interrupt');
  await ws.interrupt(task.taskId); expect(status()).toBe('idle');
  await ws.stop(task.taskId); expect(status()).toBe('disconnected');
  expect((await ws.send(task.taskId, 'Resume', 'text')).ok).toBe(true);
  expect(ws.snapshot().sessions.at(-1)).toMatchObject({ provider: 'opencode', nativeSessionId: 'ses_test', integrationMode: 'resumed' });
});
