import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexRemoteControl } from '../../src/shared/types';
import type { ProviderEvent } from '../../src/main/providers/types';

// Codex Remote Control against a fake `codex app-server` (never the real one: enabling or pairing
// registers this computer with an OpenAI account). Replies by method; notifications on demand.
type Req = { id?: number; method: string; params?: Record<string, unknown> };
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
let handlers: Record<string, (params: Record<string, unknown>) => unknown> = {};
let current: PassThrough | undefined;
const notify = (method: string, params: Record<string, unknown>) => current?.write(`${JSON.stringify({ method, params })}\n`);

function fakeAppServer() {
  const proc = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; pid?: number; exitCode: number | null; signalCode: string | null; kill: () => void };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = () => {};
  current = proc.stdout;
  let buf = '';
  proc.stdin = new Writable({
    write(chunk, _enc, done) {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as Req;
        buf = buf.slice(nl + 1);
        if (msg.id === undefined) continue;
        calls.push({ method: msg.method, params: msg.params ?? {} });
        const handler = handlers[msg.method];
        let reply: unknown;
        try {
          // Codex 0.162 answers a method it does not know with "unknown variant".
          reply = handler ? { id: msg.id, result: handler(msg.params ?? {}) } : { id: msg.id, error: { code: -32600, message: `Invalid request: unknown variant \`${msg.method}\`, expected one of …` } };
        } catch (e) {
          reply = { id: msg.id, error: { code: -32600, message: (e as Error).message } };
        }
        proc.stdout.write(`${JSON.stringify(reply)}\n`);
      }
      done();
    },
  });
  return proc;
}

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, spawn: vi.fn((cmd: string, args: string[], opts: object) => (/codex$/.test(cmd) ? fakeAppServer() : real.spawn(cmd, args, opts))) };
});
vi.mock('../../src/main/util/exec', async (orig) => ({
  ...(await orig<typeof import('../../src/main/util/exec')>()),
  findExecutable: () => '/fake/bin/codex',
  needsShell: () => false,
}));

const EXPIRES = Math.floor(Date.now() / 1000) + 600;
let claimed = false;
let clients: Array<Record<string, unknown>> = [];
const status = (s: string) => ({ status: s, serverName: 'studio-mac', installationId: 'inst-1', environmentId: s === 'disabled' ? null : 'env-1' });

beforeEach(() => {
  calls.length = 0;
  claimed = false;
  clients = [{ clientId: 'c-old', displayName: null, deviceType: 'phone', platform: 'iOS', osVersion: '19', deviceModel: 'iPhone', appVersion: '1', lastSeenAt: 1_790_000_000 }];
  process.env.AMW_CODEX_PAIR_POLL_MS = '20';
  handlers = {
    initialize: () => ({ userAgent: 'fake' }),
    'thread/start': () => ({ thread: { id: 'thread-1', turns: [] }, model: 'gpt-5' }),
    'account/rateLimits/read': () => ({ rateLimits: null }),
    'account/read': () => ({ account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true, workspaceRouting: null }),
    'configRequirements/read': () => ({ supportsIndependentSpeedModes: true, requirements: null }),
    'remoteControl/enable': () => status('connecting'),
    'remoteControl/disable': () => status('disabled'),
    'remoteControl/pairing/start': () => ({ pairingCode: 'long-qr-token', manualPairingCode: 'K7Q-4MZ', environmentId: 'env-1', expiresAt: EXPIRES }),
    'remoteControl/pairing/status': () => ({ claimed }),
    'remoteControl/client/list': () => ({ data: clients, nextCursor: null }),
    'remoteControl/client/revoke': (p) => {
      clients = clients.filter((c) => c.clientId !== p.clientId);
      return {};
    },
  };
});
afterEach(() => {
  delete process.env.AMW_CODEX_PAIR_POLL_MS;
});

