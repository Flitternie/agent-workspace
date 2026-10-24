// Claude Agent SDK tool calls → provider-neutral content (src/shared/content.ts).
// Mapping follows claude-code-acp's tool reporters (Apache-2.0) and the SDK's
// sdk-tools.d.ts output types: proposed diffs come from the tool input, applied
// diffs from `tool_use_result.structuredPatch`.
import { relative, isAbsolute } from 'node:path';
import {
  clipOutput,
  makeDiff,
  snippetHunks,
  wholeFileHunks,
  type DiffHunk,
  type PlanEntry,
  type ToolCallInfo,
  type ToolContent,
  type ToolKind,
} from '../../shared/content';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Newer CLIs accept aliases (path, file_text…); read inputs defensively. */
const filePath = (i: Rec) => str(i.file_path) || str(i.path) || str(i.notebook_path);
const fileContent = (i: Rec) => str(i.content) || str(i.file_text) || str(i.file_content);

/** First line of a multi-line command (heredocs, scripts), marked as truncated. */
export function firstLine(command: string): string {
  const [head, ...rest] = command.trim().split('\n');
  return rest.length ? `${head} …` : head;
}

export function displayPath(path: string, cwd: string): string {
  if (!path) return '';
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

const KIND: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  TodoWrite: 'think',
  TaskCreate: 'think',
  TaskUpdate: 'think',
  TaskList: 'think',
  TaskGet: 'think',
  Agent: 'think',
  Task: 'think',
  ToolSearch: 'think',
  ExitPlanMode: 'switch_mode',
  EnterPlanMode: 'switch_mode',
};

/** What the call is about to do, from its input (also used as the approval preview). */
export function claudeToolCall(name: string, input: Rec, cwd: string): ToolCallInfo {
  const kind = KIND[name] ?? 'other';
  const path = filePath(input);
  const shown = displayPath(path, cwd);
  const locations = path ? [{ path, line: num(input.offset) }] : [];
  const content: ToolContent[] = [];
  let title = name;
  switch (name) {
    case 'Read':
      title = `Read ${shown}${input.offset ? `:${input.offset}` : ''}`;
      break;
    case 'Edit':
      title = `Edit ${shown}`;
      content.push({ type: 'diff', diff: makeDiff({ path: shown, operation: 'modify', phase: 'proposed', snippet: true, hunks: snippetHunks(str(input.old_string), str(input.new_string)) }) });
      break;
    case 'MultiEdit': {
      title = `Edit ${shown}`;
      const hunks = arr(input.edits).flatMap((e) => snippetHunks(str(rec(e).old_string), str(rec(e).new_string)));
      content.push({ type: 'diff', diff: makeDiff({ path: shown, operation: 'modify', phase: 'proposed', snippet: true, hunks }) });
      break;
    }
    case 'Write':
      title = `Write ${shown}`;
      // Create vs overwrite is only known from the result.
      content.push({ type: 'diff', diff: makeDiff({ path: shown, operation: 'add', phase: 'proposed', hunks: wholeFileHunks(fileContent(input), '+') }) });
      break;
    case 'NotebookEdit':
      title = `Edit notebook ${shown}`;
      break;
    case 'Bash': {
      const command = str(input.command);
      // Claude writes a short description for each command ("Run unit tests"); prefer it.
      title = str(input.description) || `$ ${firstLine(command)}`;
      content.push({ type: 'terminal', command, output: '', background: input.run_in_background === true });
      break;
    }
    case 'Grep':
      title = `Search “${str(input.pattern)}”${input.path ? ` in ${displayPath(str(input.path), cwd)}` : ''}`;
      break;
    case 'Glob':
      title = `Find ${str(input.pattern)}${input.path ? ` in ${displayPath(str(input.path), cwd)}` : ''}`;
      break;
    case 'WebFetch':
      title = `Fetch ${str(input.url)}`;
      break;
    case 'WebSearch':
      title = `Web search: ${str(input.query)}`;
      break;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      title = 'Update plan';
      break;
    case 'ToolSearch':
      title = `Look up tools${str(input.query) ? `: ${str(input.query)}` : ''}`;
      break;
    case 'ExitPlanMode':
      title = 'Ready to code — proposed plan';
      if (str(input.plan)) content.push({ type: 'text', text: str(input.plan), format: 'markdown' });
      break;
    case 'Agent':
    case 'Task':
      title = `Subagent: ${str(input.description) || str(input.subagent_type) || 'task'}`;
      break;
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        title = `${server} / ${tool}`;
      } else title = `${name}${shown ? ` ${shown}` : ''}`;
  }
  return { name, kind, title, locations, content };
}

