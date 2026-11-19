// Sub-agents, as each CLI reports them, turned into `subtask` provider events: one per helper the
// agent starts (Claude Code's Agent/Task tool, Codex's spawn_agent), with its current step and how
// it ended. Pure bookkeeping, no I/O, so it is tested with recorded message shapes.

import type { ProviderEvent } from './types';

type Rec = Record<string, unknown>;
type SubtaskEvent = Extract<ProviderEvent, { type: 'subtask' }>;
type Status = 'running' | 'done' | 'failed';

const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** A one-line description from a prompt or label. */
const oneLine = (text: string): string => text.trim().split('\n')[0].trim();

/** Shared state: which sub-agents are known and how they stand, so an ending is never undone. */
class Ledger {
  private status = new Map<string, Status>();

  has(id: string): boolean {
    return this.status.has(id);
  }

  running(id: string): boolean {
    return this.status.get(id) === 'running';
  }

  start(id: string, description: string): SubtaskEvent[] {
    if (this.status.has(id)) return description ? [{ type: 'subtask', id, description }] : [];
    this.status.set(id, 'running');
    return [{ type: 'subtask', id, description: description || 'Sub-agent', status: 'running' }];
  }

  step(id: string, step: string): SubtaskEvent[] {
    return this.running(id) && step ? [{ type: 'subtask', id, step }] : [];
  }

  /** Ends a running sub-agent; later reports of the same ending (or a vaguer one) change nothing. */
  end(id: string, status: Exclude<Status, 'running'>, result?: string): SubtaskEvent[] {
    if (!this.running(id)) return [];
    this.status.set(id, status);
    return [{ type: 'subtask', id, status, step: '', ...(result ? { result } : {}) }];
  }
}

/**
 * Claude Code. The Agent (or older Task) tool_use on the main thread starts a sub-agent; its id is
 * the tool_use id, which the sub-agent's own messages carry as `parent_tool_use_id` (the SDK forwards
 * their tool calls by default). `task_started` / `task_progress` / `task_updated` /
 * `task_notification` system messages add the task id, a progress summary and the ending; the
 * tool_result of a foreground sub-agent is its report.
 */
export class ClaudeSubtasks {
  private ledger = new Ledger();
  /** task_id → tool_use id (the sub-agent's id here). */
  private byTask = new Map<string, string>();
  /** Started in the background: its tool_result only says it was launched. */
  private background = new Set<string>();

  static isAgentTool(name: string): boolean {
    return name === 'Agent' || name === 'Task';
  }

  /** The main thread called the Agent tool. */
  toolUse(id: string, input: Rec): SubtaskEvent[] {
    if (input.run_in_background === true) this.background.add(id);
    return this.ledger.start(id, oneLine(str(input.description) || str(input.subagent_type)));
  }

  /** The Agent tool returned: a foreground sub-agent's report (a background one keeps running). */
  toolResult(id: string, text: string, isError: boolean): SubtaskEvent[] {
    if (this.background.has(id)) return [];
    return this.ledger.end(id, isError ? 'failed' : 'done', text);
  }

  /** A message from inside a sub-agent (`parent_tool_use_id` set): its tool calls are its steps. */
  inner(parentId: string, message: Rec, title: (name: string, input: Rec) => string): SubtaskEvent[] {
    if (!this.ledger.has(parentId) || str(message.type) !== 'assistant') return [];
    const blocks = rec(message.message).content;
    const out: SubtaskEvent[] = [];
    for (const b of Array.isArray(blocks) ? blocks : []) {
      const block = rec(b);
      if (block.type === 'tool_use') out.push(...this.ledger.step(parentId, title(str(block.name), rec(block.input))));
    }
    return out;
  }