const until = async (pred: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function session() {
  const { CodexAdapter } = await import('../../src/main/providers/codex');
  const events: ProviderEvent[] = [];
  const s = new CodexAdapter().createSession({ cwd: tmpdir(), title: 'Orders' }, (e) => events.push(e));
  await s.start();
  const states = () => events.filter((e): e is Extract<ProviderEvent, { type: 'remoteControl' }> => e.type === 'remoteControl').map((e) => e.state);
  const last = () => states().at(-1);
  return { s, events, states, last };
}

describe('Codex Remote Control (session)', () => {
  it('enables ephemerally, shows the manual code and expiry, then notices the phone pairing', async () => {
    const { s, last } = await session();
    const res = await s.setRemoteControl!(true, 'Orders');
    expect(res.codex).toMatchObject({ status: 'connecting', paired: false, code: 'K7Q-4MZ', serverName: 'studio-mac', expiresAt: new Date(EXPIRES * 1000).toISOString() });
    // Ephemeral: never changes the remote-control preference Codex keeps for its other app-servers.
    expect(calls.find((c) => c.method === 'remoteControl/enable')?.params).toEqual({ ephemeral: true });
    expect(calls.find((c) => c.method === 'remoteControl/pairing/start')?.params).toEqual({ manualCode: true });
    // Already paired devices are listed.
    await until(() => !!last()?.devices?.length);
    expect(last()!.devices).toEqual([{ id: 'c-old', name: 'iPhone · iOS', lastSeenAt: new Date(1_790_000_000_000).toISOString() }]);
    // The connection comes up.
    notify('remoteControl/status/changed', status('connected'));
    await until(() => last()?.status === 'connected');
    // It asks with the manual code until the phone claims it.
    await until(() => calls.some((c) => c.method === 'remoteControl/pairing/status'));
    expect(calls.find((c) => c.method === 'remoteControl/pairing/status')?.params).toEqual({ manualPairingCode: 'K7Q-4MZ' });
    clients = [{ clientId: 'c-new', displayName: 'Lynn’s iPhone', lastSeenAt: null }, ...clients];
    claimed = true;
    await until(() => last()?.paired === true);
    expect(last()).toMatchObject({ paired: true, status: 'connected' });
    expect(last()!.code).toBeUndefined();
    await until(() => last()?.devices?.length === 2);
    const polls = calls.filter((c) => c.method === 'remoteControl/pairing/status').length;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.filter((c) => c.method === 'remoteControl/pairing/status').length).toBe(polls); // stopped asking

    // Unpair a device.
    await s.revokeRemoteDevice!('c-old');
    expect(calls.find((c) => c.method === 'remoteControl/client/revoke')?.params).toEqual({ environmentId: 'env-1', clientId: 'c-old' });
    expect(last()!.devices!.map((d) => d.id)).toEqual(['c-new']);

    // Off: disabled ephemerally; status news no longer reported.
    await s.setRemoteControl!(false);
    expect(calls.find((c) => c.method === 'remoteControl/disable')?.params).toEqual({ ephemeral: true });
    const n = (await Promise.resolve(last())) as CodexRemoteControl | undefined;
    notify('remoteControl/status/changed', status('disabled'));
    await new Promise((r) => setTimeout(r, 30));
    expect(last()).toBe(n);
    await s.close();
  });

  it('an expired code is dropped; on again gives a fresh code without enabling twice', async () => {
    handlers['remoteControl/pairing/start'] = () => ({ pairingCode: 'p', manualPairingCode: 'OLD-111', environmentId: 'env-1', expiresAt: Math.floor(Date.now() / 1000) + 1 });
    const { s, last } = await session();
    await s.setRemoteControl!(true);
    await until(() => last()?.code === undefined && last()?.paired === false, 4000);
    handlers['remoteControl/pairing/start'] = () => ({ pairingCode: 'p', manualPairingCode: 'NEW-222', environmentId: 'env-1', expiresAt: EXPIRES });
    const res = await s.setRemoteControl!(true);
    expect(res.codex?.code).toBe('NEW-222');
    expect(calls.filter((c) => c.method === 'remoteControl/enable')).toHaveLength(1);
    await s.close();
  });

  it('refuses an API-key login before enabling anything', async () => {
    handlers['account/read'] = () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true, workspaceRouting: null });
    const { s } = await session();
    await expect(s.setRemoteControl!(true)).rejects.toThrow('Remote Control needs Codex signed in with ChatGPT; API keys are not supported.');
    expect(calls.some((c) => c.method === 'remoteControl/enable')).toBe(false);
    await s.close();
  });

  it('refuses when the organization’s requirements turn it off', async () => {
    handlers['configRequirements/read'] = () => ({ supportsIndependentSpeedModes: true, requirements: { allowRemoteControl: false } });
    const { s } = await session();
    await expect(s.setRemoteControl!(true)).rejects.toThrow(/turned off by your organization's Codex requirements/);
    expect(calls.some((c) => c.method === 'remoteControl/enable')).toBe(false);
    await s.close();
  });

  it('says so when Codex itself refuses (its own messages), or is too old to have it', async () => {
    const { s } = await session();
    handlers['remoteControl/enable'] = () => {
      throw new Error('remote control requires ChatGPT authentication; API key auth is not supported');
    };
    await expect(s.setRemoteControl!(true)).rejects.toThrow('Remote Control needs Codex signed in with ChatGPT; API keys are not supported.');
    handlers['remoteControl/enable'] = () => {
      throw new Error('remote control is disabled by managed requirements');
    };
    await expect(s.setRemoteControl!(true)).rejects.toThrow(/organization's Codex requirements/);
    delete handlers['remoteControl/enable']; // an older Codex: unknown method
    await expect(s.setRemoteControl!(true)).rejects.toThrow('This Codex version has no Remote Control. Update the Codex CLI and try again.');
    await s.close();
  });

  it('a pairing that fails leaves Remote Control off', async () => {
    handlers['remoteControl/pairing/start'] = () => {
      throw new Error('remote control pairing failed at `https://chatgpt.com/…`: HTTP 500');
    };
    const { s } = await session();
    await expect(s.setRemoteControl!(true)).rejects.toThrow(/pairing failed/);
    expect(calls.filter((c) => c.method === 'remoteControl/disable')).toHaveLength(1);
    await s.close();
  });

  it('maps Codex errors to plain words and reads its timestamps', async () => {
    const { codexRemoteError, codexTime } = await import('../../src/main/providers/codex');
    expect(codexRemoteError('remoteControl/status/read requires experimentalApi capability')).toMatch(/no Remote Control/);
    expect(codexRemoteError('remote control requires sqlite state db')).toMatch(/state database/);
    expect(codexRemoteError('remote control is unavailable for this app-server')).toMatch(/not available/);
    expect(codexRemoteError('something else')).toBe('something else');
    expect(codexTime(1_790_000_000)).toBe(new Date(1_790_000_000_000).toISOString());
    expect(codexTime(1_790_000_000_000)).toBe(new Date(1_790_000_000_000).toISOString());
    expect(codexTime(null)).toBeUndefined();
  });

  it('is offered with a ChatGPT login only', async () => {
    const exec = await import('../../src/main/util/exec');
    const { CodexAdapter } = await import('../../src/main/providers/codex');
    const run = vi.spyOn(exec, 'run');
    run.mockImplementation(async (_cmd, args) => ({ code: 0, stdout: args[0] === '--version' ? 'codex-cli 0.162.1' : 'Logged in using ChatGPT', stderr: '' }));
    expect((await new CodexAdapter().capabilities()).remoteControl).toBe(true);
    run.mockImplementation(async (_cmd, args) => ({ code: 0, stdout: args[0] === '--version' ? 'codex-cli 0.162.1' : 'Logged in using an API key - sk-***', stderr: '' }));
    expect((await new CodexAdapter().capabilities()).remoteControl).toBe(false);
    run.mockRestore();
  });
});

