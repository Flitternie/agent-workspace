// Signing in to Claude Code or Codex from the app: the CLI's own login runs in the background and
// opens the browser; the app only shows the link it prints (for when no browser opened) and notices
// the sign-in through the usual capability check. Credentials never pass through the app, except an
// API key handed straight to `codex login --with-api-key` on stdin (never stored or logged).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { childEnv, findExecutable, needsShell } from './util/exec';

export type LoginMethod = 'claudeai' | 'console' | 'chatgpt' | 'device';

export interface LoginStarted {
  /** A sign-in page the CLI printed (open it if the browser did not come up). */
  url?: string;
  /** A device code to enter on that page (Codex device sign-in). */
  code?: string;
}

const running = new Map<string, ChildProcess>();

function args(provider: 'claude' | 'codex', method?: LoginMethod): string[] {
  if (provider === 'claude') return ['auth', 'login', method === 'console' ? '--console' : '--claudeai'];
  return method === 'device' ? ['login', '--device-auth'] : ['login'];
}

function spawnCli(provider: 'claude' | 'codex', argv: string[]): ChildProcess {
  const exe = findExecutable(provider);
  if (!exe) throw new Error(provider === 'claude' ? 'Claude Code is not installed.' : 'Codex is not installed.');
  return spawn(needsShell(exe) ? `"${exe}"` : exe, argv, { env: childEnv(), stdio: 'pipe', shell: needsShell(exe) });
}

/**
 * Starts the CLI's sign-in (it opens the browser). Resolves once it has printed a link or code, or
 * after a few seconds; the process keeps waiting for the browser, and `onDone` runs when it exits.
 */
export function startLogin(provider: 'claude' | 'codex', method: LoginMethod | undefined, onDone: (ok: boolean) => void): Promise<LoginStarted> {
  running.get(provider)?.kill();
  const proc = spawnCli(provider, args(provider, method));
  running.set(provider, proc);
  let out = '';
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(found());
    };
    const found = (): LoginStarted => {
      const url = /https?:\/\/[^\s"'<>]+/.exec(out)?.[0];
      // Device codes look like "ABCD-1234".
      const code = method === 'device' ? /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/.exec(out)?.[0] : undefined;
      return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
    };
    const read = (d: Buffer) => {
      out = (out + d.toString()).slice(-8000);
      const f = found();
      if (f.url && (method !== 'device' || f.code)) settle();
    };
    proc.stdout?.on('data', read);
    proc.stderr?.on('data', read);
    const timer = setTimeout(settle, 4000);
    proc.on('exit', (code) => {
      if (running.get(provider) === proc) running.delete(provider);
      settle();
      onDone(code === 0);
    });
    proc.on('error', () => {
      settle();
      onDone(false);
    });
  });
}

export function cancelLogin(provider: 'claude' | 'codex'): void {
  running.get(provider)?.kill();
  running.delete(provider);
}

/** Codex with an API key: the key goes to the CLI on stdin and nowhere else. */
export function loginWithApiKey(key: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnCli('codex', ['login', '--with-api-key']);
    } catch (error) {
      resolve({ ok: false, error: (error as Error).message });
      return;
    }
    let err = '';
    proc.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, error: 'Codex did not finish signing in.' });
    }, 30_000);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      // The CLI's message, with anything key-like masked, in case it echoes input.
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim().replace(/sk-[\w-]{6,}/g, 'sk-…') || 'Codex refused the key.' });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    proc.stdin?.end(`${key.trim()}\n`);
  });
}

/** Desktop apps that tell what to suggest: a Claude subscription carries over to Claude Code, a ChatGPT one to Codex. */
export function desktopApps(): { claude: boolean; chatgpt: boolean } {
  if (process.platform !== 'darwin') return { claude: false, chatgpt: false };
  const has = (app: string) => existsSync(`/Applications/${app}.app`) || existsSync(`${homedir()}/Applications/${app}.app`);
  return { claude: has('Claude'), chatgpt: has('ChatGPT') };
}
