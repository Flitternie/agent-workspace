// The ACP adapter against a fake ACP agent (tests/fixtures/fake-acp-agent.mjs): streamed replies,
// tool calls with diffs, permission requests and the permission modes, cancel, steering, errors,
// session/load replaying history, model choice; and on a "host" (a local shell standing in for SSH)
// through the detached transport, including a connection dropped mid-turn.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACP_AGENTS, acpAgent } from '../../src/shared/acp-agents';
import { lineDiffHunks } from '../../src/shared/content';
import { AcpAdapter, type AcpAdapterOptions } from '../../src/main/providers/acp';
import type { ProviderEvent, ProviderSession, StartArgs } from '../../src/main/providers/types';
import type { RemoteRunner } from '../../src/main/util/detached';

const FAKE = join(__dirname, '../fixtures/fake-acp-agent.mjs');
const spec = acpAgent('opencode')!;
let dir: string;
let logFile: string;
const sessions: ProviderSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amw-acp-'));
  logFile = join(dir, 'log.jsonl');
  process.env.FAKE_ACP_DIR = join(dir, 'store');
  process.env.FAKE_ACP_LOG = logFile;
  delete process.env.FAKE_ACP_MODES;
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}
/** Messages the fake agent received. */
const received = (): Array<{ method?: string; params?: Record<string, unknown> }> =>
  existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

function open(args: Partial<StartArgs> = {}, opts: AcpAdapterOptions = {}) {
  const adapter = new AcpAdapter(spec, { command: ['node', FAKE], ...opts });
  const events: ProviderEvent[] = [];
  const cwd = args.cwd ?? mkdtempSync(join(tmpdir(), 'amw-acp-work-'));
  const session = adapter.createSession({ cwd, title: 't', permissionMode: 'ask', ...args }, (e) => events.push(e));
  sessions.push(session);
  const of = <T extends ProviderEvent['type']>(type: T) => events.filter((e): e is Extract<ProviderEvent, { type: T }> => e.type === type);
  const turns = () => of('turnCompleted');
  const turnDone = (n: number) => until(() => turns().length >= n, 8000, `turn ${n}`);
  return { adapter, session, events, of, turns, turnDone, cwd };
}