describe('Codex Remote Control (workspace)', () => {
  it('turns on for a local Codex agent, follows pairing in the snapshot, and ends with the session', async () => {
    const { CodexAdapter } = await import('../../src/main/providers/codex');
    const { Workspace } = await import('../../src/main/workspace');
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-rc-data-'));
    const dir = mkdtempSync(join(tmpdir(), 'amw-rc-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# x\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
    const ws = new Workspace({ dataDir, adapters: { codex: new CodexAdapter() } });
    try {
      const project = await ws.addProject(dir, 'shop');
      const task = await ws.createTask({ projectId: project.projectId, provider: 'codex', name: 'Orders', title: 'Orders', isolate: false });
      // Not connected: on starts the session first.
      await ws.setRemoteControl(task.taskId, true);
      expect(ws.snapshot().connectedTaskIds).toContain(task.taskId);
      expect(ws.snapshot().codexRemote[task.taskId]).toMatchObject({ code: 'K7Q-4MZ', paired: false });
      expect(ws.snapshot().remoteControl[task.taskId]).toBeUndefined(); // Claude's links stay Claude's
      claimed = true;
      await until(() => ws.snapshot().codexRemote[task.taskId]?.paired === true);
      // Unpair through the workspace.
      await until(() => !!ws.snapshot().codexRemote[task.taskId]?.devices?.length);
      await ws.revokeRemoteDevice(task.taskId, 'c-old');
      await until(() => !ws.snapshot().codexRemote[task.taskId]?.devices?.some((d) => d.id === 'c-old'));
      // Off.
      await ws.setRemoteControl(task.taskId, false);
      expect(ws.snapshot().codexRemote[task.taskId]).toBeUndefined();
      // On, then the session stops: it goes with it.
      await ws.setRemoteControl(task.taskId, true);
      expect(ws.snapshot().codexRemote[task.taskId]).toBeTruthy();
      await ws.stop(task.taskId);
      await until(() => !ws.snapshot().codexRemote[task.taskId]);
      await expect(ws.revokeRemoteDevice(task.taskId, 'c-new')).rejects.toThrow(/not on/);
    } finally {
      await ws.shutdown();
    }
  });
});

describe('the pairing QR code', () => {
  it("carries Codex's pairing code in the ChatGPT pairing link, or the wrapping AMW_CODEX_QR_FORMAT names", async () => {
    const { qrPayload } = await import('../../src/main/providers/codex');
    const before = process.env.AMW_CODEX_QR_FORMAT;
    delete process.env.AMW_CODEX_QR_FORMAT;
    expect(qrPayload('pc-123')).toBe('https://chatgpt.com/codex/pair?pairing_code=pc-123');
    expect(qrPayload('a+b/c')).toBe('https://chatgpt.com/codex/pair?pairing_code=a%2Bb%2Fc');
    expect(qrPayload('')).toBeUndefined();
    process.env.AMW_CODEX_QR_FORMAT = 'https://example.test/pair?c={code}';
    expect(qrPayload('a b')).toBe('https://example.test/pair?c=a%20b');
    if (before === undefined) delete process.env.AMW_CODEX_QR_FORMAT;
    else process.env.AMW_CODEX_QR_FORMAT = before;
  });
});

describe('resuming a Codex thread that never had a message', () => {
  it('starts it afresh instead of failing (nothing was saved to resume)', async () => {
    handlers['thread/resume'] = () => {
      throw new Error('no rollout found for thread id 01a21bae-3de6-71d3-93a5-d028352c2ca1');
    };
    const { CodexAdapter } = await import('../../src/main/providers/codex');
    const events: ProviderEvent[] = [];
    const s = new CodexAdapter().createSession({ cwd: tmpdir(), title: 'Orders', resumeNativeSessionId: '01a21bae-3de6-71d3-93a5-d028352c2ca1' }, (e) => events.push(e));
    await s.start();
    expect(calls.map((c) => c.method)).toContain('thread/start');
    expect(events.find((e) => e.type === 'sessionStarted')).toMatchObject({ nativeSessionId: 'thread-1', resumed: false });
    // Another failure still fails.
    handlers['thread/resume'] = () => {
      throw new Error('permission denied');
    };
    const t = new CodexAdapter().createSession({ cwd: tmpdir(), title: 'Orders', resumeNativeSessionId: 'x' }, () => {});
    await expect(t.start()).rejects.toThrow('permission denied');
  });
});
