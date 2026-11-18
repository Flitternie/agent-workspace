import type { Task, TranscriptItem } from './types';

// A session's history as tasks, not messages: a task is a run of consecutive turns (a user message and
// what followed) working toward one goal. Which turns go together, and what each task is called, is a
// model's call (asked in the background, cached; see Workspace.sessionMapGrouping): what the user meant
// is not something to match with patterns. Until it answers, or with no model at hand, the map groups
// by structure alone (a second plan in a task, a long pause) and names a task by its first message.
// Decisions are read from structured records on the transcript, never from its wording.

export interface MapDecision {
  /** The transcript item it is recorded at (the turn's user message for one read from the talk). */
  itemId: string;
  /** The turn it happened in (its user message: where to jump). */
  turnId: string;
  /** 'decided': settled in the conversation (read by the model); the others are structured records. */
  kind: 'decided' | 'approval' | 'answer' | 'redirect';
  /** What was decided: the option chosen, the answer given, or the new direction. */
  label: string;
  /** What it was about: the tool call approved, the question answered, or what a decision ruled out. */
  about?: string;
  /** The options that were offered, the chosen ones marked (approvals and answers). */
  options?: Array<{ label: string; chosen: boolean }>;
}

export interface MapBranch {
  taskId: string;
  alias: string;
  name: string;
}

/** A sub-agent the agent sent off within a task (Claude's Task/Agent tool, a Codex sub-agent). */
export interface MapSubagent {
  itemId: string;
  turnId: string;
  label: string;
  status: 'running' | 'done' | 'failed';
}

/** An approach tried and then dropped or undone (read by the model), with why. */
export interface MapAttempt {
  turnId: string;
  tried: string;
  why?: string;
}

export interface MapTask {
  /** The first turn's user message: where the task begins in the conversation. */
  startItemId: string;
  title: string;
  /** What came of it, in a sentence (from the model). */
  outcome?: string;
  /** From the model: done, still going, or given up / undone. */
  status?: 'done' | 'in_progress' | 'abandoned';
  /** Ids of the user messages that begin each of its turns. */
  turnIds: string[];
  startedAt: string;
  endedAt: string;
  files: string[];
  commands: number;
  decisions: MapDecision[];
  branches: MapBranch[];
  subagents: MapSubagent[];
  attempts: MapAttempt[];
}

/** A decision the model read from the conversation, at a turn (index), with what it ruled out. */
export interface GroupedDecision {
  turn: number;
  decision: string;
  rejected?: string;
}

/** A model's grouping of the turns: where each task starts (turn index), its title, outcome, status and decisions. */
export interface MapGrouping {
  /** The prompt's version: an older cache is asked again. */
  version?: number;
  /** How many turns it covers (newer turns join the last task until it is asked again). */
  turns: number;
  tasks: Array<{ start: number; title: string; outcome?: string; status?: MapTask['status']; decisions?: GroupedDecision[]; attempts?: Array<{ turn: number; tried: string; why?: string }> }>;
}

/** The grouping prompt's version (bump when what it asks for changes). */
export const GROUPING_VERSION = 4;

/** Structure only, until the model's grouping: a pause this long starts a new task. */
export const PAUSE_MS = 45 * 60_000;

const PLAN_TOOLS = new Set(['TodoWrite', 'update_plan', 'ExitPlanMode']);
/** Tools that send off a sub-agent (Claude Code, Codex). */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'collabAgentToolCall']);
/** A sub-agent call's label: Claude's description (our title, less its prefix) or Codex's prompt. */
function subagentLabel(item: TranscriptItem): string {
  const title = item.tool?.title ?? '';
  const prompt = item.tool?.content.find((c) => c.type === 'text');
  if (item.tool?.name === 'collabAgentToolCall') return clip(prompt && 'text' in prompt ? prompt.text : title, 70);
  return clip(title.startsWith('Subagent: ') ? title.slice('Subagent: '.length) : title, 70);
}
const ms = (iso: string) => Date.parse(iso) || 0;
const clip = (s: string, n: number) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

interface Turn {
  user: TranscriptItem;
  items: TranscriptItem[];
}

