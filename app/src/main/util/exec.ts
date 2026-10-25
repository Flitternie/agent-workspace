import { execFile, execFileSync } from 'node:child_process';
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

/**
 * An app opened from Finder/Dock inherits launchd's minimal PATH, not the one the
 * user's shell builds (nvm, asdf, custom bin dirs…). Read the login shell's PATH
 * once so CLIs are found wherever the user installed them.
 */
let shellPath: string[] | undefined;
function loginShellPath(): string[] {
  if (shellPath) return shellPath;
  shellPath = [];
  if (process.platform === 'win32' || process.env.AMW_NO_SHELL_PATH === '1') return shellPath;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'printf "__AMW_PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    shellPath = (out.split('__AMW_PATH__')[1] ?? '').trim().split(delimiter).filter(Boolean);
  } catch {
    /* no shell PATH: fall back to the usual locations */
  }
  return shellPath;
}

export function childPath(): string {
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of loginShellPath()) if (!parts.includes(dir)) parts.push(dir);
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
  // Windows CLIs are claude.exe / codex.cmd (npm shims); PATHEXT lists what counts as executable.
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of childPath().split(delimiter))
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      try {
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  return null;
}

/** Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980); npm shims on Windows are .cmd. */
export function needsShell(exe: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      needsShell(cmd) ? `"${cmd}"` : cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, env: childEnv(), maxBuffer: 16 * 1024 * 1024, shell: needsShell(cmd) },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
