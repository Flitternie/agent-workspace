import { mkdirSync } from 'node:fs';
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

  async create(repoRoot: string, projectId: string, slug: string): Promise<WorktreeInfo> {
    const head = await run('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0) throw new Error('The repository has no commits yet, so a worktree cannot be created.');
    const baseRef = head.stdout.trim();
    const branch = `amw/${slug}`;
    const path = join(this.baseDir, projectId, slug);
    mkdirSync(dirname(path), { recursive: true });
    const r = await run('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, path, baseRef]);
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return { path, branch, baseRef, parentRepo: repoRoot };
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
    await run('git', ['-C', info.parentRepo, 'branch', '-d', info.branch]);
    return { removed: true };
  }
}