describe('ACP adapter (local)', () => {
  it('starts a session and streams a reply, with usage and the model', async () => {
    const { adapter, session, of, turnDone } = open();
    await session.start();
    const started = of('sessionStarted')[0];
    expect(started.resumed).toBe(false);
    expect(session.nativeSessionId()).toBe(started.nativeSessionId);
    expect(of('model')[0].model).toBe('fake-small');
    expect((await adapter.listModels()).map((m) => [m.id, m.isDefault])).toEqual([
      ['fake-small', true],
      ['fake-large', false],
    ]);
    // No file system or terminal offered: the agent uses its own tools.
    const init = received().find((m) => m.method === 'initialize')!;
    expect(init.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });

    expect(await session.send('hello there')).toBe('turn');
    await turnDone(1);
    const deltas = of('outputDelta').filter((e) => e.role === 'assistant');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.delta).join('')).toBe('Echo: hello there');
    const final = of('transcriptItem').find((e) => e.role === 'assistant')!;
    expect(final).toMatchObject({ text: 'Echo: hello there', itemId: deltas[0].itemId });
    expect(of('transcriptItem').find((e) => e.role === 'thought')?.text).toMatch(/^Thinking about/);
    expect(of('turnCompleted')[0]).toMatchObject({ status: 'completed', finalText: 'Echo: hello there' });
    expect(of('usage').find((u) => u.context)).toMatchObject({ context: 1200, contextWindow: 200000 });
    expect(of('usage').find((u) => u.add?.input)).toMatchObject({ add: { input: 100, output: 20 } });
  });

  it('asks permission for an edit, shows its diff, and applies the choice', async () => {
    const { session, of, turnDone, cwd } = open({ permissionMode: 'ask' });
    await session.start();
    await session.send('make a tool call');
    await until(() => of('approvalRequested').length > 0);
    const req = of('approvalRequested')[0];
    expect(req.headline).toBe('Apply changes to src/app.ts');
    expect(req.options.map((o) => [o.id, o.kind])).toEqual([
      ['once', 'allow_once'],
      ['always', 'allow_always'],
      ['reject', 'reject_once'],
    ]);
    expect(req.toolCallId).toMatch(/^edit-/);
    const diff = req.preview!.find((c) => c.type === 'diff');
    expect(diff && diff.type === 'diff' && diff.diff).toMatchObject({ path: 'src/app.ts', operation: 'modify', phase: 'proposed', added: 1, removed: 1 });
    // The tool row exists before the approval, under the same id.
    const tool = of('transcriptItem').find((e) => e.itemId === req.toolCallId)!;
    expect(tool).toMatchObject({ role: 'tool', toolStatus: 'running', tool: { kind: 'edit', title: 'Edit src/app.ts', locations: [{ path: 'src/app.ts', line: 2 }] } });
    await session.respond(req.requestId, { decision: 'once' });
    await turnDone(1);
    const last = of('transcriptItem').filter((e) => e.itemId === req.toolCallId).at(-1)!;
    expect(last.toolStatus).toBe('completed');
    expect(last.tool?.content?.[0]).toMatchObject({ type: 'diff', diff: { phase: 'applied' } });
    expect(of('requestResolved').map((r) => r.requestId)).toContain(req.requestId);
    expect(of('turnCompleted')[0].finalText).toBe('Edited src/app.ts.');
    expect(received().find((m) => m.method === undefined && JSON.stringify(m).includes('"optionId":"once"'))).toBeTruthy();
    void cwd;
  });

  it('a refused edit shows as declined', async () => {
    const { session, of, turnDone } = open();
    await session.start();
    await session.send('tool please');
    await until(() => of('approvalRequested').length > 0);
    const req = of('approvalRequested')[0];
    await session.respond(req.requestId, { decision: 'reject' });
    await turnDone(1);
    expect(of('transcriptItem').filter((e) => e.itemId === req.toolCallId).at(-1)!.toolStatus).toBe('declined');
    expect(of('turnCompleted')[0].finalText).toBe('Okay, I left it alone.');
  });

  it('decides by itself what the permission mode allows: reads always, workspace edits unless ask, commands never', async () => {
    const edits = open({ permissionMode: 'edits' });
    await edits.session.start();
    await edits.session.send('tool');
    await edits.turnDone(1);
    expect(edits.of('approvalRequested')).toEqual([]);
    expect(edits.of('turnCompleted')[0].finalText).toBe('Edited src/app.ts.');

    const ask = open({ permissionMode: 'ask' });
    await ask.session.start();
    await ask.session.send('read it');
    await ask.turnDone(1);
    expect(ask.of('approvalRequested')).toEqual([]);
    expect(ask.of('turnCompleted')[0].finalText).toBe('Read it (once).');

    const auto = open({ permissionMode: 'auto' });
    await auto.session.start();
    await auto.session.send('run the tests');
    await until(() => auto.of('approvalRequested').length > 0);
    const req = auto.of('approvalRequested')[0];
    expect(req.headline).toBe('Run command: npm test');
    expect(req.preview?.[0]).toMatchObject({ type: 'terminal', command: 'npm test' });
    await auto.session.respond(req.requestId, { decision: 'once' });
    await auto.turnDone(1);
    const ran = auto.of('transcriptItem').filter((e) => e.itemId === req.toolCallId).at(-1)!;
    expect(ran.tool?.content?.[0]).toMatchObject({ type: 'terminal', command: 'npm test', output: '3 passing', exitCode: 0 });
  });

  it("uses the agent's own permission modes when it has them, and leaves every request to them", async () => {
    process.env.FAKE_ACP_MODES = '1';
    const { session, of, turnDone } = open({ permissionMode: 'edits' });
    await session.start();
    expect(received().filter((m) => m.method === 'session/set_mode').map((m) => m.params?.modeId)).toEqual(['accept-edits']);
    await session.setPermissionMode!('ask');
    await session.setPermissionMode!('auto');
    expect(received().filter((m) => m.method === 'session/set_mode').map((m) => m.params?.modeId)).toEqual(['accept-edits', 'default', 'auto']);
    // It asked even though the edit is in the workspace: its own mode decided that.
    await session.send('read it');
    await until(() => of('approvalRequested').length > 0);
    await session.respond(of('approvalRequested')[0].requestId, { decision: 'once' });
    await turnDone(1);
  });

  it('stops a turn: cancel withdraws the open request and the turn ends interrupted', async () => {
    const { session, of, turnDone } = open();
    await session.start();
    await session.send('slow');
    await until(() => of('outputDelta').some((d) => d.delta.startsWith('tick2')));
    await session.interrupt();
    await turnDone(1);
    expect(of('turnCompleted')[0].status).toBe('interrupted');
    expect(received().some((m) => m.method === 'session/cancel')).toBe(true);

    await session.send('tool');
    await until(() => of('approvalRequested').length > 0);
    const req = of('approvalRequested')[0];
    await session.interrupt();
    await turnDone(2);
    expect(of('turnCompleted')[1].status).toBe('interrupted');
    expect(of('requestResolved').find((r) => r.requestId === req.requestId)?.reason).toBe('cancelled');
    await expect(session.respond(req.requestId, { decision: 'once' })).rejects.toThrow(/no longer pending/);
  });

  it('keeps a message sent mid-turn for right after it (steer), or stops the turn for it (interrupt)', async () => {
    const { session, of, turnDone } = open();
    await session.start();
    await session.send('slow');
    await until(() => of('outputDelta').some((d) => d.delta.startsWith('tick1')));
    expect(await session.send('and then this')).toBe('steer');
    await turnDone(2);
    expect(of('turnCompleted').map((t) => t.finalText)).toEqual([expect.stringMatching(/slow done$/), 'Echo: and then this']);

    await session.send('slow');
    await until(() => of('outputDelta').filter((d) => d.delta.startsWith('tick1')).length >= 2);
    expect(await session.send('now this', { interrupt: true })).toBe('interrupt');
    await turnDone(4);
    expect(of('turnCompleted').slice(2).map((t) => t.status)).toEqual(['interrupted', 'completed']);
    expect(of('turnCompleted')[3].finalText).toBe('Echo: now this');
  });

  it('reports a failed prompt, and a missing login with how to sign in', async () => {
    const { session, of, turnDone } = open();
    await session.start();
    await session.send('fail now');
    await turnDone(1);
    expect(of('turnCompleted')[0]).toMatchObject({ status: 'failed', error: 'Model exploded' });
    await session.send('auth now');
    await turnDone(2);
    expect(of('turnCompleted')[1].status).toBe('failed');
    expect(of('turnCompleted')[1].error).toContain(`not signed in`);
    expect(of('turnCompleted')[1].error).toContain(spec.login);
  });

  it('gives the instructions with the first prompt only, hidden from the replayed history', async () => {
    const first = open({ developerInstructions: 'Remember the shop rules.' });
    await first.session.start();
    await first.session.send('one');
    await first.turnDone(1);
    await first.session.send('two');
    await first.turnDone(2);
    const prompts = received().filter((m) => m.method === 'session/prompt').map((m) => JSON.stringify(m.params));
    expect(prompts[0]).toContain('<system-reminder>\\nRemember the shop rules.');
    expect(prompts[1]).not.toContain('system-reminder');
    // Resumed: the earlier conversation comes back as history, the user's words without the instructions.
    const id = first.session.nativeSessionId()!;
    await first.session.close();
    const again = open({ resumeNativeSessionId: id, cwd: first.cwd, developerInstructions: 'Remember the shop rules.' });
    await again.session.start();
    expect(again.of('sessionStarted')[0]).toMatchObject({ nativeSessionId: id, resumed: true });
    const history = again.of('transcriptItem').filter((e) => e.history);
    expect(history.filter((h) => h.role === 'user').map((h) => h.text)).toEqual(['one', 'two']);
    expect(history.filter((h) => h.role === 'assistant').map((h) => h.text)).toEqual(['Echo: one', 'Echo: two']);
    expect(again.of('outputDelta')).toEqual([]);
    expect(received().some((m) => m.method === 'session/load')).toBe(true);
  });

  it('replays tool calls on load, and starts over (saying so) when the session is gone', async () => {
    const first = open({ permissionMode: 'edits' });
    await first.session.start();
    await first.session.send('tool');
    await first.turnDone(1);
    const id = first.session.nativeSessionId()!;
    await first.session.close();
    const again = open({ resumeNativeSessionId: id, cwd: first.cwd });
    await again.session.start();
    const tool = again.of('transcriptItem').filter((e) => e.history && e.role === 'tool').at(-1)!;
    expect(tool).toMatchObject({ toolStatus: 'completed', tool: { kind: 'edit', title: 'Edit src/app.ts' } });

    const gone = open({ resumeNativeSessionId: 'fake-nope' });
    await gone.session.start();
    expect(gone.of('sessionStarted')[0].resumed).toBe(false);
    expect(gone.of('sessionStarted')[0].nativeSessionId).not.toBe('fake-nope');
    expect(gone.of('transcriptItem')[0].text).toMatch(/Could not reopen.*Session not found/);
  });

  it('switches models through the config option, and back to the default', async () => {
    const { session, of } = open({ model: 'fake-large' });
    await session.start();
    expect(of('model').map((m) => m.model)).toEqual(['fake-small', 'fake-large']);
    await session.setModel!(undefined);
    expect(of('model').at(-1)!.model).toBe('fake-small');
    await expect(session.setModel!('nope')).rejects.toThrow(/Unknown option/);
  });

  it('says when the agent process ends', async () => {
    const { session, of } = open();
    await session.start();
    const conn = (session as unknown as { conn: { proc: ChildProcessWithoutNullStreams } }).conn;
    conn.proc.kill('SIGKILL');
    await until(() => of('sessionDisconnected').length > 0);
    expect(of('sessionDisconnected')[0].reason).toMatch(/OpenCode exited/);
    await expect(session.send('hi')).rejects.toThrow(/not connected/);
  });

  it('reports capabilities: import and side questions (fork is set by the workspace from forkSession/forkPoints)', async () => {
    const adapter = new AcpAdapter(spec, { command: ['node', FAKE] });
    const caps = await adapter.capabilities();
    expect(caps).toMatchObject({ provider: 'opencode', available: true, createSession: true, resumeHistorical: true, importHistory: true, sideQuestions: true, structuredApprovals: true });
    expect(typeof adapter.forkSession === 'function' && typeof adapter.forkPoints === 'function').toBe(true);
    expect(caps.auth).toBeUndefined();
    expect(ACP_AGENTS.map((a) => `${a.command} ${a.args.join(' ')}`)).toEqual(['opencode acp', 'agy acp']);
  });
});

