import type { Task, TranscriptItem } from './types';

// The main agent's conversation as parallel lanes, git-graph style: time runs down; the main agent's
// own lane is on the left (each of your messages to it is a point on it), and every agent it handed
// work to has a lane of its own. A hand-off curves from the main lane to that agent's lane; later
// hand-offs to the same agent land on the same lane, so work going on side by side reads as
// parallel lines. An agent coming back (waiting on you, or done with a request) is a point on its
// lane. Lanes of one project sit together.
//
// Who got what is read from the results the app's own workspace tools return ("Sent to Bob; …",
// "Started Bob (claude) on shop: …", "Forked Ann as Bob …") and the app's own notices: fixed
// strings, not the model's or the user's words.

export type LaneEventKind = 'ask' | 'send' | 'create' | 'fork' | 'failed' | 'waiting' | 'settled';

export interface Lane {
  alias: string;
  taskId?: string;
  name: string;
  projectId?: string;
  projectName?: string;
  /** Rows where the lane starts and ends (it is drawn between them). */
  first: number;
  last: number;
}

export interface LaneRow {
  itemId: string;
  /** Your message to the main agent this happened under (where to jump). */
  turnId: string;
  kind: LaneEventKind;
  /** 0 = the main agent's lane; otherwise 1 + the index in `lanes`. */
  lane: number;
  /** A fork: the lane it branched off. */
  from?: number;
  /** Your message (for an ask), or the agent's name. */
  label: string;
  at: string;
}

const RESULT: Array<[LaneEventKind, RegExp, 'to' | 'fork']> = [
  ['failed', /^Not delivered to (.+?):/, 'to'],
  ['send', /^(?:Sent to (.+?);|Added to (.+?)'s current work|Stopped (.+?)'s current turn)/, 'to'],
  ['create', /^Started (.+?) \(/, 'to'],
  ['fork', /^Forked (.+?) as (.+?)(?: in its own worktree|, sharing|[;,])/, 'fork'],
];
const NOTICE = /^(.+?)(?: is waiting on you \((?:permission|question)\): |'s request is settled: )/;

const toolName = (i: TranscriptItem) => (i.tool?.title ?? '').split(' / ').pop() ?? '';
const resultText = (i: TranscriptItem) =>
  (i.tool?.content ?? [])
    .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
    .join(' ')
    .trim();

type LaneTask = Pick<Task, 'taskId' | 'alias' | 'name' | 'projectId'>;

export function mainLanes(items: TranscriptItem[], tasks: LaneTask[], projects: Array<{ projectId: string; name: string }> = []): { lanes: Lane[]; rows: LaneRow[] } {
  const raw: Array<Omit<LaneRow, 'lane' | 'from'> & { alias?: string; fromAlias?: string }> = [];
  let turnId = '';
  for (const i of items) {
    if (i.role === 'user') {
      turnId = i.id;
      raw.push({ itemId: i.id, turnId, kind: 'ask', label: i.text.trim().split('\n')[0], at: i.createdAt });
      continue;
    }
    if (i.role === 'tool' && /^(send_to_agent|create_agent|fork_agent)$/.test(toolName(i))) {
      const text = resultText(i);
      for (const [kind, re, shape] of RESULT) {
        const m = re.exec(text);
        if (!m) continue;
        if (shape === 'fork') raw.push({ itemId: i.id, turnId, kind, alias: m[2], fromAlias: m[1], label: m[2], at: i.createdAt });
        else {
          const alias = m.slice(1).find(Boolean)!;
          raw.push({ itemId: i.id, turnId, kind, alias, label: alias, at: i.createdAt });
        }
        break;
      }
      continue;
    }
    if (i.role === 'system') {
      const m = NOTICE.exec(i.text);
      if (m) raw.push({ itemId: i.id, turnId, kind: / is waiting on you /.test(i.text) ? 'waiting' : 'settled', alias: m[1], label: m[1], at: i.createdAt });
    }
  }
  // Only agents the main agent handed work to get a lane (a notice alone does not make one).
  const handed = new Set(raw.filter((r) => r.kind !== 'waiting' && r.kind !== 'settled' && r.alias).map((r) => r.alias!));
  for (const r of raw) if (r.fromAlias) handed.add(r.fromAlias);
  const rows = raw.filter((r) => r.kind === 'ask' || (r.alias && handed.has(r.alias)));
  // Lanes in order of first appearance, then gathered by project (keeping that order inside each).
  const order: string[] = [];
  for (const r of rows) for (const a of [r.fromAlias, r.alias]) if (a && !order.includes(a)) order.push(a);
  const info = (alias: string) => {
    const t = tasks.find((x) => x.alias === alias);
    return { alias, taskId: t?.taskId, name: t?.name ?? alias, projectId: t?.projectId, projectName: projects.find((p) => p.projectId === t?.projectId)?.name };
  };
  const projectsInOrder: Array<string | undefined> = [];
  for (const a of order) {
    const p = info(a).projectId;
    if (!projectsInOrder.includes(p)) projectsInOrder.push(p);
  }
  const sorted = projectsInOrder.flatMap((p) => order.filter((a) => info(a).projectId === p));
  const laneOf = (alias?: string) => (alias ? sorted.indexOf(alias) + 1 : 0);
  const out: LaneRow[] = rows.map(({ alias, fromAlias, ...r }) => ({ ...r, lane: laneOf(alias), ...(fromAlias ? { from: laneOf(fromAlias) } : {}) }));
  const lanes: Lane[] = sorted.map((alias, k) => {
    const idx = out.map((r, n) => (r.lane === k + 1 || r.from === k + 1 ? n : -1)).filter((n) => n >= 0);
    return { ...info(alias), first: idx[0], last: idx[idx.length - 1] };
  });
  return { lanes, rows: out };
}