export function turnsOf(items: TranscriptItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.role === 'user') turns.push({ user: item, items: [item] });
    else turns.at(-1)?.items.push(item);
  }
  return turns;
}

const hasPlan = (turn: Turn) => turn.items.some((i) => i.role === 'plan' || (i.role === 'tool' && !!i.tool && PLAN_TOOLS.has(i.tool.name)));
const filesOf = (turn: Turn) => [...new Set(turn.items.flatMap((i) => (i.tool?.content ?? []).flatMap((c) => (c.type === 'diff' && c.diff.operation !== 'delete' ? [c.diff.path] : []))))];

/** One line per turn for the model to group: what was asked, what came of it, the structural hints. */
export function turnsDigest(items: TranscriptItem[], from = 0): string {
  const turns = turnsOf(items);
  return turns
    .map((turn, i) => {
      const reply = [...turn.items].reverse().find((x) => x.role === 'assistant' && x.text.trim());
      const gap = i ? Math.round((ms(turn.user.createdAt) - ms(turns[i - 1].items.at(-1)!.createdAt)) / 60_000) : 0;
      const hints = [hasPlan(turn) ? 'new plan' : '', gap >= 30 ? `after ${gap} min` : '', turn.user.delivery === 'interrupt' ? 'stopped the previous turn' : '', filesOf(turn).length ? `files: ${filesOf(turn).slice(0, 4).join(', ')}` : '']
        .filter(Boolean)
        .join('; ');
      return `[${i}] user: ${clip(turn.user.text, 300)}${reply ? `\n    agent: ${clip(reply.text, 300)}` : ''}${hints ? `\n    (${hints})` : ''}`;
    })
    .slice(from)
    .join('\n');
}

/** Turn indexes where tasks start, by structure alone (the stand-in until a model groups them). */
function structuralStarts(turns: Turn[]): number[] {
  const starts = turns.length ? [0] : [];
  let planned = turns[0] ? hasPlan(turns[0]) : false;
  for (let i = 1; i < turns.length; i++) {
    const pause = ms(turns[i].user.createdAt) - ms(turns[i - 1].items.at(-1)!.createdAt) >= PAUSE_MS;
    const secondPlan = hasPlan(turns[i]) && planned;
    if (pause || secondPlan) {
      starts.push(i);
      planned = hasPlan(turns[i]);
    } else planned ||= hasPlan(turns[i]);
  }
  return starts;
}

/** The reader's corrections: tasks merged into the one before (by their first turn's id), turns made to start one. */
export interface MapEdits {
  merged?: string[];
  split?: string[];
}