describe('ACP adapter on a host (detached, through a local shell)', () => {
  function runner(home: string) {
    const env = { ...process.env, HOME: home };
    const attachments: ChildProcessWithoutNullStreams[] = [];
    const r: RemoteRunner = {
      spawn(command) {
        const p = spawn('sh', ['-c', command], { env, stdio: 'pipe' });
        attachments.push(p);
        return p;
      },
      run(command) {
        return new Promise((resolve) => {
          const p = spawn('sh', ['-c', command], { env, stdio: 'pipe' });
          let stdout = '';
          let stderr = '';
          p.stdout.on('data', (d) => (stdout += d));
          p.stderr.on('data', (d) => (stderr += d));
          p.on('close', (code) => resolve({ code: code ?? 255, stdout, stderr }));
        });
      },
    };
    return { r, attachments };
  }

  it('finds the CLI in its installer folder on the host', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amw-acp-home-'));
    const { r } = runner(home);
    const adapter = new AcpAdapter(spec, { runner: () => r });
    expect(await adapter.hostCapabilities('devbox')).toMatchObject({ available: false });
    mkdirSync(join(home, '.opencode/bin'), { recursive: true });
    writeFileSync(join(home, '.opencode/bin/opencode'), '#!/bin/sh\necho "opencode v2.4.2"\n');
    chmodSync(join(home, '.opencode/bin/opencode'), 0o755);
    expect(await adapter.hostCapabilities('devbox')).toMatchObject({ available: true, version: 'opencode v2.4.2', importHistory: true });
  });

  it('runs a turn there and carries on through a dropped connection, every chunk once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amw-acp-home-'));
    const { r, attachments } = runner(home);
    const { session, of, turnDone, cwd } = open({ host: 'devbox', permissionMode: 'ask' }, { runner: () => r, backoff: [200] });
    await session.start();
    expect(of('sessionStarted')[0].resumed).toBe(false);
    await session.send('slow');
    await until(() => of('outputDelta').some((d) => d.delta.startsWith('tick3')));
    attachments.at(-1)!.stdin.end(); // the connection drops
    await turnDone(1);
    expect(attachments.length).toBeGreaterThanOrEqual(2);
    const text = of('outputDelta').filter((d) => d.role === 'assistant').map((d) => d.delta).join('');
    expect(text).toBe(`${Array.from({ length: 30 }, (_, i) => `tick${i} `).join('')}slow done`);
    expect(of('turnCompleted')[0]).toMatchObject({ status: 'completed' });
    expect(of('sessionDisconnected')).toEqual([]);
    // Permission requests work over it too.
    await session.send('tool');
    await until(() => of('approvalRequested').length > 0);
    await session.respond(of('approvalRequested')[0].requestId, { decision: 'once' });
    await turnDone(2);
    expect(of('turnCompleted')[1].finalText).toBe('Edited src/app.ts.');
    void cwd;
  }, 30_000);
});

describe('line diffs', () => {
  it('gives hunks with line numbers and context', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const next = old.replace('line 10', 'line ten').replace('line 18', 'line 18\nnew line');
    const hunks = lineDiffHunks(old, next);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 7, oldLines: 7, newStart: 7, newLines: 7 });
    expect(hunks[0].lines).toEqual([' line 7', ' line 8', ' line 9', '-line 10', '+line ten', ' line 11', ' line 12', ' line 13']);
    expect(hunks[1]).toMatchObject({ oldStart: 16, newStart: 16, oldLines: 5, newLines: 6 });
    expect(hunks[1].lines).toEqual([' line 16', ' line 17', ' line 18', '+new line', ' line 19', ' line 20']);
    expect(lineDiffHunks('a\n', 'a\n')).toEqual([]);
  });
});
