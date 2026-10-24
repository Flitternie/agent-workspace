// Codex app-server ThreadItems → provider-neutral content (src/shared/content.ts).
// Field names follow `codex app-server generate-ts` for codex-cli 0.162 (v2 ThreadItem,
// FileUpdateChange, CommandAction, TurnPlanUpdatedNotification). Command kinds use
// Codex's own `commandActions` parse rather than regexing the command (as codex-acp does).
import {
  clipOutput,
  makeDiff,
  parseUnifiedHunks,
  wholeFileHunks,
  type FileDiff,
  type PlanEntry,
  type ToolCallInfo,
  type ToolContent,
} from '../../shared/content';
import type { ToolStatus, TranscriptRole } from '../../shared/types';
import { displayPath, firstLine } from './claude-content';
import { cleanUserText } from './user-text';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface CodexItemView {
  id: string;
  role: TranscriptRole;
  text: string;
  status?: ToolStatus;
  tool?: ToolCallInfo;
}

/** One FileUpdateChange → FileDiff. `add` carries the whole file without @@ headers. */
export function codexFileDiff(change: unknown, phase: FileDiff['phase'], cwd: string): FileDiff {
  const c = rec(change);
  const kind = rec(c.kind);
  const type = str(kind.type);
  const diff = str(c.diff);
  const path = displayPath(str(c.path), cwd);
  const hasHunks = /^@@ /m.test(diff);
  if (type === 'add') return makeDiff({ path, operation: 'add', phase, hunks: hasHunks ? parseUnifiedHunks(diff) : wholeFileHunks(diff, '+') });
  if (type === 'delete') return makeDiff({ path, operation: 'delete', phase, hunks: hasHunks ? parseUnifiedHunks(diff) : wholeFileHunks(diff, '-') });
  const movePath = str(kind.move_path);
  return makeDiff({
    path: movePath ? displayPath(movePath, cwd) : path,
    oldPath: movePath ? path : undefined,
    operation: movePath ? 'move' : 'modify',
    phase,
    hunks: parseUnifiedHunks(diff),
  });
}

export function codexFileDiffs(changes: unknown, phase: FileDiff['phase'], cwd: string): ToolContent[] {
  return arr(changes).map((c) => ({ type: 'diff' as const, diff: codexFileDiff(c, phase, cwd) }));
}

function status(item: Rec, completed: boolean, history: boolean): ToolStatus {
  const s = str(item.status);
  const st: ToolStatus =
    s === 'declined'
      ? 'declined'
      : s === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
        ? 'failed'
        : s === 'inProgress' || !completed
          ? 'running'
          : 'completed';
  return history && st === 'running' ? 'interrupted' : st;
}

