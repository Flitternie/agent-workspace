import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Directories where user-installed CLIs usually live; a Finder-launched app lacks them. */
function extraPathDirs(): string[] {
  const home = homedir();
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
  ];
}

export function childPath(): string {
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of extraPathDirs()) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(delimiter);
}

/**
 * Environment for provider child processes: the user's own environment (so the
 * CLIs use their existing login and config) minus markers that would make a
 * child think it is nested inside another agent or inside Electron-as-node.
 */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  for (const k of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'])
    delete env[k];
  env.PATH = childPath();
  return env;
}

export function findExecutable(name: string): string | null {
  for (const dir of childPath().split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, env: childEnv(), maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
