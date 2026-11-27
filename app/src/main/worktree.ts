import { mkdirSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { WorktreeInfo } from '../shared/types';
import { run } from './util/exec';
import { shq, sshRun } from './util/ssh';

/** git in `dir`, on this Mac or on `host`. */
function git(host: string | undefined, dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!host) return run('git', ['-C', dir, ...args]);
  return sshRun(host, `git -C ${shq(dir)} ${args.map(shq).join(' ')}`, 120_000);
}

/** The repository `dir` is in (its top folder; on a host, its real path) and where `dir` is inside it ('' at the top). */
export async function repoOf(host: string | undefined, dir: string): Promise<{ root: string; prefix: string } | null> {
  const r = await git(host, dir, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (r.code !== 0) return null;
  const [root, prefix = ''] = r.stdout.split('\n');
  return root ? { root: root.trim(), prefix: prefix.trim().replace(/\/+$/, '') } : null;
}

// Per-task git worktrees isolate concurrent edits. They are NOT a security
// boundary; provider sandboxes and approvals remain the boundary.

export async function gitRoot(path: string): Promise<string | null> {
  const r = await run('git', ['-C', path, 'rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.stdout.trim() : null;
}

export class WorktreeService {
  constructor(private baseDir: string) {}

  /** `from`: the commit the new branch starts at (default: the project folder's HEAD). */
  async create(repoRoot: string, projectId: string, slug: string, from = 'HEAD'): Promise<WorktreeInfo> {
    const head = await run('git', ['-C', repoRoot, 'rev-parse', '--verify', '--end-of-options', `${from}^{commit}`]);
    if (head.code !== 0) throw new Error('The repository has no commits yet, so a worktree cannot be created.');
    const baseRef = head.stdout.trim();
    const branch = `amw/${slug}`;
    const path = join(this.baseDir, projectId, slug);
    mkdirSync(dirname(path), { recursive: true });
    const r = await run('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, path, baseRef]);
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return { path, branch, baseRef, parentRepo: repoRoot };
  }

  /**
   * Copies the uncommitted work of the checkout `from` is in (tracked changes and untracked,
   * non-ignored files, across the whole repository even when `from` is a subfolder) into the
   * worktree at `to`, which must start at the same commit. `from` is left exactly as it is.
   */
  async copyChanges(from: string, to: string): Promise<{ files: number; error?: string }> {
    const cdup = await run('git', ['-C', from, 'rev-parse', '--show-cdup']);
    if (cdup.code !== 0) return { files: 0, error: cdup.stderr.trim() || 'git rev-parse failed' };
    const root = resolve(from, cdup.stdout.trim() || '.');
    // A stash commit of the tracked changes, made without touching `from`'s files or index.
    // Worktrees of one repository share their objects, so `to` can apply it directly.
    const stash = await run('git', ['-C', from, 'stash', 'create']);
    if (stash.code !== 0) return { files: 0, error: stash.stderr.trim() || 'git stash create failed' };
    if (stash.stdout.trim()) {
      const applied = await run('git', ['-C', to, 'stash', 'apply', '--quiet', stash.stdout.trim()]);
      if (applied.code !== 0) return { files: 0, error: applied.stderr.trim() || 'git stash apply failed' };
    }
    // From the top of the checkout: from a subfolder, ls-files would list only that folder, relative to it.
    const untracked = await run('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked.code !== 0) return { files: 0, error: untracked.stderr.trim() || 'git ls-files failed' };
    // Entries ending in "/" are nested repositories, which are not copied.
    for (const file of untracked.stdout.split('\0').filter((f) => f && !f.endsWith('/'))) {
      try {
        // Async, so a large untracked file does not stall the app.
        await mkdir(dirname(join(to, file)), { recursive: true });
        await cp(join(root, file), join(to, file), { verbatimSymlinks: true });
      } catch (error) {
        return { files: 0, error: `could not copy ${file}: ${(error as Error).message}` };
      }
    }
    const status = await run('git', ['-C', to, 'status', '--porcelain', '-uall']);
    if (status.code !== 0) return { files: 0, error: status.stderr.trim() || 'git status failed' };
    return { files: status.stdout.split('\n').filter(Boolean).length };
  }

  /**
   * A worktree on an SSH host: next to the repository, in .amw-worktrees/ beside it (on the same disk as the
   * repository, which on a shared machine is where the room is), never in the home folder.
   */
  async createRemote(host: string, repoRoot: string, slug: string, from = 'HEAD'): Promise<WorktreeInfo> {
    const head = await git(host, repoRoot, ['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`]);
    if (head.code !== 0) throw new Error('The repository has no commits yet, so a worktree cannot be created.');
    const baseRef = head.stdout.trim();
    const branch = `amw/${slug}`;
    const root = repoRoot.replace(/\/+$/, '');
    const parent = root.slice(0, root.lastIndexOf('/')) || '/';
    const path = `${parent}/.amw-worktrees/${root.slice(root.lastIndexOf('/') + 1)}-${slug}`;
    const r = await sshRun(host, `mkdir -p ${shq(`${parent}/.amw-worktrees`)} && git -C ${shq(root)} worktree add -b ${shq(branch)} ${shq(path)} ${shq(baseRef)}`, 300_000);
    if (r.code !== 0) throw new Error(`git worktree add failed on ${host}: ${r.stderr.trim() || r.stdout.trim()}`);
    return { path, branch, baseRef, parentRepo: root, host };
  }

  /** Why the worktree must be kept, or null when it is safe to remove. */
  async keepReason(info: WorktreeInfo): Promise<string | null> {
    const status = await git(info.host, info.path, ['status', '--porcelain']);
    if (status.code !== 0) return `cannot read git status (${status.stderr.trim()})`;
    if (status.stdout.trim()) return 'it has uncommitted changes';
    const ahead = await git(info.host, info.path, ['rev-list', '--count', `${info.baseRef}..HEAD`]);
    if (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) return `branch ${info.branch} has commits not in the base`;
    return null;
  }

  /** Removes only a clean worktree with no new commits; never forces. */
  async removeIfClean(info: WorktreeInfo): Promise<{ removed: boolean; reason?: string }> {
    const reason = await this.keepReason(info);
    if (reason) return { removed: false, reason };
    const r = await git(info.host, info.parentRepo, ['worktree', 'remove', info.path]);
    if (r.code !== 0) return { removed: false, reason: r.stderr.trim() };
    // keepReason found nothing past baseRef, so nothing is lost. `-d` would refuse a branch that isn't merged into the
    // parent's HEAD, which a branch started from another agent's commit (a fork) usually isn't.
    await git(info.host, info.parentRepo, ['branch', '-D', info.branch]);
    return { removed: true };
  }
}
