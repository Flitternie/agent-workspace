import { describe, expect, it } from 'vitest';
import { makeDiff, parseGitPatch, parseUnifiedHunks, snippetHunks } from '../../src/shared/content';
import { ClaudePlanTracker, claudeToolCall, claudeToolResult } from '../../src/main/providers/claude-content';
import { codexFileDiff, codexItem, codexPlan } from '../../src/main/providers/codex-content';

const cwd = '/repo';

describe('diff helpers', () => {
  it('parses a unified diff with headers into numbered hunks and true totals', () => {
    const hunks = parseUnifiedHunks('--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n\\ No newline at end of file\n');
    expect(hunks).toEqual([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' a', '-b', '+B', '+C', ' c'] }]);
    const d = makeDiff({ path: 'x.ts', operation: 'modify', phase: 'applied', hunks });
    expect([d.added, d.removed, d.truncated]).toEqual([2, 1, undefined]);
  });

  it('caps carried lines but keeps the real counts', () => {
    const big = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1000, lines: Array.from({ length: 1000 }, (_, i) => `+l${i}`) };
    const d = makeDiff({ path: 'big', operation: 'add', phase: 'applied', hunks: [big] });
    expect(d.added).toBe(1000);
    expect(d.hunks[0].lines.length).toBe(400);
    expect(d.truncated).toBe(true);
  });

  it('turns an old/new replacement into a snippet with shared context', () => {
    expect(snippetHunks('a\nb\nc', 'a\nX\nc')[0].lines).toEqual([' a', '-b', '+X', ' c']);
  });

  it('splits a git patch into per-file diffs, detecting new and moved files', () => {
    const patch = 'diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\ndiff --git a/o.ts b/p.ts\nsimilarity index 90%\n@@ -1 +1 @@\n-a\n+b\n';
    const files = parseGitPatch(patch, 'applied');
    expect(files.map((f) => [f.path, f.operation, f.added, f.removed])).toEqual([
      ['n.ts', 'add', 1, 0],
      ['p.ts', 'move', 1, 1],
    ]);
  });
});