/** What the call actually did, from `tool_use_result` (falls back to the text result). */
export function claudeToolResult(name: string, input: Rec, result: unknown, text: string, isError: boolean, cwd: string): ToolContent[] | undefined {
  const r = rec(result);
  const hasStructured = typeof result === 'object' && result !== null;
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      if (isError || !hasStructured) return undefined; // keep the proposed diff; the text result explains the error
      const path = displayPath(str(r.filePath) || filePath(input), cwd);
      let hunks = arr(r.structuredPatch).map((h) => {
        const x = rec(h);
        return { oldStart: num(x.oldStart) ?? 0, oldLines: num(x.oldLines) ?? 0, newStart: num(x.newStart) ?? 0, newLines: num(x.newLines) ?? 0, lines: arr(x.lines).map(str) } satisfies DiffHunk;
      });
      const created = str(r.type) === 'create';
      if (!hunks.length && created) hunks = wholeFileHunks(str(r.content) || fileContent(input), '+');
      return [{ type: 'diff', diff: makeDiff({ path, operation: created ? 'add' : 'modify', phase: 'applied', hunks }) }];
    }
    case 'Bash': {
      const out = hasStructured ? [str(r.stdout), str(r.stderr)].filter(Boolean).join('\n') : text;
      return [
        {
          type: 'terminal',
          command: str(input.command),
          output: clipOutput(out),
          interrupted: r.interrupted === true || undefined,
          background: !!r.backgroundTaskId || undefined,
          exitCode: isError ? 1 : undefined,
        },
      ];
    }
    case 'Grep':
      if (!hasStructured) break;
      return [
        {
          type: 'search',
          query: str(input.pattern),
          path: str(input.path) || undefined,
          files: arr(r.filenames).map((f) => displayPath(str(f), cwd)).slice(0, 50),
          matches: str(r.content) ? clipOutput(str(r.content), 4000) : undefined,
          total: num(r.numFiles),
          truncated: arr(r.filenames).length > 50 || undefined,
        },
      ];
    case 'Glob':
      if (!hasStructured) break;
      return [
        {
          type: 'search',
          query: str(input.pattern),
          path: str(input.path) || undefined,
          files: arr(r.filenames).map((f) => displayPath(str(f), cwd)).slice(0, 50),
          total: num(r.numFiles),
          truncated: r.truncated === true || arr(r.filenames).length > 50 || undefined,
        },
      ];
    case 'WebFetch':
      if (!hasStructured) break;
      return [{ type: 'fetch', url: str(r.url) || str(input.url), status: num(r.code), summary: clipOutput(str(r.result), 3000) }];
    case 'WebSearch': {
      if (!hasStructured) break;
      const results = arr(r.results).flatMap((x) => arr(rec(x).content)).map((c) => ({ title: str(rec(c).title), url: str(rec(c).url) }));
      return [{ type: 'fetch', query: str(input.query), results: results.filter((x) => x.url).slice(0, 10) }];
    }
    case 'Read':
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'ExitPlanMode':
      return isError && text ? [{ type: 'text', text: clipOutput(text, 2000), format: 'plain' }] : [];
  }
  return text ? [{ type: 'text', text: clipOutput(text, 4000), format: 'plain' }] : [];
}

/**
 * Claude's checklist. TodoWrite is a full snapshot; TaskCreate/TaskUpdate are
 * incremental, keyed by the id that TaskCreate returns.
 */
export class ClaudePlanTracker {
  private tasks = new Map<string, PlanEntry>();
  private pendingCreates = new Map<string, Rec>();

  /** Returns the new snapshot when the plan changed. */
  onToolUse(id: string, name: string, input: Rec): PlanEntry[] | undefined {
    if (name === 'TodoWrite') {
      return arr(input.todos).map((t, i) => {
        const x = rec(t);
        const status = str(x.status) as PlanEntry['status'];
        return {
          id: String(i),
          content: status === 'in_progress' && str(x.activeForm) ? str(x.activeForm) : str(x.content),
          status: ['pending', 'in_progress', 'completed'].includes(status) ? status : 'pending',
        };
      });
    }
    if (name === 'TaskCreate') this.pendingCreates.set(id, input);
    if (name === 'TaskUpdate') {
      const taskId = str(input.taskId);
      const prev = this.tasks.get(taskId);
      if (str(input.status) === 'deleted') this.tasks.delete(taskId);
      else
        this.tasks.set(taskId, {
          id: taskId,
          content: str(input.status) === 'in_progress' && str(input.activeForm) ? str(input.activeForm) : str(input.subject) || prev?.content || `Task ${taskId}`,
          status: (['pending', 'in_progress', 'completed'].includes(str(input.status)) ? str(input.status) : prev?.status ?? 'pending') as PlanEntry['status'],
        });
      return [...this.tasks.values()];
    }
    return undefined;
  }

  onToolResult(id: string, name: string, result: unknown): PlanEntry[] | undefined {
    if (name !== 'TaskCreate') return undefined;
    const input = this.pendingCreates.get(id);
    this.pendingCreates.delete(id);
    const task = rec(rec(result).task);
    const taskId = str(task.id);
    if (!taskId) return undefined;
    this.tasks.set(taskId, { id: taskId, content: str(task.subject) || str(input?.subject), status: 'pending' });
    return [...this.tasks.values()];
  }
}
