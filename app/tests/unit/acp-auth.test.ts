// Sign-in of the ACP CLIs, natively: their own status commands parsed (outputs as the real CLIs printed
// them), the state read here and on a host (a local shell standing in for SSH), and signing in from
// the app: Antigravity's ACP authenticate (browser) and its link-and-code login, OpenCode's Terminal.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acpAgent } from '../../src/shared/acp-agents';
import { AcpAdapter } from '../../src/main/providers/acp';
import { authScript, opencodeCredentials, parseAuth, readAuth, splitAuthScript } from '../../src/main/providers/acp-auth';
import { AcpLogins } from '../../src/main/providers/acp-login';
import { shq } from '../../src/main/util/ssh';
import type { RemoteRunner } from '../../src/main/util/detached';

const FAKE = join(__dirname, '../fixtures/fake-acp-agent.mjs');
const opencode = acpAgent('opencode')!;
const antigravity = acpAgent('antigravity')!;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amw-acp-auth-'));
  delete process.env.FAKE_ACP_SIGNED_OUT;
  delete process.env.FAKE_ACP_AUTH_HANG;
  process.env.FAKE_ACP_AUTH_FILE = join(dir, 'signed-in');
  process.env.AMW_TERMINAL_LOG = join(dir, 'terminal.log');
});
afterEach(() => {
  delete process.env.FAKE_ACP_AUTH_FILE;
  delete process.env.AMW_TERMINAL_LOG;
});

