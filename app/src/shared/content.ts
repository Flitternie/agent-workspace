// Provider-neutral structured content for tool calls, diffs, plans and decisions.
// Shaped after the Agent Client Protocol (ACP, Apache-2.0: tool call kinds,
// diff / terminal content, plan entries, permission option kinds), with ACP v2's
// lesson applied: diffs keep real hunks and line numbers, not just old/new text.
// Both the Claude and Codex adapters emit only these types; the UI renders only these.

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** ' ', '-' or '+' prefixed lines (Claude's structuredPatch shape). */
  lines: string[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  operation: 'add' | 'delete' | 'modify' | 'move';
  /** proposed = from the tool input / pending approval; applied = after the change ran. */
  phase: 'proposed' | 'applied';
  hunks: DiffHunk[];
  /** Hunks have no real line numbers (e.g. a Claude Edit input before it runs). */
  snippet?: boolean;
  /** True totals even if hunks were truncated. */
  added: number;
  removed: number;
  truncated?: boolean;
}

export type ToolContent =
  | { type: 'text'; text: string; format?: 'markdown' | 'plain' }
  | { type: 'diff'; diff: FileDiff }
  | { type: 'terminal'; command: string; cwd?: string; output: string; exitCode?: number; interrupted?: boolean; background?: boolean }
  | { type: 'search'; query: string; path?: string; files: string[]; matches?: string; total?: number; truncated?: boolean }
  | { type: 'fetch'; url?: string; query?: string; status?: number; results?: Array<{ title: string; url: string }>; summary?: string };

export interface ToolCallInfo {
  /** Provider tool name, e.g. "Edit", "Bash", "commandExecution". */
  name: string;
  kind: ToolKind;
  /** Human title, e.g. "Edit src/orders.ts" or "$ npm test". */
  title: string;
  locations: Array<{ path: string; line?: number }>;
  content: ToolContent[];
  /** Typed by the user as `!command`, not run by the agent. */
  byUser?: boolean;
}

export interface PlanEntry {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Live checklist of what the agent is doing (TodoWrite / Task* / Codex turn plan). */
export interface PlanInfo {
  entries: PlanEntry[];
  explanation?: string;
  updatedAt: string;
}

export type PermissionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

// ------------------------------------------------------------------ diff helpers

export const MAX_DIFF_LINES = 400;
export const MAX_OUTPUT_CHARS = 8000;

function count(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  return { added, removed };
}

/** Caps carried lines while keeping the true +/- totals. */
export function capHunks(hunks: DiffHunk[], max = MAX_DIFF_LINES): { hunks: DiffHunk[]; truncated: boolean } {
  let left = max;
  const out: DiffHunk[] = [];
  for (const h of hunks) {
    if (left <= 0) return { hunks: out, truncated: true };
    const lines = h.lines.slice(0, left);
    left -= lines.length;
    out.push({ ...h, lines });
    if (lines.length < h.lines.length) return { hunks: out, truncated: true };
  }
  return { hunks: out, truncated: false };
}

export function makeDiff(base: Omit<FileDiff, 'added' | 'removed' | 'truncated'>): FileDiff {
  const totals = count(base.hunks);
  const capped = capHunks(base.hunks);
  return { ...base, hunks: capped.hunks, ...totals, truncated: capped.truncated || undefined };
}

/** Whole file as additions (new file) or deletions. */
export function wholeFileHunks(content: string, sign: '+' | '-'): DiffHunk[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (!content) return [];
  return [
    sign === '+'
      ? { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }
      : { oldStart: 1, oldLines: lines.length, newStart: 0, newLines: 0, lines: lines.map((l) => `-${l}`) },
  ];
}

/** old → new replacement without line numbers (proposed Claude Edit). */
export function snippetHunks(oldText: string, newText: string): DiffHunk[] {
  const a = oldText ? oldText.replace(/\r\n/g, '\n').split('\n') : [];
  const b = newText ? newText.replace(/\r\n/g, '\n').split('\n') : [];
  // Trim shared leading/trailing lines into context so the change stands out.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const lines = [
    ...a.slice(0, pre).map((l) => ` ${l}`),
    ...a.slice(pre, a.length - post).map((l) => `-${l}`),
    ...b.slice(pre, b.length - post).map((l) => `+${l}`),
    ...a.slice(a.length - post).map((l) => ` ${l}`),
  ];
  return [{ oldStart: 0, oldLines: a.length, newStart: 0, newLines: b.length, lines }];
}

/**
 * A file's old and new text → hunks with real line numbers and `context` lines around each change
 * (ACP diffs carry whole texts). Lines diffed by LCS between the shared head and tail; a middle
 * too large for that shows as replaced.
 */
export function lineDiffHunks(oldText: string, newText: string, context = 3): DiffHunk[] {
  const split = (s: string) => (s ? s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []);
  const a = split(oldText);
  const b = split(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const am = a.slice(pre, a.length - post);
  const bm = b.slice(pre, b.length - post);
  const ops: string[] = a.slice(0, pre).map((l) => ` ${l}`);
  if (am.length && bm.length && am.length * bm.length <= 4_000_000) {
    const n = am.length;
    const m = bm.length;
    const w = m + 1;
    // lcs[i][j]: common lines of am[i..] and bm[j..].
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push(` ${am[i++]}`);
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) ops.push(`-${am[i++]}`);
      else ops.push(`+${bm[j++]}`);
    }
    while (i < n) ops.push(`-${am[i++]}`);
    while (j < m) ops.push(`+${bm[j++]}`);
  } else ops.push(...am.map((l) => `-${l}`), ...bm.map((l) => `+${l}`));
  ops.push(...a.slice(a.length - post).map((l) => ` ${l}`));
  // Changed positions, widened by the context and merged where they touch.
  const ranges: Array<[number, number]> = [];
  ops.forEach((op, k) => {
    if (op[0] === ' ') return;
    const lo = Math.max(0, k - context);
    const hi = Math.min(ops.length, k + context + 1);
    const last = ranges.at(-1);
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  });
  const hunks: DiffHunk[] = [];
  let k = 0;
  let oldLine = 1;
  let newLine = 1;
  const step = () => {
    if (ops[k][0] !== '+') oldLine++;
    if (ops[k][0] !== '-') newLine++;
    k++;
  };
  for (const [lo, hi] of ranges) {
    while (k < lo) step();
    const lines = ops.slice(lo, hi);
    const oldLines = lines.filter((l) => l[0] !== '+').length;
    const newLines = lines.filter((l) => l[0] !== '-').length;
    hunks.push({ oldStart: oldLines ? oldLine : oldLine - 1, oldLines, newStart: newLines ? newLine : newLine - 1, newLines, lines });
    while (k < hi) step();
  }
  return hunks;
}

