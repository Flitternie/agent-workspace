import { clipOutput, makeDiff, parseUnifiedHunks, snippetHunks, wholeFileHunks, type FileDiff, type ToolCallInfo, type ToolContent } from '../../shared/content';
import { displayPath, firstLine } from './claude-content';
import type { ProviderEvent } from './types';

type Rec = Record<string, unknown>;
export const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {});
export const str = (v: unknown): string => typeof v === 'string' ? v : '';
export const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

export const openCodeToolId = (messageID: string, callID: string): string => `oc-tool-${messageID}-${callID}`;

/** OpenCode versions supply either before/after snapshots or a unified patch. */
export function openCodeDiff(value: unknown, phase: FileDiff['phase'], cwd: string): FileDiff {
  const v = rec(value);
  const path = displayPath(str(v.file) || str(v.filePath) || str(v.path), cwd);
  const operation = v.status === 'added' || v.type === 'add' ? 'add' : v.status === 'deleted' || v.type === 'delete' ? 'delete' : 'modify';
  const patch = str(v.patch) || str(v.diff);
  const before = str(v.before);
  const after = str(v.after);
  return makeDiff({ path, operation, phase, snippet: !patch || undefined, hunks: patch ? parseUnifiedHunks(patch) : operation === 'add' ? wholeFileHunks(after, '+') : operation === 'delete' ? wholeFileHunks(before, '-') : snippetHunks(before, after) });
}

/** Message parts become stable, upsertable transcript items; live user echoes are omitted. */
export function openCodePart(value: unknown, role: string, cwd: string, history = false): ProviderEvent | undefined {
  const p = rec(value);
  if (!str(p.id) || p.synthetic || p.ignored || (role !== 'assistant' && !(history && role === 'user'))) return;
  if (p.type === 'text' || p.type === 'reasoning') {
    return { type: 'transcriptItem', itemId: `oc-${str(p.id)}`, role: role === 'user' ? 'user' : p.type === 'reasoning' ? 'thought' : 'assistant', text: str(p.text), history };
  }
  if (p.type !== 'tool') return;
  const state = rec(p.state);
  const input = rec(state.input);
  const metadata = rec(state.metadata);
  const name = str(p.tool);
  const path = str(input.filePath) || str(input.path);
  const output = str(state.output) || str(state.error) || str(metadata.output);
  const content: ToolContent[] = [];
  let kind: ToolCallInfo['kind'] = 'other';
  let title = str(state.title) || name;
  if (name === 'bash' || name === 'shell') {
    kind = 'execute';
    title = `$ ${firstLine(str(input.command))}`;
    content.push({ type: 'terminal', command: str(input.command), cwd: str(input.workdir) || cwd, output: clipOutput(output), exitCode: typeof metadata.exit === 'number' ? metadata.exit : undefined });
  } else if (['edit', 'write', 'apply_patch', 'patch'].includes(name)) {
    kind = 'edit';
    title = `${name === 'write' ? 'Write' : 'Edit'} ${displayPath(path, cwd) || str(state.title) || 'files'}`;
    const phase = state.status === 'completed' ? 'applied' : 'proposed';
    const files = arr(metadata.files);
    if (files.length) content.push(...files.map((file): ToolContent => ({ type: 'diff', diff: openCodeDiff(file, phase, cwd) })));
    else if (metadata.filediff) content.push({ type: 'diff', diff: openCodeDiff(metadata.filediff, phase, cwd) });
    else if (str(metadata.diff)) content.push({ type: 'diff', diff: openCodeDiff({ file: path, diff: metadata.diff, status: metadata.exists === false ? 'added' : 'modified' }, phase, cwd) });
    else if (path && (name === 'edit' || (name === 'write' && (state.status !== 'completed' || metadata.exists === false)))) {
      // A completed overwrite with no before/patch cannot yield an honest diff.
      // New files and Edit snippets can; failed attempts remain proposals.
      content.push({ type: 'diff', diff: openCodeDiff({ file: path, before: input.oldString, after: name === 'write' ? input.content : input.newString, status: name === 'write' ? 'added' : 'modified' }, phase, cwd) });
    }
    if (output && (!content.length || state.status === 'error')) content.push({ type: 'text', text: clipOutput(output), format: 'plain' });
  } else {
    kind = name === 'read' ? 'read' : ['grep', 'glob', 'list'].includes(name) ? 'search' : ['webfetch', 'websearch'].includes(name) ? 'fetch' : 'other';
    if (path) title = `${name} ${displayPath(path, cwd)}`;
    if (output) content.push({ type: 'text', text: clipOutput(output), format: 'plain' });
  }
  return {
    type: 'transcriptItem', itemId: openCodeToolId(str(p.messageID), str(p.callID)), role: 'tool', text: '', history,
    toolStatus: state.status === 'completed' ? 'completed' : state.status === 'error' ? 'failed' : history ? 'interrupted' : 'running',
    tool: { name, kind, title, locations: path ? [{ path }] : [], content },
  };
}

export function openCodeHistory(messages: unknown, cwd: string): ProviderEvent[] {
  return arr(messages).flatMap((message) => {
    const m = rec(message);
    return arr(m.parts).flatMap((part) => {
      const event = openCodePart(part, str(rec(m.info).role), cwd, true);
      return event ? [event] : [];
    });
  });
}
