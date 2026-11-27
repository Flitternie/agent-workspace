// Signing in to an ACP CLI from the app, the CLI's own way (shared/acp-agents.ts `signIn`):
//   terminal   an interactive login (OpenCode's `opencode auth login` menu) in a Terminal window,
//              here or on the host (`ssh -t`); the user rechecks when done.
//   browser    ACP `authenticate` with the CLI's browser method on this computer (Antigravity's
//              oauth-personal: it opens the browser and listens on localhost); done when it answers.
//   code       a command that prints a sign-in link and reads the code its page shows (Antigravity's
//              `agy acp --login`), here or on an SSH host: the link opens on this computer, the code
//              is pasted in the app and goes to the command's stdin.
// Credentials never pass through the app; only the pasted code, straight to the CLI.
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { childEnv, needsShell } from '../util/exec';
import { openCommandInTerminal, shq } from '../util/ssh';
import type { AcpAdapter, AcpConnection } from './acp';

export interface AcpLoginStarted {
  /** Opened in a Terminal window: finished there, then rechecked. */
  terminal?: boolean;
  /** The CLI opened the browser here and waits for it. */
  browser?: boolean;
  /** A sign-in page to open, whose code is pasted back (sendCode). */
  url?: string;
}

interface Running {
  proc?: ChildProcess;
  conn?: AcpConnection;
  done: Promise<{ ok: boolean; error?: string }>;
  cancelled?: boolean;
}

const CLIENT = { name: 'agent_workspace', title: 'Agent Workspace', version: '0.1.0' };

/** The last meaningful line a login printed (its reason for failing), without links. */
function lastLine(out: string): string {
  return (
    out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^https?:\/\//.test(l) && !/paste|press enter/i.test(l))
      .pop()
      ?.slice(0, 300) ?? ''
  );
}

export class AcpLogins {
  private running = new Map<string, Running>();

  /** `onDone`: a sign-in ended (the caller rechecks that machine). */
  constructor(private onDone: (provider: string, host: string | undefined, ok: boolean) => void = () => {}) {}

  private key(adapter: AcpAdapter, host?: string): string {
    return `${host ?? ''}:${adapter.provider}`;
  }

  async start(adapter: AcpAdapter, host?: string, mode?: 'code'): Promise<AcpLoginStarted> {
    const spec = adapter.spec;
    const how = spec.signIn;
    if (!how) throw new Error(`${spec.label} signs in only in a terminal: ${spec.login}`);
    this.cancel(adapter, host);
    if (how.terminal) {
      const cli = adapter.cliArgv(host);
      const command = `${host ? `${adapter.remotePath()}; ` : ''}${spec.login.replace(/^\S+/, cli ? cli.map(shq).join(' ') : spec.command)}`;
      await openCommandInTerminal(command, host);
      return { terminal: true };
    }
    if (how.acpMethod && !host && mode !== 'code') return this.browser(adapter, how.acpMethod);
    if (how.codeLogin) return this.code(adapter, how.codeLogin, host);
    throw new Error(`${spec.label} cannot sign in from the app here; run ${spec.login} in a terminal.`);
  }

  private finish(adapter: AcpAdapter, host: string | undefined, entry: Running, result: { ok: boolean; error?: string }): { ok: boolean; error?: string } {
    if (this.running.get(this.key(adapter, host)) === entry) this.running.delete(this.key(adapter, host));
    this.onDone(adapter.provider, host, result.ok);
    return entry.cancelled ? { ok: false, error: 'Cancelled.' } : result;
  }

  private async browser(adapter: AcpAdapter, methodId: string): Promise<AcpLoginStarted> {
    const conn = adapter.spawn(homedir());
    try {
      await conn.rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT });
    } catch (error) {
      conn.kill();
      throw error;
    }
    const entry: Running = { conn, done: Promise.resolve({ ok: false }) };
    entry.done = conn
      .rpc('authenticate', { methodId }, 10 * 60_000)
      .then(
        () => ({ ok: true }),
        (e: Error) => ({ ok: false, error: e.message }),
      )
      .then((r) => {
        conn.kill();
        return this.finish(adapter, undefined, entry, r);
      });
    this.running.set(this.key(adapter), entry);
    return { browser: true };
  }

  private code(adapter: AcpAdapter, args: readonly string[], host?: string): Promise<AcpLoginStarted> {
    const argv = adapter.cliArgv(host);
    if (!argv) throw new Error(`${adapter.spec.label} is not installed.`);
    const [exe, ...pre] = argv;
    const proc: ChildProcess = host
      ? adapter.runner(host).spawn(`${adapter.remotePath()}; exec ${[...argv, ...args].map(shq).join(' ')}`)
      : spawn(needsShell(exe) ? `"${exe}"` : exe, [...pre, ...args], { env: childEnv(), stdio: 'pipe', shell: needsShell(exe) });
    let out = '';
    const entry: Running = { proc, done: Promise.resolve({ ok: false }) };
    this.running.set(this.key(adapter, host), entry);
    return new Promise((resolve, reject) => {
      let settled = false;
      const url = () => /https?:\/\/[^\s"'<>]+/.exec(out)?.[0];
      const timer = setTimeout(() => settle(), 20_000);
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const u = url();
        if (u) resolve({ url: u });
        else reject(error ?? new Error(lastLine(out) || `${adapter.spec.label} did not give a sign-in link.`));
      };
      const read = (d: Buffer) => {
        out = (out + d.toString()).slice(-8000);
        // The link is complete once the line after it came.
        if (/https?:\/\/\S+\s*\n/.test(out)) settle();
      };
      proc.stdout?.on('data', read);
      proc.stderr?.on('data', read);
      entry.done = new Promise((done) => {
        proc.on('exit', (code) => {
          settle();
          done(this.finish(adapter, host, entry, code === 0 ? { ok: true } : { ok: false, error: lastLine(out) || `${adapter.spec.label} could not sign in.` }));
        });
        proc.on('error', (e) => {
          settle(e);
          done(this.finish(adapter, host, entry, { ok: false, error: e.message }));
        });
      });
    });
  }

  /** The code the sign-in page showed, to the waiting command. */
  sendCode(adapter: AcpAdapter, host: string | undefined, code: string): void {
    const proc = this.running.get(this.key(adapter, host))?.proc;
    if (!proc?.stdin || proc.exitCode !== null) throw new Error('That sign-in is no longer waiting; start it again.');
    proc.stdin.write(`${code.trim()}\n`);
  }

  /** How the sign-in under way ended (at once when none is). */
  wait(adapter: AcpAdapter, host?: string): Promise<{ ok: boolean; error?: string }> {
    return this.running.get(this.key(adapter, host))?.done ?? Promise.resolve({ ok: false, error: 'No sign-in is under way.' });
  }

  cancel(adapter: AcpAdapter, host?: string): void {
    const entry = this.running.get(this.key(adapter, host));
    if (!entry) return;
    entry.cancelled = true;
    this.running.delete(this.key(adapter, host));
    entry.conn?.kill();
    entry.proc?.kill();
  }
}
