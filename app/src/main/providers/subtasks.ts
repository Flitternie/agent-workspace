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

/** Codex names a sub-agent by a path the model picks ("/root/read_alpha"): "Read alpha". */
function agentName(path: string): string {
  const name = (path.split('/').pop() ?? '').replace(/[_-]+/g, ' ').trim();
  return name ? name[0].toUpperCase() + name.slice(1) : '';
}

/** Shared state: which sub-agents are known and how they stand, so an ending is never undone. */
class Ledger {
  private status = new Map<string, Status>();
  /** Has reported back (a result is shown). */
  private reported = new Set<string>();

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

  /** Its report, as soon as it hands it back (it may still be finishing up). */
  report(id: string, text: string): SubtaskEvent[] {
    if (!this.status.has(id) || !text || this.reported.has(id)) return [];
    this.reported.add(id);
    return [{ type: 'subtask', id, result: text }];
  }

  /**
   * Ends a running sub-agent; later reports of the ending change nothing, except to add the report
   * when the first one came without it (Claude Code: task_updated, then task_notification's summary).
   */
  end(id: string, status: Exclude<Status, 'running'>, result?: string): SubtaskEvent[] {
    if (!this.status.has(id)) return [];
    if (result) {
      if (this.reported.has(id)) result = undefined;
      else this.reported.add(id);
    }
    if (!this.running(id)) return result ? [{ type: 'subtask', id, result }] : [];
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
      if (block.type !== 'tool_use') continue;
      // SubagentHandback is how it returns its report (task_notification then only points at it): not a step.
      if (block.name === 'SubagentHandback') out.push(...this.ledger.report(parentId, str(rec(block.input).message)));
      else out.push(...this.ledger.step(parentId, title(str(block.name), rec(block.input))));
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
      if (kind === 'started') return this.ledger.start(id, agentName(str(item.agentPath)));
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

/**
 * CLIs reached through ACP. The helper tool on the main session starts one: OpenCode's `subagent`
 * (2.x: launched in the background, its child session id in `rawOutput.metadata.sessionID`) or
 * `task` (1.x: runs within the call, whose output is its report); Antigravity's `invoke_subagent`
 * (launched; the turn waits for it, with nothing more said about it, so it ends with the turn).
 * OpenCode 2.x reports the child sessions themselves when the client asks for it
 * (`_meta["opencode/child-session-updates"]`): `opencode/session/child_update` notifications with
 * a status (created, running, completed, failed, interrupted) or one of the child's own session
 * updates (its tool calls are its steps, its last message its report). A child's own helpers
 * (depth 2 and more) show as steps of the depth-1 helper they belong to.
 */
export class AcpSubtasks {
  private ledger = new Ledger();
  /** Child session → the sub-agent it belongs to (itself at depth 1, an ancestor below that). */
  private lane = new Map<string, string>();
  /** Sub-agent → its own child session. */
  private own = new Map<string, string>();
  /** Started from a tool call whose child session is not known yet. */
  private unmatched: Array<{ id: string; description: string }> = [];
  /** Its last message so far (the report). */
  private text = new Map<string, { messageId: string; text: string }>();
  private lastStep = new Map<string, string>();
  /** Ended with the turn (Antigravity). */
  private withTurn = new Set<string>();
  private described = new Map<string, string>();

  static isAgentTool(name: string | undefined): boolean {
    return name === 'subagent' || name === 'task' || name === 'invoke_subagent';
  }

  /** What a helper tool call says it is for. */
  static describe(input: unknown): string {
    const i = rec(input);
    return oneLine(str(i.description) || str(i.Role) || str(i.prompt) || str(i.Prompt) || str(i.subagent_type));
  }

  /** A tool call on the main session, as merged so far; `output`: its result text. */
  tool(t: { id: string; name?: string; status: string; rawInput?: unknown; rawOutput?: unknown }, output = ''): SubtaskEvent[] {
    if (!AcpSubtasks.isAgentTool(t.name)) return [];
    const description = AcpSubtasks.describe(t.rawInput);
    const out = this.start(t.id, description);
    const waiting = this.unmatched.find((u) => u.id === t.id);
    if (!this.own.has(t.id)) {
      if (waiting) waiting.description ||= description;
      else this.unmatched.push({ id: t.id, description });
    }
    if (t.status === 'failed') return [...out, ...this.ledger.end(t.id, 'failed', output || undefined)];
    if (t.status !== 'completed') return out;
    const meta = rec(rec(t.rawOutput).metadata);
    const child = str(meta.sessionID);
    if (child) this.link(child, t.id);
    // Launched in the background: its child session reports how it goes.
    if (meta.status === 'running') return out;
    if (t.name === 'invoke_subagent') {
      this.withTurn.add(t.id);
      return out;
    }
    return [...out, ...this.ledger.end(t.id, 'done', output || undefined)];
  }

  /** Starts it, or names it once its description is known (each update repeats it). */
  private start(id: string, description: string): SubtaskEvent[] {
    if (this.ledger.has(id) && (!description || this.described.get(id) === description)) return [];
    if (description) this.described.set(id, description);
    return this.ledger.start(id, description);
  }

  private link(child: string, id: string): void {
    this.lane.set(child, id);
    this.own.set(id, child);
    this.unmatched = this.unmatched.filter((u) => u.id !== id);
  }

  /** An `opencode/session/child_update` notification. `stepOf` names a tool update the way the transcript does. */
  child(p: Rec, stepOf: (update: Rec) => string): SubtaskEvent[] {
    const child = str(p.childSessionId);
    if (!child) return [];
    const title = str(p.title);
    let id = this.lane.get(child);
    const out: SubtaskEvent[] = [];
    if (!id) {
      const parent = this.lane.get(str(p.parentSessionId));
      if (Number(p.depth) > 1 && parent) {
        id = parent;
        this.lane.set(child, id);
      } else {
        // Its tool call came first (OpenCode sends the child's creation before the call's result names it).
        const match = this.unmatched.find((u) => u.description === oneLine(title)) ?? this.unmatched[0];
        id = match?.id ?? child;
        this.link(child, id);
        out.push(...this.start(id, oneLine(title)));
      }
    }
    const mine = this.own.get(id) === child;
    if (p.type === 'status') {
      const status = str(p.status);
      if (!mine) return out;
      if (status === 'created' || status === 'running') return [...out, ...this.start(id, oneLine(title))];
      const report = this.text.get(id)?.text.trim();
      if (status === 'completed' || status === 'idle') return [...out, ...this.ledger.end(id, 'done', report || undefined)];
      if (status === 'failed') return [...out, ...this.ledger.end(id, 'failed', str(rec(p.error).message) || str(p.error) || report || undefined)];
      if (status === 'interrupted' || status === 'cancelled') return [...out, ...this.ledger.end(id, 'failed', 'Interrupted.')];
      return out;
    }
    const u = rec(p.update);
    const kind = str(u.sessionUpdate);
    if (kind === 'agent_message_chunk' && mine) {
      const messageId = str(u.messageId);
      const piece = str(rec(u.content).text);
      const prev = this.text.get(id);
      this.text.set(id, { messageId, text: prev && prev.messageId === messageId ? prev.text + piece : piece });
      return out;
    }
    let step = '';
    if (kind === 'tool_call' || (kind === 'tool_call_update' && (u.status === 'in_progress' || u.status === 'pending'))) step = stepOf(u);
    else if (kind === 'session_info_update' && rec(rec(u._meta)['opencode/retry']).attempt) step = `Model busy, retrying (attempt ${Number(rec(rec(u._meta)['opencode/retry']).attempt)})`;
    if (step && step !== this.lastStep.get(id)) {
      this.lastStep.set(id, step);
      out.push(...this.ledger.step(id, step));
    }
    return out;
  }

  /** The turn ended: the helpers it waited for (Antigravity) ended with it. */
  turnEnded(status: 'completed' | 'interrupted' | 'failed'): SubtaskEvent[] {
    const out: SubtaskEvent[] = [];
    for (const id of this.withTurn) out.push(...(status === 'completed' ? this.ledger.end(id, 'done') : this.ledger.end(id, 'failed', status === 'interrupted' ? 'Stopped with the turn.' : undefined)));
    this.withTurn.clear();
    return out;
  }
}