/**
 * Parses a unified diff body (with or without ---/+++ headers) into hunks.
 * Text without any @@ header is not a patch; callers decide what it means.
 */
export function parseUnifiedHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of diff.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // headers before the first hunk
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) cur.lines.push(line);
    else if (line === '') cur.lines.push(' ');
  }
  return hunks;
}

/** Splits a multi-file git patch into per-file diffs. */
export function parseGitPatch(patch: string, phase: FileDiff['phase']): FileDiff[] {
  const files: FileDiff[] = [];
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git')) continue;
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const oldPath = header?.[1];
    const path = header?.[2] ?? oldPath ?? 'unknown';
    const operation = /^new file mode/m.test(chunk) ? 'add' : /^deleted file mode/m.test(chunk) ? 'delete' : oldPath && oldPath !== path ? 'move' : 'modify';
    files.push(makeDiff({ path, oldPath: operation === 'move' ? oldPath : undefined, operation, phase, hunks: parseUnifiedHunks(chunk) }));
  }
  return files;
}

export function diffStat(diffs: FileDiff[]): { added: number; removed: number; files: number } {
  return diffs.reduce((s, d) => ({ added: s.added + d.added, removed: s.removed + d.removed, files: s.files + 1 }), { added: 0, removed: 0, files: 0 });
}

export function clipOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length > max ? `… ${text.length - max} earlier characters omitted …\n${text.slice(-max)}` : text;
}
