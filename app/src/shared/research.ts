// A research: the tree of what is being tried in one project, kept in the project's repository
// (.research/research.json) so it travels with the code. Levels answer different questions:
//   the goal     which aspects move the end result? (evidence: end-to-end runs and ablations)
//   an aspect    which methods are there, which to try next? (its own validation)
//   a method     how is it designed, how well does it work? (its experiments)
//   an experiment one run, by one agent in its own worktree; findings hang on it.
// Methods can come from others: a combination, a mutation, or an idea borrowed across aspects.
// Pure data and functions, shared by the main process (files) and the renderer (the page).

export type ResearchNodeType = 'aspect' | 'method' | 'experiment';
/**
 * idea: not tried yet · running · pass/fail: by the aspect's own validation · unclear: the difference
 * is within the noise (only known when there are repeated runs, or the user said how noisy the metric is)
 * · error: no result.
 */
export type ResearchStatus = 'idea' | 'running' | 'pass' | 'fail' | 'unclear' | 'error';
export type ResearchLinkKind = 'combine' | 'mutate' | 'borrow';

export interface ResearchMetric {
  name: string;
  higherIsBetter: boolean;
  /** Where the aspect starts (what an experiment is compared with). */
  baseline?: number;
  digits?: number;
  /** How noisy one run is (a typical standard deviation), when the user says so: a single result closer than this to the start is unclear. */
  noise?: number;
}

export interface ResearchFinding {
  id: string;
  text: string;
  /** Who wrote it: an agent's alias, or "you". */
  by?: string;
  at: string;
}

export interface ResearchLink {
  /** The method this one comes from. */
  from: string;
  kind: ResearchLinkKind;
  note?: string;
}

export interface ResearchNode {
  id: string;
  type: ResearchNodeType;
  /** Aspects hang on the goal (null); methods on an aspect; experiments on a method. */
  parent: string | null;
  title: string;
  status: ResearchStatus;
  /** The agent doing it (an aspect's agent, an experiment's agent). Methods are their aspect agent's. */
  taskId?: string;
  /** Aspect: how it is validated (none: by judgement, pass / fail). */
  metric?: ResearchMetric;
  /** Aspect: more metrics watched besides the main one (shown, not used to judge). */
  metrics?: ResearchMetric[];
  /** Aspect: the row of cross-aspect combinations (validated end to end). */
  combos?: boolean;
  /** What it comes to, in one line (kept by its agent): what the graph shows once there is something to say. */
  takeaway?: string;
  /** Method: its design, a few lines. */
  design?: string;
  /** Method: where the idea came from when not tried yet (an agent, a paper). */
  source?: string;
  /** Method: what it was combined from, mutated from, or borrows. */
  links?: ResearchLink[];
  /** Experiment: what this variant changes. */
  config?: string;
  /** Experiment: its result on the aspect's metric (the mean, when it was run several times). */
  value?: number;
  /** Experiment: each run's result, when the user asked for repeats. */
  runs?: number[];
  /** Experiment: results on the aspect's other metrics, by name. */
  values?: Record<string, number>;
  /** Experiment: results by metric and dataset (a benchmark, a split): what live tables are made of, kept and reused. */
  results?: ResearchResult[];
  /** Experiment: when its result was recorded. */
  resultAt?: string;
  findings?: ResearchFinding[];
  createdAt: string;
}

/** An end-to-end run or an ablation: the evidence for which aspects matter. */
export interface ResearchEvidence {
  id: string;
  kind: 'e2e' | 'ablation';
  title: string;
  value: number;
  /** Against the run it is compared with, in the end metric's units. */
  delta: number;
  /** Ablation: the aspect whose changes were taken out. */
  aspect?: string;
  at: string;
}

/**
 * How this research is run: the user's call, changed by telling its lead. The tools and the page are
 * the same whatever is chosen; these only tell the agents how much to ask, and what to keep up to date.
 *   auto: agents go ahead on their own (within the budget) and say what they started
 *   direction: they ask the user before exploring a new direction
 *   review: they propose experiments and start them when the user agrees
 *   collaborative: both
 */
