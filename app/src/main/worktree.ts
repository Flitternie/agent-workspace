import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorktreeInfo } from '../shared/types';
import { run } from './util/exec';

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
   * Copies `from`'s uncommitted work (tracked changes and untracked, non-ignored files) into the
   * worktree at `to`, which must start at the same commit. `from` is left exactly as it is.
   */
  async copyChanges(from: string, to: string): Promise<{ files: number; error?: string }> {
    // A stash commit of the tracked changes, made without touching `from`'s files or index.
    // Worktrees of one repository share their objects, so `to` can apply it directly.
    const stash = await run('git', ['-C', from, 'stash', 'create']);
    if (stash.code !== 0) return { files: 0, error: stash.stderr.trim() || 'git stash create failed' };
    if (stash.stdout.trim()) {
      const applied = await run('git', ['-C', to, 'stash', 'apply', '--quiet', stash.stdout.trim()]);
      if (applied.code !== 0) return { files: 0, error: applied.stderr.trim() || 'git stash apply failed' };
    }
    const untracked = await run('git', ['-C', from, 'ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked.code !== 0) return { files: 0, error: untracked.stderr.trim() };
    // Entries ending in "/" are nested repositories, which are not copied.
    for (const file of untracked.stdout.split('\0').filter((f) => f && !f.endsWith('/'))) {
      try {
        mkdirSync(dirname(join(to, file)), { recursive: true });
        cpSync(join(from, file), join(to, file), { verbatimSymlinks: true });
      } catch (error) {
        return { files: 0, error: `could not copy ${file}: ${(error as Error).message}` };
      }
    }
    const status = await run('git', ['-C', to, 'status', '--porcelain', '-uall']);
    return { files: status.stdout.split('\n').filter(Boolean).length };
  }

  /** Why the worktree must be kept, or null when it is safe to remove. */
  async keepReason(info: WorktreeInfo): Promise<string | null> {
    const status = await run('git', ['-C', info.path, 'status', '--porcelain']);
    if (status.code !== 0) return `cannot read git status (${status.stderr.trim()})`;
    if (status.stdout.trim()) return 'it has uncommitted changes';
    const ahead = await run('git', ['-C', info.path, 'rev-list', '--count', `${info.baseRef}..HEAD`]);
    if (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) return `branch ${info.branch} has commits not in the base`;
    return null;
  }

  /** Removes only a clean worktree with no new commits; never forces. */
  async removeIfClean(info: WorktreeInfo): Promise<{ removed: boolean; reason?: string }> {
    const reason = await this.keepReason(info);
    if (reason) return { removed: false, reason };
    const r = await run('git', ['-C', info.parentRepo, 'worktree', 'remove', info.path]);
    if (r.code !== 0) return { removed: false, reason: r.stderr.trim() };
    // keepReason found nothing past baseRef, so nothing is lost. `-d` would refuse a branch that isn't merged into the
    // parent's HEAD, which a branch started from another agent's commit (a fork) usually isn't.
    await run('git', ['-C', info.parentRepo, 'branch', '-D', info.branch]);
    return { removed: true };
  }
}
