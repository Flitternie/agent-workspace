import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { childEnv } from './exec';

// Remote hosts are SSH aliases from the user's own ~/.ssh/config, reached with the
// system `ssh` (so ProxyJump, keys and known_hosts behave as in a terminal).
//
// Background calls never prompt (BatchMode). Prompts happen only when the user asks
// to connect or unlock a key: ssh / ssh-add then ask through SSH_ASKPASS, a native
// macOS dialog whose answer goes straight back to them; the app never sees or keeps
// a password. A successful login is shared through an OpenSSH control master, so one
// password or 2FA prompt covers every session on that host for a while.

/** An SSH alias we accept: no options, no patterns, no shell metacharacters. */
export const HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/;

const run = (cmd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface SshHostEntry {
  host: string;
  /** As written in the alias's own block (first value wins, as in ssh); for recognising the machine. */
  hostName?: string;
  user?: string;
}

/** Concrete `Host` aliases from ~/.ssh/config (patterns like `*` or `!x` are skipped). */
export function sshHostEntries(): SshHostEntry[] {
  let text = '';
  try {
    text = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return [];
  }
  const hosts = new Map<string, SshHostEntry>();
  let block: SshHostEntry[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\w+)\s*(?:=\s*|\s+)(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'host' || key === 'match') {
      block = [];
      if (key === 'match') continue;
      for (const name of m[2].split(/\s+/)) {
        if (!HOST_RE.test(name)) continue;
        if (!hosts.has(name)) hosts.set(name, { host: name });
        block.push(hosts.get(name)!);
      }
    } else if (key === 'hostname') for (const e of block) e.hostName ??= m[2];
    else if (key === 'user') for (const e of block) e.user ??= m[2];
  }
  return [...hosts.values()];
}

export function sshHosts(): string[] {
  return sshHostEntries().map((e) => e.host);
}

/** POSIX single-quoting for one word of a remote shell command. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Short socket dir (unix socket paths are limited to ~104 bytes). */
function controlDir(): string {
  const dir = join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `amw-ssh-${userInfo().uid}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function baseOptions(interactive: boolean): string[] {
  const opts = ['-o', `BatchMode=${interactive ? 'no' : 'yes'}`, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30'];
  if (process.platform !== 'win32')
    opts.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${join(controlDir(), '%C')}`, '-o', 'ControlPersist=8h');
  return opts;
}

function sshArgs(host: string, command: string, interactive = false): string[] {
  if (!HOST_RE.test(host)) throw new Error(`Not a usable SSH host alias: ${host}`);
  // Through the remote login shell, so the CLI is on PATH as it is in a terminal there.
  const remote = `exec "\${SHELL:-/bin/sh}" -lc ${shq(command)}`;
  return ['-T', ...baseOptions(interactive), '--', host, remote];
}

/** A long-lived remote process whose stdio is the SSH channel. */
export function sshSpawn(host: string, command: string): ChildProcessWithoutNullStreams {
  return spawn('ssh', sshArgs(host, command), { env: childEnv(), stdio: 'pipe', detached: process.platform !== 'win32' });
}

export function sshRun(host: string, command: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return run('ssh', sshArgs(host, command), childEnv(), timeoutMs);
}

// ------------------------------------------------------------ prompts (user-initiated only)

const ASKPASS = `#!/bin/sh
# SSH_ASKPASS for Agent Workspace: ssh / ssh-add ask here and get the answer directly.
exec /usr/bin/osascript - "$1" "\${SSH_ASKPASS_PROMPT:-}" <<'APPLESCRIPT'
on run argv
  set p to item 1 of argv
  set kind to item 2 of argv
  if kind is "confirm" or p contains "(yes/no" then
    display dialog p with title "Agent Workspace · SSH" buttons {"Cancel", "Trust"} default button "Trust" cancel button "Cancel" with icon caution
    if p contains "(yes/no" then return "yes"
    return ""
  end if
  set r to display dialog p with title "Agent Workspace · SSH" default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel"
  return text returned of r
end run
APPLESCRIPT
`;

