// A research's own interface settings, kept in .research/ui.json and changed while it runs (by its lead,
// when the user asks): what the levels and states are called, each level's question, what a node shows
// in the graph, the totals at the top, each level's default view. Applied at the next render; every
// change keeps the version before it (undo); anything not understood falls back to the built-in.
// Settings and views only: no code is taken from here.
import { childrenOf, type ResearchDoc, type ResearchNode, type ResearchStatus } from './research';
import { resultsOf } from './research-views';

export type UiLevel = 'aspect' | 'method' | 'experiment';
/** What a total or a node's number is made of. */
export type UiHow = 'sum' | 'best' | 'latest' | 'mean' | 'count';

export interface UiStat {
  label?: string;
  metric: string;
  dataset?: string;
  how?: UiHow;
  /** For best: lower is better. */
  lower?: boolean;
  /** Decimals shown (default: up to 2). */
  digits?: number;
  unit?: string;
}

/** A piece of a node's second line: a built-in one, or a number from its results. */
export type UiNodeField = 'takeaway' | 'agent' | 'tally' | 'findings' | UiStat;

export interface ResearchUi {
  /** What the levels are called (singular; `plural` for the depth switch and counts). */
  labels?: Partial<Record<UiLevel, string>>;
  plural?: Partial<Record<UiLevel, string>>;
  /** What the states are called. */
  statuses?: Partial<Record<ResearchStatus, string>>;
  /** The question at the top of each level's panel ("{title}" is the node's). */
  questions?: Partial<Record<'goal' | UiLevel, string>>;
  /** What a node's second line shows in the graph, in order (an agent running or waiting always comes first). */
  node?: Partial<Record<UiLevel, UiNodeField[]>>;
  /** Totals shown at the top of the page. */
  header?: UiStat[];
  /** Each level's view when a node has none of its own (markdown with blocks, as research_view writes). */
  views?: Partial<Record<'goal' | UiLevel, string>>;
}

export interface UiFile extends ResearchUi {
  /** The versions before, newest last (undo takes the last). */
  history?: Array<{ at: string; ui: ResearchUi }>;
}

const LEVELS: UiLevel[] = ['aspect', 'method', 'experiment'];
const STATUSES: ResearchStatus[] = ['idea', 'running', 'pass', 'fail', 'unclear', 'error'];
const HOWS: UiHow[] = ['sum', 'best', 'latest', 'mean', 'count'];
const BUILTIN = ['takeaway', 'agent', 'tally', 'findings'];

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v : undefined);
function strings<K extends string>(v: unknown, keys: readonly K[], max = 200): Partial<Record<K, string>> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const s = str((v as Record<string, unknown>)[k], max);
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}
function stat(v: unknown): UiStat | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const metric = str(r.metric);
  if (!metric) return undefined;
  return {
    metric,
    ...(str(r.label, 60) ? { label: str(r.label, 60) } : {}),
    ...(str(r.dataset) ? { dataset: str(r.dataset) } : {}),
    ...(HOWS.includes(r.how as UiHow) ? { how: r.how as UiHow } : {}),
    ...(r.lower === true ? { lower: true } : {}),
    ...(typeof r.digits === 'number' && r.digits >= 0 && r.digits <= 6 ? { digits: Math.round(r.digits) } : {}),
    ...(str(r.unit, 20) ? { unit: str(r.unit, 20) } : {}),
  };
}

