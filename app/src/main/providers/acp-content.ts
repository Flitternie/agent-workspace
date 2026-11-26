// ACP session updates → provider-neutral content (src/shared/content.ts), which was shaped after
// ACP in the first place: tool kinds and permission option kinds carry over as they are; diffs
// (whole old/new texts in ACP) become hunks with line numbers; plans keep their entries.
import { clipOutput, lineDiffHunks, makeDiff, wholeFileHunks, type FileDiff, type PlanEntry, type ToolCallInfo, type ToolContent, type ToolKind } from '../../shared/content';
import type { ToolStatus } from '../../shared/types';
import { displayPath, firstLine } from './claude-content';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const KINDS: ToolKind[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];

/** A tool call as the agent has described it so far (`tool_call`, then `tool_call_update`s). */
export interface AcpTool {
  id: string;
  title: string;
  name?: string;
  kind: ToolKind;
  status: string;
  content: unknown[];
  locations: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** Fields given in an update replace the stored ones (content and locations as whole lists, per ACP). */
export function mergeAcpTool(prev: AcpTool | undefined, u: Rec): AcpTool {
  const kind = KINDS.includes(u.kind as ToolKind) ? (u.kind as ToolKind) : undefined;
  return {
    id: str(u.toolCallId) || prev?.id || '',
    title: str(u.title) || prev?.title || '',
    name: str(u.name) || prev?.name,
    kind: kind ?? prev?.kind ?? 'other',
    status: str(u.status) || prev?.status || 'pending',
    content: Array.isArray(u.content) ? keepDiffs(prev?.content ?? [], u.content) : (prev?.content ?? []),
    locations: Array.isArray(u.locations) ? u.locations : (prev?.locations ?? []),
    rawInput: u.rawInput !== undefined && u.rawInput !== null ? u.rawInput : prev?.rawInput,
    rawOutput: u.rawOutput !== undefined && u.rawOutput !== null ? u.rawOutput : prev?.rawOutput,
  };
}

/**
 * A later update's content replaces the earlier (ACP), but CLIs send the diff only while asking
 * permission and then just a result line (OpenCode: "Created file successfully"): the diff is kept.
 */
function keepDiffs(prev: unknown[], next: unknown[]): unknown[] {
  if (next.some((c) => rec(c).type === 'diff')) return next;
  const diffs = prev.filter((c) => rec(c).type === 'diff');
  return diffs.length ? [...diffs, ...next] : next;
}

const pick = (o: Rec, keys: string[]): unknown => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);

/** A diff from a file tool's input when the CLI sent none (a whole file written, or one replacement). */
function inputDiff(t: AcpTool): Rec | undefined {
  if (t.kind !== 'edit') return undefined;
  const input = rec(t.rawInput);
  const path = pick(input, ['filePath', 'file_path', 'path', 'Path', 'TargetFile', 'AbsolutePath']);
  if (typeof path !== 'string' || !path) return undefined;
  const oldText = pick(input, ['oldString', 'old_string', 'TargetContent']);
  const newText = pick(input, ['newString', 'new_string', 'ReplacementContent']);
  if (typeof oldText === 'string' && typeof newText === 'string') return { type: 'diff', path, oldText, newText };
  const content = pick(input, ['content', 'Content', 'CodeContent']);
  if (typeof content === 'string') return { type: 'diff', path, oldText: null, newText: content };
  return undefined;
}

export function acpToolStatus(status: string, history = false): ToolStatus {
  const s: ToolStatus = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'running';
  return history && s === 'running' ? 'interrupted' : s;
}

/** Text of a content block (text, or what a resource stands for). */
export function acpBlockText(block: unknown): string {
  const b = rec(block);
  if (b.type === 'text') return str(b.text);
  if (b.type === 'resource_link') return str(b.title) || str(b.name) || str(b.uri);
  if (b.type === 'resource') return str(rec(b.resource).text) || str(rec(b.resource).uri);
  if (b.type === 'image') return '[image]';
  return '';
}

export function acpDiff(d: Rec, phase: FileDiff['phase'], cwd: string): FileDiff {
  const path = displayPath(str(d.path), cwd);
  const oldText = typeof d.oldText === 'string' ? d.oldText : null;
  const newText = str(d.newText);
  if (oldText === null) return makeDiff({ path, operation: 'add', phase, hunks: wholeFileHunks(newText, '+') });
  return makeDiff({ path, operation: 'modify', phase, hunks: lineDiffHunks(oldText, newText) });
}

/** The command an execute tool runs, from its input (`command` as text or argv) or its title. */
export function commandOf(t: AcpTool): string {
  const input = rec(t.rawInput);
  const c = input.command ?? input.cmd ?? input.CommandLine;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return t.title;
}