function askpassEnv(): Record<string, string> {
  const file = join(controlDir(), 'askpass.sh');
  writeFileSync(file, ASKPASS, { mode: 0o700 });
  chmodSync(file, 0o700);
  return { ...childEnv(), SSH_ASKPASS: file, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0' };
}

/** Logs in once with prompts (password, 2FA, new host key); later calls reuse the connection. */
export async function sshConnect(host: string): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') return { ok: false, error: 'Connecting with a password from the app is only supported on macOS. Connect once from a terminal.' };
  const r = await run('ssh', ['-T', ...baseOptions(true), '--', host, 'true'], askpassEnv(), 180_000);
  return r.code === 0 ? { ok: true } : { ok: false, error: sshError(host, r.stderr) };
}

/** Private keys `ssh` would use for `host` that exist on disk. */
async function identityFiles(host: string): Promise<string[]> {
  const r = await run('ssh', ['-G', '--', host], childEnv(), 10_000);
  return r.stdout
    .split('\n')
    .map((l) => /^identityfile\s+(.+)$/i.exec(l.trim())?.[1])
    .filter((f): f is string => !!f)
    .map((f) => f.replace(/^~(?=\/)/, homedir()))
    .filter((f) => existsSync(f));
}

/** Keys for `host` that need a passphrase and are not in the SSH agent. */
export async function lockedKeys(host: string): Promise<string[]> {
  const loaded = (await run('ssh-add', ['-l'], childEnv(), 10_000)).stdout;
  const locked: string[] = [];
  for (const file of await identityFiles(host)) {
    const fp = (await run('ssh-keygen', ['-lf', `${file}.pub`], childEnv(), 10_000)).stdout.split(/\s+/)[1];
    if (fp && loaded.includes(fp)) continue;
    // Can the key be read without a passphrase? (-y prints the public key; never the private one.)
    const open = await run('ssh-keygen', ['-y', '-P', '', '-f', file], childEnv(), 10_000);
    if (open.code !== 0) locked.push(file);
  }
  return locked;
}

/** Adds `host`'s locked keys to the agent; the passphrase goes to ssh-add and the macOS Keychain. */
export async function unlockKeys(host: string): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') return { ok: false, error: 'Unlocking keys from the app is only supported on macOS. Run ssh-add in a terminal.' };
  for (const file of await lockedKeys(host)) {
    const r = await run('ssh-add', ['--apple-use-keychain', file], askpassEnv(), 180_000);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim().split('\n').pop() || `Could not unlock ${file}.` };
  }
  return { ok: true };
}

/** Reloads passphrases saved in the macOS Keychain into the agent (no prompt). */
export async function loadKeychainKeys(): Promise<void> {
  if (process.platform === 'darwin') await run('ssh-add', ['--apple-load-keychain'], childEnv(), 15_000);
}

/** Opens Terminal with `ssh host` for anything the app cannot handle itself. */
export async function openInTerminal(host: string): Promise<void> {
  if (!HOST_RE.test(host)) throw new Error(`Not a usable SSH host alias: ${host}`);
  if (process.platform !== 'darwin') throw new Error('Only supported on macOS.');
  await run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal" to do script "ssh " & item 1 of argv', '-e', 'tell application "Terminal" to activate', '-e', 'end run', host], childEnv(), 15_000);
}

// ------------------------------------------------------------ diagnosis

export type SshState = 'ok' | 'needs_key' | 'needs_login' | 'unknown_host_key' | 'unreachable';

/** Whether a background (non-interactive) connection to `host` works, and if not why. */
export async function sshProbe(host: string): Promise<{ state: SshState; error?: string }> {
  const r = await sshRun(host, 'true', 25_000);
  if (r.code === 0) return { state: 'ok' };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(r.stderr)) return { state: 'unknown_host_key', error: sshError(host, r.stderr) };
  if (/Permission denied|Too many authentication failures/i.test(r.stderr))
    return { state: (await lockedKeys(host)).length ? 'needs_key' : 'needs_login', error: sshError(host, r.stderr) };
  return { state: 'unreachable', error: sshError(host, r.stderr) };
}

/** A short reason an SSH call failed, for the user. */
export function sshError(host: string, stderr: string): string {
  const line = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  if (/Permission denied/i.test(stderr)) return `SSH to ${host} needs a login or an unlocked key (${line}). Connect it in Settings › Remote machines.`;
  if (/Host key verification failed/i.test(stderr)) return `${host}'s host key is not trusted yet. Connect it in Settings › Remote machines.`;
  return `SSH to ${host} failed${line ? `: ${line}` : '.'}`;
}