  /** A `system` message with a task_* subtype. */
  system(m: Rec): SubtaskEvent[] {
    const taskId = str(m.task_id);
    if (!taskId) return [];
    switch (m.subtype) {
      case 'task_started': {
        // Only sub-agents: background shells, monitors and housekeeping tasks are not helpers.
        if (m.ambient === true || m.skip_transcript === true) return [];
        if (str(m.task_type) !== 'local_agent' && !str(m.subagent_type)) return [];
        const id = str(m.tool_use_id) || taskId;
        this.byTask.set(taskId, id);
        if (m.is_backgrounded === true) this.background.add(id);
        return this.ledger.start(id, oneLine(str(m.description) || str(m.subagent_type)));
      }
      case 'task_progress': {
        const id = this.byTask.get(taskId);
        return id ? this.ledger.step(id, oneLine(str(m.summary))) : [];
      }
      case 'task_updated': {
        const id = this.byTask.get(taskId);
        if (!id) return [];
        const patch = rec(m.patch);
        if (patch.is_backgrounded === true) this.background.add(id);
        const status = str(patch.status);
        if (status === 'completed') return this.ledger.end(id, 'done');
        if (status === 'failed' || status === 'killed') return this.ledger.end(id, 'failed', str(patch.error) || (status === 'killed' ? 'Stopped.' : undefined));
        return [];
      }
      case 'task_notification': {
        const id = this.byTask.get(taskId) ?? (str(m.tool_use_id) || undefined);
        if (!id) return [];
        const status = str(m.status);
        const summary = str(m.summary);
        return this.ledger.end(id, status === 'completed' ? 'done' : 'failed', summary || (status === 'stopped' ? 'Stopped.' : undefined));
      }
      default:
        return [];
    }
  }
}

/**
 * Codex. A `collabAgentToolCall` item with tool spawnAgent starts one sub-agent per receiver thread
 * (its id here); every collab call reports the agents' last known states, `subAgentActivity` items
 * mark starts and ends, and the sub-agent's own thread notifications are its steps.
 */
export class CodexSubtasks {
  private ledger = new Ledger();
  /** Last agent message per sub-agent thread: its report if it ends without one. */
  private lastText = new Map<string, string>();

  /** A sub-agent's thread (its notifications are steps, not the main conversation). */
  owns(threadId: string): boolean {
    return this.ledger.has(threadId);
  }

  /** An item from the main thread (item/started or item/completed). */
  item(item: Rec): SubtaskEvent[] {
    if (item.type === 'subAgentActivity') {
      const id = str(item.agentThreadId);
      if (!id) return [];
      const kind = str(item.kind);
      if (kind === 'started') return this.ledger.start(id, oneLine(str(item.agentPath).split('/').pop() ?? ''));
      if (kind === 'completed') return this.ledger.end(id, 'done', this.lastText.get(id));
      if (kind === 'interrupted') return this.ledger.end(id, 'failed', 'Interrupted.');
      return [];
    }
    if (item.type !== 'collabAgentToolCall') return [];
    const out: SubtaskEvent[] = [];
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(str).filter(Boolean) : [];
    if (str(item.tool) === 'spawnAgent') for (const id of receivers) out.push(...this.ledger.start(id, oneLine(str(item.prompt))));
    for (const [id, state] of Object.entries(rec(item.agentsStates))) {
      const s = rec(state);
      const message = str(s.message);
      switch (str(s.status)) {
        case 'pendingInit':
        case 'running':
          // Known only from a state report (spawned before a resume, say): still worth showing.
          out.push(...this.ledger.start(id, ''));
          break;
        case 'completed':
          out.push(...this.ledger.end(id, 'done', message || this.lastText.get(id)));
          break;
        case 'errored':
        case 'notFound':
          out.push(...this.ledger.end(id, 'failed', message || undefined));
          break;
        case 'interrupted':
          out.push(...this.ledger.end(id, 'failed', message || 'Interrupted.'));
          break;
        // 'shutdown': closed after it ended; nothing new.
      }
    }
    return out;
  }

  /** A notification from a sub-agent's own thread. `title` names a tool item the way the transcript does. */
  inner(threadId: string, method: string, p: Rec, title: (item: Rec) => string | undefined): SubtaskEvent[] {
    const item = rec(p.item);
    if (method === 'item/completed' && item.type === 'agentMessage' && str(item.text)) this.lastText.set(threadId, str(item.text));
    if (method === 'item/started') {
      const t = title(item);
      return t ? this.ledger.step(threadId, t) : [];
    }
    return [];
  }
}