function outputOf(t: AcpTool, texts: string[]): { output: string; exitCode?: number } {
  const raw = rec(t.rawOutput);
  const meta = rec(raw.metadata);
  let exit = [raw.exitCode, raw.exit_code, meta.exit, meta.exitCode].find((v) => typeof v === 'number') as number | undefined;
  let output = (texts.join('\n') || str(raw.output) || [str(raw.stdout), str(raw.stderr)].filter(Boolean).join('\n') || (typeof t.rawOutput === 'string' ? t.rawOutput : '')).replace(/\r\n/g, '\n');
  // Antigravity puts a header before the output: "Created At: …\nCompleted At: …\nCommand exited with code 0.\n\nCommand output:\n".
  const header = /^Created At:[^\n]*\n(?:Completed At:[^\n]*\n)?(?:Command exited with code (-?\d+)\.\n)?\n?Command output:\n/.exec(output);
  if (header) {
    output = output.slice(header[0].length);
    if (exit === undefined && header[1]) exit = Number(header[1]);
  }
  return { output: clipOutput(output), exitCode: exit };
}

export function acpToolInfo(t: AcpTool, cwd: string): ToolCallInfo {
  const phase: FileDiff['phase'] = t.status === 'completed' ? 'applied' : 'proposed';
  const texts: string[] = [];
  const content: ToolContent[] = [];
  const given = arr(t.content).map(rec);
  const synth = given.some((c) => c.type === 'diff') ? undefined : inputDiff(t);
  for (const c of synth ? [synth, ...given] : given) {
    if (c.type === 'diff') content.push({ type: 'diff', diff: acpDiff(c, phase, cwd) });
    else if (c.type === 'content') {
      const text = acpBlockText(c.content);
      if (text) texts.push(text);
    }
    // 'terminal' content points at a client terminal: never created here (no terminal capability).
  }
  if (t.kind === 'execute') {
    const { output, exitCode } = outputOf(t, texts);
    content.unshift({ type: 'terminal', command: commandOf(t), output, ...(exitCode !== undefined ? { exitCode } : {}) });
  } else if (texts.length) content.push({ type: 'text', text: clipOutput(texts.join('\n\n')) });
  const locations = arr(t.locations)
    .map(rec)
    .filter((l) => str(l.path))
    .map((l) => ({ path: displayPath(str(l.path), cwd), ...(typeof l.line === 'number' ? { line: l.line } : {}) }));
  const title = t.kind === 'execute' && !t.title ? `$ ${firstLine(commandOf(t))}` : t.title || t.name || t.kind;
  return { name: t.name || t.kind, kind: t.kind, title, locations, content };
}

/** The approval card's headline for a permission request about this tool. */
export function acpApprovalHeadline(t: AcpTool, cwd: string): string {
  if (t.kind === 'execute') return `Run command: ${firstLine(commandOf(t)) || '(command)'}`;
  const paths = [...new Set([...arr(t.content).map(rec).filter((c) => c.type === 'diff').map((c) => str(c.path)), ...arr(t.locations).map((l) => str(rec(l).path))].filter(Boolean))];
  if (t.kind === 'edit' || t.kind === 'delete' || t.kind === 'move')
    return `${t.kind === 'delete' ? 'Delete' : t.kind === 'move' ? 'Move' : 'Apply changes to'} ${paths.length === 1 ? displayPath(paths[0], cwd) : paths.length ? `${paths.length} files` : t.title || 'files'}`;
  return t.title || 'Permission request';
}

export function acpPlan(entries: unknown): PlanEntry[] {
  return arr(entries)
    .map(rec)
    .filter((e) => str(e.content))
    .map((e) => ({ content: str(e.content), status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending' }));
}

const READ_ONLY = new Set(['echo', 'printf', 'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'which', 'whoami', 'date', 'file', 'stat', 'du', 'df', 'tree', 'uname', 'env', 'true']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'remote']);

/**
 * A command that only looks (for "Decide automatically" on an agent without permission modes of its
 * own): one plain read-only command (or git subcommand), no shell syntax that could chain, redirect
 * or substitute anything. Everything else is for the user.
 */
export function readOnlyCommand(command: string): boolean {
  const c = command.trim();
  if (!c || /[;&|<>`$(){}\\\n*?]/.test(c)) return false;
  const words = c.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const [head, sub] = words;
  if (head === 'git') return !!sub && READ_ONLY_GIT.has(sub) && !words.some((w) => /^--(output|exec)/.test(w));
  if (head === 'find') return false;
  return READ_ONLY.has(head ?? '');
}