export type ResearchMode = 'auto' | 'direction' | 'review' | 'collaborative';
export interface ResearchPolicy {
  mode?: ResearchMode;
  /** Ask an aspect's agent for its notes when a batch of experiments has its results (default on). */
  autoNotes?: boolean;
  /** Ask the lead to fold the aspects' notes into the summary at most this often, in minutes (0: never; default 30). */
  summaryEvery?: number;
}
export const DEFAULT_MODE: ResearchMode = 'review';

export interface ResearchDoc {
  version: 1;
  title: string;
  goal: string;
  /** The research's own lead: the agent the user talks to about the whole of it (lays out the tree, keeps the summary). */
  leadTaskId?: string;
  policy?: ResearchPolicy;
  /** Its colour (an index into RESEARCH_COLORS): tells several researches apart in the sidebar and on their pages. */
  color?: number;
  /** The end-to-end metric, when there is one. */
  endMetric?: ResearchMetric;
  nodes: ResearchNode[];
  evidence: ResearchEvidence[];
  createdAt: string;
  updatedAt: string;
}

/** The markdown kept beside the tree: the research's summary and each aspect's notes. */
export interface ResearchNote {
  text: string;
  updatedAt: string;
}
export interface ResearchNotes {
  summary?: ResearchNote;
  /** By aspect id. */
  aspects: Record<string, ResearchNote>;
  /** The research's own memory (memory.md): rules, definitions and decisions that hold for this research only. */
  memory?: ResearchNote;
  /** The research's interface settings, as JSON (research-ui.ts). */
  ui?: ResearchNote;
  /** Each node's view on the page, by node id ("goal" for the goal): blocks in markdown (research-views.ts). */
  views?: Record<string, ResearchNote>;
}

/** One number an experiment produced: on a metric, on a dataset if there are several. */
export interface ResearchResult {
  metric: string;
  dataset?: string;
  value: number;
}

/** Results recorded since a note was last written: how far behind it is. */
export function resultsSince(doc: ResearchDoc, since: string | undefined, aspectId?: string): number {
  const t = since ? Date.parse(since) : 0;
  return doc.nodes.filter((n) => n.type === 'experiment' && (n.status === 'pass' || n.status === 'fail' || n.status === 'unclear' || n.status === 'error') && Date.parse(n.resultAt ?? n.createdAt) > t && (!aspectId || aspectOf(doc, n)?.id === aspectId)).length;
}

/**
 * A research's id: its project's, for the one at the project's root; "<project>::<folder>" for one kept
 * in a folder of the project (a project holding several repositories: one research per repository).
 */
export const researchId = (projectId: string, dir?: string): string => (dir ? `${projectId}::${dir}` : projectId);
export function parseResearchId(id: string): { projectId: string; dir?: string } {
  const at = id.indexOf('::');
  return at < 0 ? { projectId: id } : { projectId: id.slice(0, at), dir: id.slice(at + 2) };
}
/** A folder a research may live in: relative, inside the project, plain names. */
export const isResearchDir = (dir: string): boolean => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(dir) && !dir.split('/').some((s) => s === '.' || s === '..' || s === '.research');

