import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake `codex app-server`: answers JSON-RPC requests by method and records them.
type Req = { id?: number; method: string; params?: Record<string, unknown> };
const calls: Array<{ method: string; params: Record<string, unknown>; cwd: string }> = [];
let handlers: Record<string, (params: Record<string, unknown>) => unknown> = {};

function fakeAppServer(cwd: string) {
  const proc = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; pid?: number };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  let buf = '';
  proc.stdin = new Writable({
    write(chunk, _enc, done) {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as Req;
        buf = buf.slice(nl + 1);
        if (msg.id === undefined) continue; // a notification (initialized)
        calls.push({ method: msg.method, params: msg.params ?? {}, cwd });
        const handler = handlers[msg.method];
        const reply = handler ? { id: msg.id, result: handler(msg.params ?? {}) } : { id: msg.id, error: { code: -32601, message: `no ${msg.method}` } };
        proc.stdout.write(`${JSON.stringify(reply)}\n`);
      }
      done();
    },
  });
  return proc;
}

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: vi.fn((_cmd: string, _args: string[], opts: { cwd: string }) => fakeAppServer(opts.cwd)),
}));
vi.mock('../../src/main/util/exec', async (orig) => ({
  ...(await orig<typeof import('../../src/main/util/exec')>()),
  findExecutable: () => '/fake/bin/codex',
  needsShell: () => false,
}));

const text = (t: string) => [{ type: 'text', text: t, text_elements: [] }];
// A saved thread: the first turn opens with Codex's AGENTS.md preamble, the second has a prompt
// steered in while it ran, the third is a turn without a typed prompt.
const turns = [
  {
    id: 'turn-1',
    status: 'completed',
    items: [
      { type: 'userMessage', id: 'i1', content: text('# AGENTS.md instructions for /repo\n\nBe brief.') },
      { type: 'userMessage', id: 'i2', content: text('Remember the codeword KIWI-3.') },
      { type: 'agentMessage', id: 'i3', text: 'ok' },
    ],
  },
  {
    id: 'turn-2',
    status: 'interrupted',
    items: [
      { type: 'userMessage', id: 'i4', content: text('<environment_context>cwd</environment_context>\nThe codeword is now PLUM-9.') },
      { type: 'userMessage', id: 'i5', content: text('(steered) and reply with ok') },
      { type: 'agentMessage', id: 'i6', text: 'ok' },
    ],
  },
  { id: 'turn-3', status: 'completed', items: [{ type: 'agentMessage', id: 'i7', text: 'compacted' }] },
  { id: 'turn-4', status: 'completed', items: [{ type: 'userMessage', id: 'i8', content: text('What is the codeword?') }] },
];

beforeEach(() => {
  calls.length = 0;
  handlers = {
    initialize: () => ({ userAgent: 'fake' }),
    'skills/list': () => ({ data: [] }),
    'thread/read': () => ({ thread: { id: 'thread-a', turns } }),
    'thread/fork': () => ({ thread: { id: 'thread-fork', turns: [] }, cwd: '/wt/fork', model: 'gpt', modelProvider: 'openai', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } }),
    'thread/name/set': () => ({}),
  };
});

describe('Codex forking through app-server', () => {
  it('fork points are the typed prompts that start a turn, each keeping the turns before it', async () => {
    const { CodexAdapter } = await import('../../src/main/providers/codex');
    const points = await new CodexAdapter().forkPoints('thread-a', '/does/not/exist');
    expect(points).toEqual([
      { upToMessageId: 'turn-1', prompt: 'The codeword is now PLUM-9.' },
      { upToMessageId: 'turn-3', prompt: 'What is the codeword?' },
    ]);
    expect(calls.find((c) => c.method === 'thread/read')?.params).toEqual({ threadId: 'thread-a', includeTurns: true });
  });

  it('forkSession forks through the chosen turn into the fork’s own folder, and names it', async () => {
    const { CodexAdapter } = await import('../../src/main/providers/codex');
    const id = await new CodexAdapter().forkSession('thread-a', { cwd: '/repo', targetCwd: '/tmp', upToMessageId: 'turn-1', title: 'Codewords (fork)' });
    expect(id).toBe('thread-fork');
    const fork = calls.find((c) => c.method === 'thread/fork')!;
    expect(fork.params).toEqual({ threadId: 'thread-a', cwd: '/tmp', excludeTurns: true, lastTurnId: 'turn-1' });
    // The app-server runs in the fork's folder.
    expect(fork.cwd).toBe('/tmp');
    expect(calls.find((c) => c.method === 'thread/name/set')?.params).toEqual({ threadId: 'thread-fork', name: 'Codewords (fork)' });
  });

  it('forkSession without a fork point copies the whole thread, in the original folder when no target is given', async () => {
    const { CodexAdapter } = await import('../../src/main/providers/codex');
    delete handlers['thread/name/set']; // naming fails (an RPC error): the fork still stands
    await expect(new CodexAdapter().forkSession('thread-a', { cwd: '/tmp', title: 'x' })).resolves.toBe('thread-fork');
    expect(calls.find((c) => c.method === 'thread/fork')?.params).toEqual({ threadId: 'thread-a', cwd: '/tmp', excludeTurns: true });
  });

  it('a failed fork is an error, not an empty id', async () => {
    const { CodexAdapter } = await import('../../src/main/providers/codex');
    handlers['thread/fork'] = () => ({ thread: {} });
    await expect(new CodexAdapter().forkSession('thread-a', { cwd: '/tmp' })).rejects.toThrow(/did not return/);
  });
});