/** A local shell standing in for SSH, with its own home folder (and no real CLI on its PATH). */
function host(home: string): RemoteRunner {
  const env = { ...process.env, HOME: home, PATH: (process.env.PATH ?? '').split(':').filter((d) => !existsSync(join(d, 'opencode')) && !existsSync(join(d, 'agy'))).join(':') };
  return {
    spawn: (command) => spawn('sh', ['-c', command], { env, stdio: 'pipe' }),
    run: (command) =>
      new Promise((resolve) => {
        const p = spawn('sh', ['-c', command], { env, stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (d) => (stdout += d));
        p.stderr.on('data', (d) => (stderr += d));
        p.on('close', (code) => resolve({ code: code ?? 255, stdout, stderr }));
      }),
  };
}
/** The fake installed on the host under the CLI's name, in its installer's folder. */
function install(home: string, name: string, folder: string): void {
  mkdirSync(join(home, folder), { recursive: true });
  writeFileSync(join(home, folder, name), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${name} 9.9.9"; exit 0; fi\nexec ${shq(process.execPath)} ${shq(FAKE)} "$@"\n`);
  chmodSync(join(home, folder, name), 0o755);
}

describe('status commands, as the real CLIs print them', () => {
  // `opencode auth list --format json` (OpenCode 2.4.2), signed in to OpenCode Zen; secrets are never listed.
  const OC_SIGNED_IN = '[\n  {\n    "id": "opencode",\n    "name": "OpenCode",\n    "connections": [\n      {\n        "type": "credential",\n        "id": "cred_21996cc8f001XXnch7UcafGA0j",\n        "label": "Personal",\n        "method": "oauth"\n      }\n    ]\n  }\n]\n';
  // `opencode models` with an empty home folder: the built-in free models.
  const OC_FREE = 'opencode/beam-free\nopencode/big-pickle\nopencode/deepseek-v4.1-flash-free\nopencode/flint-40b-free\n';
  // `agy models` (Antigravity 1.5.18), signed in, and with an empty home folder (exit 1).
  const AGY_SIGNED_IN = 'Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n';
  const AGY_SIGNED_OUT = '\x1b[KError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n';

  it('OpenCode: a stored credential is signed in (the integrations named); none still runs on the free models; nothing at all is signed out', () => {
    expect(opencodeCredentials(OC_SIGNED_IN)).toEqual(['OpenCode']);
    expect(parseAuth('opencode', [{ code: 0, out: OC_SIGNED_IN }])).toEqual({ loggedIn: true, method: 'OpenCode' });
    expect(parseAuth('opencode', [{ code: 0, out: '[]\n' }, { code: 0, out: OC_FREE }])).toEqual({ loggedIn: true, method: 'free models' });
    // A provider set up by environment variable or config.
    expect(parseAuth('opencode', [{ code: 0, out: '[]' }, { code: 0, out: `${OC_FREE}anthropic/claude-sonnet\n` }])).toEqual({ loggedIn: true, method: 'anthropic' });
    expect(parseAuth('opencode', [{ code: 0, out: '[]' }, { code: 1, out: 'Error: offline' }])).toEqual({ loggedIn: false });
    // OpenCode 1.x prints text.
    expect(opencodeCredentials('┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  Anthropic oauth\n│\n└  1 credentials\n')).toEqual(['Anthropic']);
    expect(opencodeCredentials('┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n')).toEqual([]);
    // Unreadable: unknown, so the row says only "Installed".
    expect(parseAuth('opencode', [{ code: 1, out: 'unknown command' }, { code: 1, out: '' }])).toBeUndefined();
  });

  it('Antigravity: its model list, or "Please sign in"; anything else is unknown', () => {
    expect(parseAuth('antigravity', [{ code: 0, out: AGY_SIGNED_IN }])).toEqual({ loggedIn: true });
    expect(parseAuth('antigravity', [{ code: 1, out: AGY_SIGNED_OUT }])).toEqual({ loggedIn: false });
    expect(parseAuth('antigravity', [{ code: 1, out: 'Error: dial tcp: lookup cloudcode-pa.googleapis.com: no such host' }])).toBeUndefined();
    expect(parseAuth('antigravity', [{ code: 0, out: 'Fetching available models...\n' }])).toBeUndefined();
  });

  it('runs the alternatives in order and skips the model list once a credential is stored', async () => {
    const calls: string[] = [];
    const auth = await readAuth('opencode', async (args) => {
      calls.push(args.join(' '));
      return args.includes('--format') ? { code: 0, stdout: OC_SIGNED_IN, stderr: '' } : { code: 0, stdout: OC_FREE, stderr: '' };
    });
    expect(auth).toEqual({ loggedIn: true, method: 'OpenCode' });
    expect(calls).toEqual(['auth list --format json --standalone']);
    // OpenCode 1.x refuses the flags: its plain commands.
    const old: string[] = [];
    await readAuth('opencode', async (args) => {
      old.push(args.join(' '));
      return args.includes('--standalone') ? { code: 1, stdout: '', stderr: 'unknown flag' } : { code: 0, stdout: args[0] === 'auth' ? '└  0 credentials' : 'opencode/big-pickle', stderr: '' };
    });
    expect(old).toEqual(['auth list --format json --standalone', 'auth list', 'models --standalone', 'models']);
  });

  it('one shell script for a host, its results split back', async () => {
    const script = authScript('opencode', [process.execPath, FAKE].map(shq).join(' '), shq);
    const r = await host(dir).run(script);
    const ran = splitAuthScript(r.stdout);
    expect(ran.map((x) => x.code)).toEqual([0, 1]);
    expect(parseAuth('opencode', ran)).toEqual({ loggedIn: false });
    writeFileSync(process.env.FAKE_ACP_AUTH_FILE!, 'ok');
    expect(parseAuth('opencode', splitAuthScript((await host(dir).run(script)).stdout))).toEqual({ loggedIn: true, method: 'FakeCo' });
  });
});

describe('sign-in state in the capabilities', () => {
  it('here: signed out until signed in, then signed in with what it uses', async () => {
    const adapter = new AcpAdapter(opencode, { command: ['node', FAKE] });
    expect((await adapter.capabilities()).auth).toEqual({ loggedIn: false });
    writeFileSync(process.env.FAKE_ACP_AUTH_FILE!, 'ok');
    expect((await adapter.capabilities()).auth).toEqual({ loggedIn: true, method: 'FakeCo' });
  });

  it('on a host, in the same connection as the version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amw-acp-authhome-'));
    install(home, 'agy', '.local/bin');
    const adapter = new AcpAdapter(antigravity, { runner: () => host(home) });
    expect(await adapter.hostCapabilities('devbox')).toMatchObject({ available: true, version: 'agy 9.9.9', auth: { loggedIn: false } });
    writeFileSync(process.env.FAKE_ACP_AUTH_FILE!, 'ok');
    expect(await adapter.hostCapabilities('devbox')).toMatchObject({ available: true, auth: { loggedIn: true } });
    // Not installed there: no sign-in to tell.
    const bare = new AcpAdapter(opencode, { runner: () => host(home) });
    expect(await bare.hostCapabilities('devbox')).toMatchObject({ available: false });
    expect((await bare.hostCapabilities('devbox')).auth).toBeUndefined();
  });
});