export function codexItem(value: unknown, opts: { history: boolean; completed: boolean; cwd: string }): CodexItemView | undefined {
  const item = rec(value);
  const id = str(item.id);
  if (!id) return undefined;
  const type = str(item.type);
  const st = () => status(item, opts.completed, opts.history);
  switch (type) {
    case 'agentMessage': {
      const text = str(item.text);
      return text ? { id, role: 'assistant', text } : undefined;
    }
    case 'userMessage': {
      if (!opts.history) return undefined; // the workspace already shows what the user sent
      const text = cleanUserText(
        arr(item.content)
          .map((c) => str(rec(c).text))
          .filter(Boolean)
          .join('\n'),
      );
      return text ? { id, role: 'user', text } : undefined;
    }
    case 'reasoning': {
      const text = arr(item.summary).map(str).filter(Boolean).join('\n\n');
      return text ? { id, role: 'thought', text } : undefined;
    }
    case 'plan': {
      const text = str(item.text);
      return text ? { id, role: 'plan', text } : undefined;
    }
    case 'commandExecution': {
      const command = str(item.command);
      const actions = arr(item.commandActions).map(rec);
      const types = new Set(actions.map((a) => str(a.type)));
      const reads = actions.filter((a) => a.type === 'read');
      const allRead = actions.length > 0 && types.size === 1 && types.has('read');
      const allSearch = actions.length > 0 && [...types].every((t) => t === 'search' || t === 'listFiles');
      const kind = allRead ? 'read' : allSearch ? 'search' : 'execute';
      const title = allRead
        ? `Read ${reads.map((a) => displayPath(str(a.path) || str(a.name), opts.cwd)).join(', ')}`
        : allSearch && actions[0]?.type === 'search' && str(actions[0].query)
          ? `Search “${str(actions[0].query)}”${str(actions[0].path) ? ` in ${displayPath(str(actions[0].path), opts.cwd)}` : ''}`
          : `$ ${firstLine(command)}`;
      return {
        id,
        role: 'tool',
        text: '',
        status: st(),
        tool: {
          name: 'commandExecution',
          kind,
          title,
          locations: reads.map((a) => ({ path: str(a.path) })).filter((l) => l.path),
          content: [
            {
              type: 'terminal',
              command,
              cwd: str(item.cwd) || undefined,
              output: clipOutput(str(item.aggregatedOutput)),
              exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined,
            },
          ],
        },
      };
    }
    case 'fileChange': {
      const changes = arr(item.changes);
      const applied = str(item.status) === 'completed';
      const content = codexFileDiffs(changes, applied ? 'applied' : 'proposed', opts.cwd);
      const paths = content.map((c) => (c.type === 'diff' ? c.diff.path : ''));
      const allDelete = content.length > 0 && content.every((c) => c.type === 'diff' && c.diff.operation === 'delete');
      return {
        id,
        role: 'tool',
        text: '',
        status: st(),
        tool: {
          name: 'fileChange',
          kind: allDelete ? 'delete' : 'edit',
          title: `${allDelete ? 'Delete' : content.every((c) => c.type === 'diff' && c.diff.operation === 'add') && content.length ? 'Create' : 'Edit'} ${paths.length === 1 ? paths[0] : `${paths.length} files`}`,
          locations: changes.map((c) => ({ path: str(rec(c).path) })),
          content,
        },
      };
    }
    case 'webSearch': {
      const action = rec(item.action);
      const url = str(action.url);
      const query = str(item.query) || str(action.query);
      return {
        id,
        role: 'tool',
        text: '',
        status: opts.completed || opts.history ? 'completed' : 'running',
        tool: {
          name: 'webSearch',
          kind: 'fetch',
          title: action.type === 'openPage' && url ? `Open ${url}` : `Web search: ${query}`,
          locations: [],
          content: [{ type: 'fetch', query: query || undefined, url: url || undefined }],
        },
      };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const result = rec(item.result);
      const text = [
        ...arr(result.content).map((c) => str(rec(c).text)),
        ...arr(item.contentItems).map((c) => str(rec(c).text)),
        str(rec(item.error).message),
      ]
        .filter(Boolean)
        .join('\n');
      return {
        id,
        role: 'tool',
        text: '',
        status: st(),
        tool: {
          name: type,
          kind: 'other',
          title: type === 'mcpToolCall' ? `${str(item.server)} / ${str(item.tool)}` : str(item.tool) || 'Tool',
          locations: [],
          content: text ? [{ type: 'text', text: clipOutput(text, 4000), format: 'plain' }] : [],
        },
      };
    }
    case 'imageView':
      return {
        id,
        role: 'tool',
        text: '',
        status: 'completed',
        tool: { name: 'imageView', kind: 'read', title: `View image ${displayPath(str(item.path), opts.cwd)}`, locations: [{ path: str(item.path) }], content: [] },
      };
    case 'contextCompaction':
      return opts.history ? undefined : { id, role: 'system', text: 'Codex compacted its context.' };
    default:
      return undefined;
  }
}

/** turn/plan/updated → checklist snapshot. Codex step status is camelCase. */
export function codexPlan(plan: unknown): PlanEntry[] {
  return arr(plan).map((s, i) => {
    const x = rec(s);
    const st = str(x.status);
    return { id: String(i), content: str(x.step), status: st === 'inProgress' || st === 'in_progress' ? 'in_progress' : st === 'completed' ? 'completed' : 'pending' };
  });
}