export function sessionMap(items: TranscriptItem[], forks: Pick<Task, 'taskId' | 'alias' | 'name' | 'createdAt'>[] = [], grouping?: MapGrouping | null, edits: MapEdits = {}): MapTask[] {
  const turns = turnsOf(items);
  // The model's starts where it has grouped (turns after its last look join its last task).
  const valid = grouping && grouping.tasks.length && grouping.tasks[0].start === 0 && grouping.tasks.every((g, i) => g.start < turns.length && (i === 0 || g.start > grouping.tasks[i - 1].start));
  // Where tasks start: the model's grouping (else structure), then the reader's corrections on top.
  const merged = new Set(edits.merged ?? []);
  const split = new Set(edits.split ?? []);
  const starts = (valid ? grouping!.tasks.map((g) => g.start) : structuralStarts(turns)).filter((i) => i === 0 || !merged.has(turns[i]?.user.id));
  turns.forEach((turn, i) => i > 0 && split.has(turn.user.id) && !starts.includes(i) && starts.push(i));
  starts.sort((a, b) => a - b);
  const groups = valid ? grouping!.tasks : [];
  const tasks: MapTask[] = [];
  turns.forEach((turn, i) => {
    const k = starts.indexOf(i);
    const g = groups.find((x) => x.start === i);
    if (k >= 0 || !tasks.length)
      tasks.push({
        startItemId: turn.user.id,
        title: g?.title || clip(turn.user.text, 70) || '…',
        outcome: g?.outcome,
        status: g?.status,
        turnIds: [],
        startedAt: turn.user.createdAt,
        endedAt: turn.user.createdAt,
        files: [],
        commands: 0,
        decisions: [],
        branches: [],
        subagents: [],
        attempts: [],
      });
    const task = tasks.at(-1)!;
    task.turnIds.push(turn.user.id);
    // Decisions the model read from this turn (it was checked to lie inside its task).
    for (const g of groups) for (const d of g.decisions ?? []) if (d.turn === i) task.decisions.push({ itemId: turn.user.id, turnId: turn.user.id, kind: 'decided', label: clip(d.decision, 80), about: d.rejected ? clip(d.rejected, 80) : undefined });
    // Approaches tried and dropped in this turn (the model's, checked to lie inside its task).
    for (const g of groups) for (const a of g.attempts ?? []) if (a.turn === i) task.attempts.push({ turnId: turn.user.id, tried: clip(a.tried, 80), ...(a.why ? { why: clip(a.why, 80) } : {}) });
    // Stopping a running turn with a new message changes course (a structured flag on the message).
    if (turn.user.delivery === 'interrupt') task.decisions.push({ itemId: turn.user.id, turnId: turn.user.id, kind: 'redirect', label: clip(turn.user.text, 60) });
    for (const item of turn.items) {
      task.endedAt = item.createdAt || task.endedAt;
      if (item.role === 'tool' && item.tool?.kind === 'execute') task.commands++;
      if (item.role === 'tool' && item.tool && SUBAGENT_TOOLS.has(item.tool.name))
        task.subagents.push({ itemId: item.id, turnId: turn.user.id, label: subagentLabel(item), status: item.toolStatus === 'failed' ? 'failed' : item.toolStatus === 'completed' ? 'done' : 'running' });
      for (const f of item.role === 'tool' ? filesOf({ user: turn.user, items: [item] }) : []) if (!task.files.includes(f)) task.files.push(f);
      if (item.decision) task.decisions.push({ itemId: item.id, turnId: turn.user.id, kind: item.decision.kind, label: clip(item.decision.label, 60), about: item.decision.about ? clip(item.decision.about, 80) : undefined, ...(item.decision.options?.length ? { options: item.decision.options } : {}) });
    }
  });
  // Agents forked from this one hang off the task that was under way when they were made.
  for (const f of forks) {
    const t = ms(f.createdAt);
    const at = [...tasks].reverse().find((x) => ms(x.startedAt) <= t) ?? tasks.at(-1);
    at?.branches.push({ taskId: f.taskId, alias: f.alias, name: f.name });
  }
  return tasks;
}

/**
 * A model's answer to the grouping request, checked against the turns it was asked about: tasks start in
 * order at `first` (0 for the whole session), titles present, and every decision inside its own task's
 * turns. Anything that does not hold is dropped (a decision) or rejects the answer (the grouping).
 */
export function parseGrouping(answer: string, turns: number, first = 0): MapGrouping | null {
  const json = /\{[\s\S]*\}/.exec(answer)?.[0];
  if (!json) return null;
  try {
    const raw = (JSON.parse(json) as { tasks?: Array<Record<string, unknown>> }).tasks ?? [];
    const out = raw
      .map((t) => ({
        start: Number(t.start),
        title: String(t.title ?? '').trim().slice(0, 80),
        outcome: typeof t.outcome === 'string' && t.outcome.trim() ? t.outcome.trim().slice(0, 200) : undefined,
        status: t.status === 'done' || t.status === 'in_progress' || t.status === 'abandoned' ? (t.status as MapTask['status']) : undefined,
        decisions: Array.isArray(t.decisions) ? (t.decisions as Array<Record<string, unknown>>) : [],
        attempts: Array.isArray(t.attempts) ? (t.attempts as Array<Record<string, unknown>>) : [],
      }))
      .filter((t) => Number.isInteger(t.start) && t.start >= first && t.start < turns && t.title);
    if (!out.length || out[0].start !== first || out.some((t, i) => i && t.start <= out[i - 1].start)) return null;
    return {
      version: GROUPING_VERSION,
      turns,
      tasks: out.map((t, i) => {
        const end = i + 1 < out.length ? out[i + 1].start : turns;
        // Grounded: a decision must sit in one of its task's turns, or it is dropped.
        const decisions = t.decisions
          .map((d) => ({ turn: Number(d.turn), decision: String(d.decision ?? '').trim(), rejected: typeof d.rejected === 'string' && d.rejected.trim() ? d.rejected.trim() : undefined }))
          .filter((d) => Number.isInteger(d.turn) && d.turn >= t.start && d.turn < end && d.decision)
          .slice(0, 6);
        const attempts = t.attempts
          .map((a) => ({ turn: Number(a.turn), tried: String(a.tried ?? '').trim(), why: typeof a.why === 'string' && a.why.trim() ? a.why.trim() : undefined }))
          .filter((a) => Number.isInteger(a.turn) && a.turn >= t.start && a.turn < end && a.tried)
          .slice(0, 4)
          .map((a) => (a.why ? a : { turn: a.turn, tried: a.tried }));
        return { start: t.start, title: t.title, ...(t.outcome ? { outcome: t.outcome } : {}), ...(t.status ? { status: t.status } : {}), ...(decisions.length ? { decisions } : {}), ...(attempts.length ? { attempts } : {}) };
      }),
    };
  } catch {
    return null;
  }
}