/** The settings as understood: anything else is left out (the built-in shows instead). */
export function normalizeUi(raw: unknown): ResearchUi {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: ResearchUi = {};
  const labels = strings(r.labels, LEVELS, 40);
  if (labels) out.labels = labels;
  const plural = strings(r.plural, LEVELS, 40);
  if (plural) out.plural = plural;
  const statuses = strings(r.statuses, STATUSES, 40);
  if (statuses) out.statuses = statuses;
  const questions = strings(r.questions, ['goal', ...LEVELS] as const, 300);
  if (questions) out.questions = questions;
  const views = strings(r.views, ['goal', ...LEVELS] as const, 20_000);
  if (views) out.views = views;
  if (r.node && typeof r.node === 'object') {
    const node: ResearchUi['node'] = {};
    for (const l of LEVELS) {
      const list = (r.node as Record<string, unknown>)[l];
      if (!Array.isArray(list)) continue;
      const fields = list.map((f) => (typeof f === 'string' && BUILTIN.includes(f) ? (f as UiNodeField) : stat(f))).filter((f): f is UiNodeField => !!f).slice(0, 4);
      if (fields.length) node[l] = fields;
    }
    if (Object.keys(node).length) out.node = node;
  }
  if (Array.isArray(r.header)) {
    const header = r.header.map(stat).filter((s): s is UiStat => !!s).slice(0, 6);
    if (header.length) out.header = header;
  }
  return out;
}

/** The file's text as settings and their history; unreadable text is no settings. */
export function parseUiFile(text?: string): UiFile {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const history = Array.isArray(raw?.history) ? raw.history.filter((h) => h && typeof h.at === 'string').map((h) => ({ at: String(h.at), ui: normalizeUi(h.ui) })) : [];
    return { ...normalizeUi(raw), ...(history.length ? { history } : {}) };
  } catch {
    return {};
  }
}
export const parseUi = (text?: string): ResearchUi => {
  const { history: _history, ...ui } = parseUiFile(text);
  return ui;
};

const HISTORY = 20;
/** The file after a change: `patch` merged in (a key set to null goes back to the built-in). */
export function changeUi(file: UiFile, patch: Record<string, unknown>, at: string): UiFile {
  const { history = [], ...now } = file;
  const merged: Record<string, unknown> = { ...now };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object' && !Array.isArray(merged[k])) {
      const inner: Record<string, unknown> = { ...(merged[k] as object) };
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 === null) delete inner[k2];
        else inner[k2] = v2;
      }
      merged[k] = inner;
    } else merged[k] = v;
  }
  return { ...normalizeUi(merged), history: [...history, { at, ui: now }].slice(-HISTORY) };
}
/** The file with its last change taken back; null when there is none. */
export function undoUi(file: UiFile): UiFile | null {
  const { history = [] } = file;
  const last = history.at(-1);
  if (!last) return null;
  return { ...last.ui, ...(history.length > 1 ? { history: history.slice(0, -1) } : {}) };
}

// ------------------------------------------------------------------ numbers from results

/** A number for a node (or the whole research): from the results of the experiments under it. */
export function statValue(doc: ResearchDoc, node: ResearchNode | undefined, s: UiStat): number | undefined {
  const under = (n: ResearchNode): ResearchNode[] => (n.type === 'experiment' ? [n] : childrenOf(doc, n.id).flatMap(under));
  const exps = node ? under(node) : doc.nodes.filter((n) => n.type === 'experiment');
  const hits = exps.flatMap((e) => resultsOf(doc, e).filter((r) => r.metric === s.metric && (!s.dataset || r.dataset === s.dataset)).map((r) => ({ value: r.value, at: e.resultAt ?? e.createdAt })));
  const how = s.how ?? 'best';
  if (how === 'count') return hits.length;
  if (!hits.length) return undefined;
  if (how === 'sum') return hits.reduce((a, h) => a + h.value, 0);
  if (how === 'mean') return hits.reduce((a, h) => a + h.value, 0) / hits.length;
  if (how === 'latest') return [...hits].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!.value;
  const lower = s.lower ?? doc.nodes.some((n) => n.type === 'aspect' && n.metric?.name === s.metric && !n.metric.higherIsBetter);
  return hits.reduce((b, h) => ((lower ? h.value < b : h.value > b) ? h.value : b), hits[0].value);
}

export function statText(doc: ResearchDoc, node: ResearchNode | undefined, s: UiStat): string {
  const v = statValue(doc, node, s);
  if (v == null) return '';
  const digits = s.digits ?? Math.min(2, (String(v).split('.')[1] ?? '').length);
  return `${s.label ?? s.metric} ${v.toFixed(digits)}${s.unit ?? ''}`;
}