/** The colours researches are told apart by: distinct hues, each readable with white on it. */
export const RESEARCH_COLORS = ['#2f6fdb', '#0f8a7e', '#b4541a', '#8a4fd8', '#c0365a', '#5f7a1f', '#a07a12', '#3a5a8c'] as const;
/** A research's colour: its own, else one picked from its id (for one made before colours). */
export function researchColor(r: { id: string; color?: number }): string {
  if (r.color != null && RESEARCH_COLORS[r.color]) return RESEARCH_COLORS[r.color];
  let h = 0;
  for (const c of r.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return RESEARCH_COLORS[h % RESEARCH_COLORS.length];
}
/** The colour for a new research: the first not used by the others (they repeat only past eight). */
export function nextResearchColor(used: Array<number | undefined>): number {
  const free = RESEARCH_COLORS.findIndex((_, i) => !used.includes(i));
  return free >= 0 ? free : used.length % RESEARCH_COLORS.length;
}

/** What the sidebar needs without reading the file: that there is one, and whose agents are in it. */
export interface ResearchSummary {
  /** Its colour index, if it has one (researchColor). */
  color?: number;
  /** The research's id (researchId). */
  id: string;
  projectId: string;
  /** The folder it is kept in, for one not at the project's root. */
  dir?: string;
  /** How many of its agents still work at the project root (started before its agents ran in its folder). */
  atRoot?: number;
  title: string;
  taskIds: string[];
  /** Changes when the tree does (an agent's tool call, an edit): the page reads it again. */
  updatedAt?: string;
  /** Changes when a note does. */
  notesAt?: string;
}

export const childrenOf = (doc: ResearchDoc, id: string | null): ResearchNode[] => doc.nodes.filter((n) => n.parent === id);
export const aspectOf = (doc: ResearchDoc, node: ResearchNode): ResearchNode | undefined => {
  let n: ResearchNode | undefined = node;
  while (n && n.type !== 'aspect') n = doc.nodes.find((x) => x.id === n!.parent);
  return n;
};
export const taskIdsOf = (doc: ResearchDoc): string[] => [...new Set([doc.leadTaskId, ...doc.nodes.map((n) => n.taskId)].filter((x): x is string => !!x))];

export function formatValue(metric: ResearchMetric | undefined, v: number | undefined): string {
  if (v == null) return '—';
  return metric?.digits != null ? v.toFixed(metric.digits) : String(+v.toFixed(4));
}

const better = (m: ResearchMetric, a: number, b: number) => (m.higherIsBetter ? a > b : a < b);

/** Mean, standard deviation and count of repeated runs. */
export function runStats(runs: number[]): { mean: number; sd: number; n: number } {
  const n = runs.length;
  const mean = runs.reduce((a, b) => a + b, 0) / (n || 1);
  const sd = n > 1 ? Math.sqrt(runs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd, n };
}

/**
 * Whether a result passes its aspect's validation: better than the start (with a metric), else judged.
 * Within the noise it is unclear; the noise is the runs' own spread when there are several, or what the
 * user said the metric's noise is. One run with no declared noise is simply better or not.
 */
export function judge(metric: ResearchMetric | undefined, value: number, runs?: number[]): ResearchStatus {
  if (!metric || metric.baseline == null) return 'pass';
  const noise = runs && runs.length > 1 ? runStats(runs).sd : metric.noise;
  if (noise && Math.abs(value - metric.baseline) < noise) return 'unclear';
  return better(metric, value, metric.baseline) ? 'pass' : 'fail';
}

/**
 * An experiment's status, with its agent's: running while the agent works. A result recorded on the
 * node (pass / fail / error) is what it found; an agent that stopped without one leaves it as it was.
 */
export function experimentStatus(node: ResearchNode, agentStatus?: string): ResearchStatus {
  if (node.status === 'pass' || node.status === 'fail' || node.status === 'unclear' || node.status === 'error') return node.status;
  if (agentStatus === 'running' || agentStatus === 'starting' || agentStatus === 'waiting_for_user') return 'running';
  return node.status;
}

/** The best experiment of a method, on its aspect's metric. */
export function bestExperiment(doc: ResearchDoc, method: ResearchNode): ResearchNode | undefined {
  const m = aspectOf(doc, method)?.metric;
  const done = childrenOf(doc, method.id).filter((e) => e.value != null && e.status !== 'error');
  if (!done.length) return undefined;
  if (!m) return done.find((e) => e.status === 'pass') ?? done[0];
  return [...done].sort((a, b) => (better(m, a.value!, b.value!) ? -1 : better(m, b.value!, a.value!) ? 1 : 0))[0];
}

/** A method's status from its experiments: running if any runs, pass if any passed, idea if none yet. */
export function methodStatus(doc: ResearchDoc, method: ResearchNode, statusOf: (n: ResearchNode) => ResearchStatus = (n) => n.status): ResearchStatus {
  const exps = childrenOf(doc, method.id);
  if (!exps.length) return method.status === 'idea' ? 'idea' : method.status;
  const s = exps.map(statusOf);
  if (s.includes('running')) return 'running';
  if (s.includes('pass')) return 'pass';
  if (s.includes('unclear')) return 'unclear';
  if (s.every((x) => x === 'idea')) return 'idea';
  return 'fail';
}

export interface AspectContribution {
  aspect: ResearchNode;
  /** Estimated contribution to the end result (what taking it out cost), in the end metric's units. */
  estimate: number | null;
  /** Ablations behind it: one is a hint, several make it believable. */
  evidence: number;
}

/** Which aspects move the end result, from ablations (taking an aspect's changes out). */
export function contributions(doc: ResearchDoc): AspectContribution[] {
  return childrenOf(doc, null)
    .filter((a) => a.type === 'aspect' && !a.combos)
    .map((aspect) => {
      const abl = doc.evidence.filter((e) => e.kind === 'ablation' && e.aspect === aspect.id);
      const estimate = abl.length ? -abl.reduce((s, e) => s + e.delta, 0) / abl.length : null;
      return { aspect, estimate, evidence: abl.length };
    })
    .sort((a, b) => (b.estimate ?? -Infinity) - (a.estimate ?? -Infinity));
}

// ------------------------------------------------------------------ graph layout

export type GraphDepth = 'aspect' | 'method' | 'experiment';

export interface GraphItem {
  /** 'goal' is the root; 'runs' stands for a method's experiments, folded into one. */
  kind: 'goal' | ResearchNodeType | 'runs';
  id: string;
  node?: ResearchNode;
  /** 'runs': the folded experiments. */
  runs?: ResearchNode[];
  depth: number;
  x: number;
  y: number;
  children: GraphItem[];
}

export interface GraphLayout {
  items: GraphItem[];
  /** Where each node is drawn (a folded experiment: at its 'runs' item). */
  at: Map<string, GraphItem>;
  width: number;
  height: number;
}

export const GRAPH = { nodeW: 216, nodeH: 54, colGap: 268, rowGap: 68 } as const;

/** What the graph is laid out by, beyond its depth: who is at work, and whether only that is shown. */
export interface GraphActivity {
  /** Nodes with something going on (an agent running or waiting on the user), and their ancestors. */
  active: ReadonlySet<string>;
  /** Only what is going on. */
  only?: boolean;
}

/**
 * Left to right: the goal, aspects, methods, experiments. Down to `depth`; a method's experiments fold
 * into one item unless shown one by one (the experiment depth, or that method opened). Experiments with
 * something going on are always shown one by one (the rest of their method's stay folded): with many
 * running in parallel, what is in progress is what is on the page.
 */
export function layoutGraph(doc: ResearchDoc, depth: GraphDepth, opened: ReadonlySet<string> = new Set(), activity?: GraphActivity): GraphLayout {
  const items: GraphItem[] = [];
  const at = new Map<string, GraphItem>();
  let row = 0;
  const build = (kind: GraphItem['kind'], id: string, node: ResearchNode | undefined, d: number): GraphItem => {
    const item: GraphItem = { kind, id, node, depth: d, x: 0, y: 0, children: [] };
    const live = (n: ResearchNode) => !!activity?.active.has(n.id);
    const shown = (n: ResearchNode) => !activity?.only || live(n);
    if (kind === 'goal') for (const a of childrenOf(doc, null).filter(shown)) item.children.push(build('aspect', a.id, a, d + 1));
    if (kind === 'aspect' && (depth !== 'aspect' || activity?.only)) for (const m of childrenOf(doc, id).filter(shown)) item.children.push(build('method', m.id, m, d + 1));
    if (kind === 'method') {
      const exps = childrenOf(doc, id);
      if (depth === 'experiment' || opened.has(id)) for (const e of exps.filter(shown)) item.children.push(build('experiment', e.id, e, d + 1));
      else {
        for (const e of exps.filter(live)) item.children.push(build('experiment', e.id, e, d + 1));
        const rest = exps.filter((e) => !live(e));
        if (rest.length && !activity?.only) item.children.push({ kind: 'runs', id: `runs:${id}`, runs: rest, depth: d + 1, x: 0, y: 0, children: [] });
      }
    }
    return item;
  };
  const place = (it: GraphItem) => {
    if (!it.children.length) it.y = row++ * GRAPH.rowGap;
    else {
      it.children.forEach(place);
      it.y = (it.children[0].y + it.children[it.children.length - 1].y) / 2;
    }
    it.x = it.depth * GRAPH.colGap;
    items.push(it);
    at.set(it.id, it);
    for (const r of it.runs ?? []) at.set(r.id, it);
  };
  place(build('goal', 'goal', undefined, 0));
  const width = Math.max(...items.map((i) => i.x)) + GRAPH.nodeW;
  const height = Math.max(...items.map((i) => i.y)) + GRAPH.nodeH;
  return { items, at, width, height };
}

// ------------------------------------------------------------------ edits (pure: a new doc each time)

let seq = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`;
const stamp = (doc: ResearchDoc): ResearchDoc => ({ ...doc, updatedAt: new Date().toISOString() });

export function addNode(doc: ResearchDoc, node: Omit<ResearchNode, 'id' | 'createdAt'> & { id?: string }): { doc: ResearchDoc; node: ResearchNode } {
  const n: ResearchNode = { ...node, id: node.id ?? newId(node.type[0]), createdAt: new Date().toISOString() };
  return { doc: stamp({ ...doc, nodes: [...doc.nodes, n] }), node: n };
}

export function updateNode(doc: ResearchDoc, id: string, patch: Partial<ResearchNode>): ResearchDoc {
  return stamp({ ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
}

/** Takes a node out with everything under it (the file keeps no trace; git history does). */
export function removeNode(doc: ResearchDoc, id: string): ResearchDoc {
  const gone = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of doc.nodes) if (n.parent && gone.has(n.parent) && !gone.has(n.id)) (gone.add(n.id), (grew = true));
  }
  return stamp({
    ...doc,
    nodes: doc.nodes.filter((n) => !gone.has(n.id)).map((n) => (n.links?.some((l) => gone.has(l.from)) ? { ...n, links: n.links.filter((l) => !gone.has(l.from)) } : n)),
  });
}

export function addFinding(doc: ResearchDoc, id: string, text: string, by?: string): ResearchDoc {
  const n = doc.nodes.find((x) => x.id === id);
  if (!n) return doc;
  return updateNode(doc, id, { findings: [...(n.findings ?? []), { id: newId('f'), text, by, at: new Date().toISOString() }] });
}

export function emptyResearch(title: string, goal: string): ResearchDoc {
  const now = new Date().toISOString();
  return { version: 1, title, goal, nodes: [], evidence: [], createdAt: now, updatedAt: now };
}

/** A file read from disk: what is missing gets its default, so an older or hand-edited file still opens. */
export function normalizeResearch(raw: unknown): ResearchDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ResearchDoc>;
  if (typeof r.title !== 'string') return null;
  const now = new Date().toISOString();
  return {
    version: 1,
    title: r.title,
    goal: typeof r.goal === 'string' ? r.goal : '',
    ...(typeof r.leadTaskId === 'string' ? { leadTaskId: r.leadTaskId } : {}),
    ...(r.policy && typeof r.policy === 'object' ? { policy: r.policy } : {}),
    ...(typeof r.color === "number" && Number.isInteger(r.color) && r.color >= 0 && r.color < RESEARCH_COLORS.length ? { color: r.color } : {}),
    endMetric: r.endMetric,
    nodes: Array.isArray(r.nodes) ? r.nodes.filter((n): n is ResearchNode => !!n && typeof n.id === 'string' && typeof n.title === 'string' && ['aspect', 'method', 'experiment'].includes(n.type)).map((n) => ({ ...n, status: n.status ?? 'idea', createdAt: n.createdAt ?? now })) : [],
    evidence: Array.isArray(r.evidence) ? r.evidence.filter((e) => !!e && typeof e.value === 'number') : [],
    createdAt: r.createdAt ?? now,
    updatedAt: r.updatedAt ?? now,
  };
}

// ------------------------------------------------------------------ who a message goes to

/** The node and its ancestors, nearest first (aspects end the chain; their parent is the goal). */
export function ancestry(doc: ResearchDoc, node: ResearchNode): ResearchNode[] {
  const out: ResearchNode[] = [];
  let n: ResearchNode | undefined = node;
  while (n) {
    out.push(n);
    n = n.parent ? doc.nodes.find((x) => x.id === n!.parent) : undefined;
  }
  return out;
}

/** The nearest node every one of `nodes` is in or under; undefined: only the goal holds them all. */
export function commonAncestor(doc: ResearchDoc, nodes: ResearchNode[]): ResearchNode | undefined {
  if (!nodes.length) return undefined;
  const chains = nodes.map((n) => ancestry(doc, n));
  return chains[0].find((a) => chains.every((c) => c.some((x) => x.id === a.id)));
}

/**
 * Who talks about the selection: the agent of the nearest node over all of it. One experiment with an
 * agent: that agent. Anything within one aspect (an experiment without an agent, a method, several
 * nodes under one method or one aspect): the aspect's agent. Across aspects, the cross-aspect row,
 * or nothing selected: the research's lead.
 */
export type ResearchRoute =
  | { kind: 'experiment'; node: ResearchNode }
  | { kind: 'aspect'; aspect: ResearchNode; about: ResearchNode[] }
  | { kind: 'lead'; about: ResearchNode[] };

export function routeFor(doc: ResearchDoc, nodes: ResearchNode[]): ResearchRoute {
  const top = commonAncestor(doc, nodes);
  if (nodes.length === 1 && top?.type === 'experiment' && top.taskId) return { kind: 'experiment', node: top };
  const aspect = top && aspectOf(doc, top);
  // The aspect itself selected alone is spoken to directly, not "about" itself.
  const about = nodes.length === 1 && nodes[0] === aspect ? [] : nodes;
  if (aspect && !aspect.combos) return { kind: 'aspect', aspect, about };
  return { kind: 'lead', about: nodes };
}

// ------------------------------------------------------------------ how a result reads against the start

/** Change from the aspect's start, as a fraction, positive when better (null without a start). */
export function gain(metric: ResearchMetric | undefined, value: number | undefined): number | null {
  if (!metric || metric.baseline == null || value == null || metric.baseline === 0) return null;
  const d = (value - metric.baseline) / Math.abs(metric.baseline);
  return metric.higherIsBetter ? d : -d;
}

/**
 * How far the best working result stands out from the spread of all results (as pi-autoresearch does):
 * |best − start| / median absolute deviation. Advisory only: ≥2 likely real, 1–2 marginal, <1 within
 * the noise. Null with fewer than three results, no start, nothing working, or no spread.
 */
export function confidence(metric: ResearchMetric | undefined, exps: ResearchNode[]): number | null {
  if (!metric || metric.baseline == null) return null;
  const vals = exps.filter((e) => e.value != null && e.status !== 'error').map((e) => e.value!);
  if (vals.length < 3) return null;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const m = median(vals);
  const mad = median(vals.map((v) => Math.abs(v - m)));
  const kept = exps.filter((e) => e.status === 'pass' && e.value != null).map((e) => e.value!);
  if (!mad || !kept.length) return null;
  const best = metric.higherIsBetter ? Math.max(...kept) : Math.min(...kept);
  if (best === metric.baseline) return null;
  return Math.abs(best - metric.baseline) / mad;
}

/** Experiments under a node (a method's, an aspect's), in the order they were started. */
export function experimentsUnder(doc: ResearchDoc, node: ResearchNode): ResearchNode[] {
  if (node.type === 'experiment') return [node];
  const ids = new Set(node.type === 'aspect' ? childrenOf(doc, node.id).map((m) => m.id) : [node.id]);
  return doc.nodes.filter((n) => n.type === 'experiment' && n.parent && ids.has(n.parent)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