/** The earlier tasks, fixed, with the model's fresh answer for the turns from the last one on. */
export function mergeGrouping(earlier: MapGrouping, fresh: MapGrouping): MapGrouping {
  const from = fresh.tasks[0].start;
  return { version: GROUPING_VERSION, turns: fresh.turns, tasks: [...earlier.tasks.filter((t) => t.start < from), ...fresh.tasks] };
}

export const GROUPING_PROMPT = `You index a coding agent's session for the person who ran it, so they can see at a glance what was done.

You get the turns in order, numbered: what the user asked, the agent's last reply, and hints (a new plan, a long pause, files touched). Group consecutive turns into tasks. A task usually spans several turns: follow-ups, confirmations, corrections and fixes for the same goal stay in the same task. Start a new task only where the goal changes. The hints are evidence, not rules.

For each task:
Write like index entries, not sentences: terse phrases, no subject (no "I", "we", "the user"), no filler, no trailing punctuation. Name code by its identifier.
Language: write every title, outcome, decision and attempt in the language of the user's own messages. If the user writes Chinese, write Chinese, even when the code, the agent's replies or these instructions are in English.

- title: what was worked on, at most 5 words (about 10 characters in Chinese), e.g. "Add discount to total" / "给 total 加折扣参数".
- outcome: what came of it, at most 10 words (about 20 characters in Chinese), e.g. "Refund rule documented, not enforced" / "退款规则只写入文档，未校验". Only what the turns show.
- status: "done" when it was finished, "in_progress" when it is still going (usually only the last task), "abandoned" when it was dropped or undone.
- decisions: the choices that were settled in the conversation, the ones someone coming back later would want to find: a direction picked, an option ruled out, a trade-off accepted. For each, the turn it was settled in, the decision (at most 6 words, about 12 characters in Chinese, e.g. "按减掉的比例算折扣"), and what it ruled out if anything (at most 4 words, about 8 characters, e.g. "打八折写法"). Leave routine steps out; none is fine.
- attempts: approaches that were actually tried and then dropped or undone (changes reverted, a route abandoned for another). For each, the turn it was tried in, what was tried (at most 5 words) and why it was dropped if the turns say (at most 6 words). Not options merely discussed; none is fine.

Use only what the turns say. Every turn number you give must be one of the turns shown, and a decision's turn must lie inside its task.

Answer with JSON only:
{"tasks":[{"start":0,"title":"…","outcome":"…","status":"done","decisions":[{"turn":2,"decision":"…","rejected":"…"}],"attempts":[{"turn":3,"tried":"…","why":"…"}]}]}
start is the index of the task's first turn, in increasing order.`;

export const GROUPING_UPDATE_NOTE = (first: number, earlier: string[]) =>
  `Earlier tasks are fixed: ${earlier.map((title, i) => `${i + 1}. ${title}`).join('; ') || '(none)'}.\nThe turns below start at turn ${first}, which begins the latest task. Group them the same way: your first task must start at ${first} (continue or rename that task), and later tasks may follow.`;