describe('signing in from the app', () => {
  it('Antigravity here: ACP authenticate with its browser method, done when it answers', async () => {
    const done: Array<[string, string | undefined, boolean]> = [];
    const logins = new AcpLogins((p, h, ok) => done.push([p, h, ok]));
    const log = join(dir, 'acp.jsonl');
    process.env.FAKE_ACP_LOG = log;
    try {
      const adapter = new AcpAdapter(antigravity, { command: ['node', FAKE] });
      expect(await logins.start(adapter)).toEqual({ browser: true });
      expect(await logins.wait(adapter)).toEqual({ ok: true });
      expect(done).toEqual([['antigravity', undefined, true]]);
      const sent = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(sent.find((m) => m.method === 'authenticate')?.params).toEqual({ methodId: 'oauth-personal' });
      expect((await adapter.capabilities()).auth).toEqual({ loggedIn: true });
    } finally {
      delete process.env.FAKE_ACP_LOG;
    }
  });

  it('a browser sign-in that never finishes can be cancelled', async () => {
    process.env.FAKE_ACP_AUTH_HANG = '1';
    const logins = new AcpLogins();
    const adapter = new AcpAdapter(antigravity, { command: ['node', FAKE] });
    await logins.start(adapter);
    const ended = logins.wait(adapter);
    logins.cancel(adapter);
    expect(await ended).toEqual({ ok: false, error: 'Cancelled.' });
  });

  it('Antigravity with a code: the link it prints, a wrong code refused with its reason, the right one signs in', async () => {
    const logins = new AcpLogins();
    const adapter = new AcpAdapter(antigravity, { command: ['node', FAKE] });
    expect(await logins.start(adapter, undefined, 'code')).toEqual({ url: 'https://example.test/oauth?state=fake' });
    logins.sendCode(adapter, undefined, 'bad-code');
    expect(await logins.wait(adapter)).toEqual({ ok: false, error: 'couldn\'t log in: token exchange failed: "invalid_grant"' });
    expect(() => logins.sendCode(adapter, undefined, 'again')).toThrow(/no longer waiting/);
    await logins.start(adapter, undefined, 'code');
    logins.sendCode(adapter, undefined, ' good-code ');
    expect(await logins.wait(adapter)).toEqual({ ok: true });
    expect(existsSync(process.env.FAKE_ACP_AUTH_FILE!)).toBe(true);
  });

  it('on a host: the code login runs there (the link opens here)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amw-acp-authhome-'));
    install(home, 'agy', '.local/bin');
    const done: Array<[string, string | undefined, boolean]> = [];
    const logins = new AcpLogins((p, h, ok) => done.push([p, h, ok]));
    const adapter = new AcpAdapter(antigravity, { runner: () => host(home) });
    // No browser method on a host: the code login, there.
    expect(await logins.start(adapter, 'devbox')).toEqual({ url: 'https://example.test/oauth?state=fake' });
    logins.sendCode(adapter, 'devbox', 'good-code');
    expect(await logins.wait(adapter, 'devbox')).toEqual({ ok: true });
    expect(done).toEqual([['antigravity', 'devbox', true]]);
  });

  it('OpenCode: its interactive login in a Terminal window, here or over ssh -t', async () => {
    const logins = new AcpLogins();
    const adapter = new AcpAdapter(opencode, { command: ['node', FAKE] });
    expect(await logins.start(adapter)).toEqual({ terminal: true });
    expect(await logins.start(adapter, 'devbox')).toEqual({ terminal: true });
    const lines = readFileSync(process.env.AMW_TERMINAL_LOG!, 'utf8').trim().split('\n');
    expect(lines[0]).toBe(`'node' '${FAKE}' auth login`);
    expect(lines[1]).toBe(String.raw`ssh -t devbox 'export PATH="$HOME/.opencode/bin:$PATH"; '\''opencode'\'' auth login'`);
  });
});