describe('Claude → unified content', () => {
  it('Edit: proposed snippet diff from the input, applied diff with line numbers from tool_use_result', () => {
    const input = { file_path: '/repo/src/a.ts', old_string: 'return [];', new_string: 'return items;' };
    const call = claudeToolCall('Edit', input, cwd);
    expect(call).toMatchObject({ kind: 'edit', title: 'Edit src/a.ts' });
    const proposed = call.content[0];
    expect(proposed.type === 'diff' && proposed.diff).toMatchObject({ phase: 'proposed', snippet: true, added: 1, removed: 1 });

    const applied = claudeToolResult(
      'Edit',
      input,
      { filePath: '/repo/src/a.ts', structuredPatch: [{ oldStart: 4, oldLines: 3, newStart: 4, newLines: 3, lines: [' x', '-return [];', '+return items;', ' }'] }], originalFile: '' },
      'ok',
      false,
      cwd,
    );
    expect(applied?.[0].type === 'diff' && applied[0].diff).toMatchObject({ path: 'src/a.ts', phase: 'applied', operation: 'modify', added: 1, removed: 1 });
  });

  it('Write create with an empty patch shows the whole new file', () => {
    const r = claudeToolResult('Write', { file_path: '/repo/new.md', content: 'a\nb\n' }, { type: 'create', filePath: '/repo/new.md', content: 'a\nb\n', structuredPatch: [] }, '', false, cwd);
    expect(r?.[0].type === 'diff' && r[0].diff).toMatchObject({ operation: 'add', added: 2, removed: 0 });
  });

  it('Bash: terminal content from stdout/stderr; Grep: search content', () => {
    const call = claudeToolCall('Bash', { command: 'npm test' }, cwd);
    expect(call).toMatchObject({ kind: 'execute', title: '$ npm test' });
    const r = claudeToolResult('Bash', { command: 'npm test' }, { stdout: 'ok', stderr: 'warn', interrupted: false }, '', false, cwd);
    expect(r?.[0]).toMatchObject({ type: 'terminal', command: 'npm test', output: 'ok\nwarn' });
    const g = claudeToolResult('Grep', { pattern: 'TODO' }, { filenames: ['/repo/a.ts', '/repo/b.ts'], numFiles: 2 }, '', false, cwd);
    expect(g?.[0]).toMatchObject({ type: 'search', query: 'TODO', files: ['a.ts', 'b.ts'], total: 2 });
  });

  it('a failed edit keeps the proposed diff instead of replacing it', () => {
    expect(claudeToolResult('Edit', { file_path: '/repo/a.ts' }, undefined, 'String not found', true, cwd)).toBeUndefined();
  });

  it('plans: TodoWrite is a snapshot; TaskCreate/TaskUpdate are incremental by id', () => {
    const t = new ClaudePlanTracker();
    expect(
      t.onToolUse('1', 'TodoWrite', { todos: [{ content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' }, { content: 'Ship', status: 'pending' }] }),
    ).toEqual([
      { id: '0', content: 'Writing tests', status: 'in_progress' },
      { id: '1', content: 'Ship', status: 'pending' },
    ]);
    const p = new ClaudePlanTracker();
    p.onToolUse('c1', 'TaskCreate', { subject: 'Add API', description: '' });
    expect(p.onToolResult('c1', 'TaskCreate', { task: { id: '7', subject: 'Add API' } })).toEqual([{ id: '7', content: 'Add API', status: 'pending' }]);
    expect(p.onToolUse('u1', 'TaskUpdate', { taskId: '7', status: 'completed' })).toEqual([{ id: '7', content: 'Add API', status: 'completed' }]);
    expect(p.onToolUse('u2', 'TaskUpdate', { taskId: '7', status: 'deleted' })).toEqual([]);
  });
});

describe('Codex → unified content', () => {
  it('fileChange add has no @@ header: whole file as additions; update with move_path is a move', () => {
    expect(codexFileDiff({ path: '/repo/n.txt', kind: { type: 'add' }, diff: 'hello\nworld\n' }, 'applied', cwd)).toMatchObject({ path: 'n.txt', operation: 'add', added: 2 });
    const mv = codexFileDiff({ path: '/repo/a.ts', kind: { type: 'update', move_path: '/repo/b.ts' }, diff: '@@ -1 +1 @@\n-x\n+y\n' }, 'proposed', cwd);
    expect(mv).toMatchObject({ path: 'b.ts', oldPath: 'a.ts', operation: 'move', phase: 'proposed', added: 1, removed: 1 });
  });

  it('fileChange item: proposed until completed, edit kind and title', () => {
    const v = codexItem({ id: 'i1', type: 'fileChange', status: 'inProgress', changes: [{ path: '/repo/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] }, { history: false, completed: false, cwd });
    expect(v?.tool).toMatchObject({ kind: 'edit', title: 'Edit a.ts' });
    const c = v?.tool?.content[0];
    expect(c?.type === 'diff' && c.diff.phase).toBe('proposed');
    const done = codexItem({ id: 'i1', type: 'fileChange', status: 'completed', changes: [] }, { history: false, completed: true, cwd });
    expect(done?.status).toBe('completed');
  });

  it('commandExecution uses commandActions to classify reads vs commands', () => {
    const read = codexItem(
      { id: 'c1', type: 'commandExecution', command: "sed -n 1,80p src/a.ts", status: 'completed', exitCode: 0, aggregatedOutput: 'x', commandActions: [{ type: 'read', command: 'sed', name: 'a.ts', path: '/repo/src/a.ts' }] },
      { history: false, completed: true, cwd },
    );
    expect(read?.tool).toMatchObject({ kind: 'read', title: 'Read src/a.ts' });
    const run = codexItem(
      { id: 'c2', type: 'commandExecution', command: 'npm test', status: 'failed', exitCode: 1, aggregatedOutput: 'FAIL', commandActions: [{ type: 'unknown', command: 'npm test' }] },
      { history: false, completed: true, cwd },
    );
    expect(run?.status).toBe('failed');
    expect(run?.tool?.content[0]).toMatchObject({ type: 'terminal', command: 'npm test', output: 'FAIL', exitCode: 1 });
  });

  it('reasoning → thought, plan item → proposal, turn plan → checklist with camelCase status', () => {
    expect(codexItem({ id: 'r', type: 'reasoning', summary: ['Look at tests'] }, { history: false, completed: true, cwd })).toMatchObject({ role: 'thought', text: 'Look at tests' });
    expect(codexItem({ id: 'p', type: 'plan', text: '1. Do it' }, { history: false, completed: true, cwd })).toMatchObject({ role: 'plan' });
    expect(codexPlan([{ step: 'A', status: 'completed' }, { step: 'B', status: 'inProgress' }, { step: 'C', status: 'pending' }]).map((e) => e.status)).toEqual(['completed', 'in_progress', 'pending']);
  });
});
