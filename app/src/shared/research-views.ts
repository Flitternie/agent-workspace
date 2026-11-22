// A node's view on the research page: markdown with blocks in it, kept in .research/views/<node>.md.
// Agents (or people) write and rewrite it, so each research shows what matters to it; the page renders
// it at once. Blocks are fenced code blocks:
//   ```research:<kind>  [json options]```   live, drawn from the tree (a table follows new methods, datasets)
//   ```html  [height]```                     an agent's own HTML, isolated, styled like the rest
// A node with no view shows its level's template; a template can be put in place and then edited.
import { aspectOf, childrenOf, type ResearchDoc, type ResearchNode, type ResearchResult } from './research';

export type ViewBlockKind = 'summary' | 'notes' | 'kpis' | 'children' | 'table' | 'findings' | 'design' | 'result' | 'evidence';
export const VIEW_BLOCKS: ViewBlockKind[] = ['summary', 'notes', 'kpis', 'children', 'table', 'findings', 'design', 'result', 'evidence'];

export type ViewPart = { type: 'md'; text: string } | { type: 'block'; kind: ViewBlockKind; options: Record<string, unknown>; error?: string } | { type: 'html'; html: string; height?: number };

/** The view's parts in order: markdown between blocks, and the blocks. */
export function parseView(text: string): ViewPart[] {
  const out: ViewPart[] = [];
  const re = /^```(research:([a-z]+)|html)[ \t]*([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ type: 'md', text: text.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[1] === 'html') {
      const h = Number(m[3].trim());
      out.push({ type: 'html', html: m[4], ...(h > 0 ? { height: Math.min(2000, h) } : {}) });
      continue;
    }
    const kind = m[2] as ViewBlockKind;
    const body = (m[4].trim() || m[3].trim()) || '{}';
    if (!VIEW_BLOCKS.includes(kind)) {
      out.push({ type: 'block', kind, options: {}, error: `No block "research:${m[2]}". Blocks: ${VIEW_BLOCKS.join(', ')}.` });
      continue;
    }
    try {
      const options = JSON.parse(body) as Record<string, unknown>;
      out.push({ type: 'block', kind, options: options && typeof options === 'object' ? options : {} });
    } catch {
      out.push({ type: 'block', kind, options: {}, error: `The options of research:${kind} are not JSON.` });
    }
  }
  if (last < text.length) out.push({ type: 'md', text: text.slice(last) });
  return out.filter((p) => p.type !== 'md' || p.text.trim());
}

// ------------------------------------------------------------------ templates

export type ViewLevel = 'goal' | 'aspect' | 'method' | 'experiment';
export interface ViewTemplate {
  id: string;
  levels: ViewLevel[];
  name: { en: string; zh: string };
  text: string;
}

const block = (kind: ViewBlockKind, options?: Record<string, unknown>) => `\`\`\`research:${kind}${options ? `\n${JSON.stringify(options)}\n` : '\n'}\`\`\``;

/** The views a node starts from (the first of its level is what it shows with none of its own). */
export const VIEW_TEMPLATES: ViewTemplate[] = [
  { id: 'overview', levels: ['goal'], name: { en: 'Overview', zh: '概览' }, text: [block('summary'), block('children'), block('evidence')].join('\n\n') },
  { id: 'aspect', levels: ['aspect'], name: { en: 'Aspect', zh: '方面' }, text: [block('kpis'), block('notes'), block('children')].join('\n\n') },
  { id: 'method', levels: ['method'], name: { en: 'Method', zh: '方法' }, text: [block('design'), block('kpis'), block('children'), block('findings')].join('\n\n') },
  { id: 'experiment', levels: ['experiment'], name: { en: 'Experiment', zh: '实验' }, text: [block('result'), block('design'), block('findings')].join('\n\n') },
  {
    id: 'tracker',
    levels: ['goal', 'aspect', 'method'],
    name: { en: 'Metric tracker', zh: '核心指标追踪' },
    text: `${block('table', { rows: 'methods', metrics: '*', datasets: '*', cell: 'best' })}\n\n${block('findings')}`,
  },
  { id: 'notes', levels: ['goal', 'aspect', 'method', 'experiment'], name: { en: 'Notes only', zh: '只看笔记' }, text: `${block('notes')}` },
];

export const levelOf = (node?: ResearchNode): ViewLevel => (!node ? 'goal' : node.type);
export const templatesFor = (level: ViewLevel) => VIEW_TEMPLATES.filter((t) => t.levels.includes(level));
export const defaultView = (level: ViewLevel) => templatesFor(level)[0].text;
/** The key a node's view is kept under. */
export const viewKey = (node?: ResearchNode) => node?.id ?? 'goal';

// ------------------------------------------------------------------ results and live tables

/** An experiment's results: recorded ones, and its value / values on metrics (no dataset). */
export function resultsOf(doc: ResearchDoc, e: ResearchNode): ResearchResult[] {
  const out: ResearchResult[] = [...(e.results ?? [])];
  const m = aspectOf(doc, e)?.metric;
  const has = (metric: string) => out.some((r) => r.metric === metric && !r.dataset);
  if (m && e.value != null && !has(m.name)) out.push({ metric: m.name, value: e.value });
  for (const [k, v] of Object.entries(e.values ?? {})) if (!has(k)) out.push({ metric: k, value: v });
  return out;
}

export interface TableSpec {
  /** What a row is: the methods (default) or the experiments under the node, or the aspects. */
  rows?: 'methods' | 'experiments' | 'aspects';
  /** The node the rows are under (default: the node the view is on). */
  under?: string;
  /** Metrics as columns, in order; "*" (default) for every one found. */
  metrics?: string[] | '*';
  /** Datasets per metric: "*" for every one found (a column each, new ones added as they come), or a list. Left out: one column per metric, over all its results. */
  datasets?: string[] | '*';
  /** A row's cell when several experiments have one: best (default), latest, mean, or sum (what was spent: cost, GPU hours). */
  cell?: 'best' | 'latest' | 'mean' | 'sum';
  /** Metrics that are added up whatever `cell` says (resources used). */
  sum?: string[];
  /** Metrics where lower is better (else as the aspect's metric says, else higher). */
  lower?: string[];
  title?: string;
}

export interface LiveTable {
  title?: string;
  /** `all`: over every dataset (no split asked for). */
  columns: Array<{ metric: string; dataset?: string; all?: boolean; lowerIsBetter: boolean }>;
  rows: Array<{ node: ResearchNode; cells: Array<number | undefined> }>;
  /** Per column, the row index of the best value. */
  best: Array<number | undefined>;
}

/** Everything a row stands for: its experiments (a method's, an aspect's, or the experiment itself). */
function experimentsOf(doc: ResearchDoc, n: ResearchNode): ResearchNode[] {
  if (n.type === 'experiment') return [n];
  const kids = childrenOf(doc, n.id);
  return kids.flatMap((k) => experimentsOf(doc, k));
}

function rowsFor(doc: ResearchDoc, under: ResearchNode | undefined, kind: NonNullable<TableSpec['rows']>): ResearchNode[] {
  const all = under ? [under, ...descendants(doc, under)] : doc.nodes;
  const want = kind === 'methods' ? 'method' : kind === 'experiments' ? 'experiment' : 'aspect';
  return all.filter((n) => n.type === want);
}

function descendants(doc: ResearchDoc, n: ResearchNode): ResearchNode[] {
  return childrenOf(doc, n.id).flatMap((k) => [k, ...descendants(doc, k)]);
}

export function liveTable(doc: ResearchDoc, at: ResearchNode | undefined, spec: TableSpec): LiveTable {
  const under = spec.under ? doc.nodes.find((n) => n.id === spec.under) : at;
  const rowNodes = rowsFor(doc, under, spec.rows ?? 'methods');
  const per = rowNodes.map((n) => experimentsOf(doc, n).flatMap((e) => resultsOf(doc, e).map((r) => ({ ...r, at: e.resultAt ?? e.createdAt }))));
  const found: Array<{ metric: string; dataset?: string }> = [];
  for (const r of per.flat()) if (!found.some((c) => c.metric === r.metric && c.dataset === r.dataset)) found.push({ metric: r.metric, dataset: r.dataset });
  const metrics = Array.isArray(spec.metrics) ? spec.metrics : [...new Set(found.map((c) => c.metric))];
  const columns: LiveTable['columns'] = [];
  const lowerOf = (metric: string) => spec.lower?.includes(metric) ?? doc.nodes.some((n) => n.type === 'aspect' && n.metric?.name === metric && !n.metric.higherIsBetter);
  for (const metric of metrics) {
    const ds = found.filter((c) => c.metric === metric).map((c) => c.dataset);
    const wanted = Array.isArray(spec.datasets) ? spec.datasets : spec.datasets === '*' && ds.length ? [...new Set(ds)] : [undefined];
    for (const dataset of wanted) columns.push({ metric, ...(dataset ? { dataset } : {}), ...(spec.datasets === undefined ? { all: true } : {}), lowerIsBetter: lowerOf(metric) });
  }
  const rows = rowNodes.map((node, i) => ({
    node,
    cells: columns.map((c) => {
      const hits = per[i].filter((r) => r.metric === c.metric && (c.all || (r.dataset ?? undefined) === (c.dataset ?? undefined)));
      if (!hits.length) return undefined;
      if (spec.cell === 'latest') return [...hits].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!.value;
      if (spec.cell === 'mean') return hits.reduce((s, h) => s + h.value, 0) / hits.length;
      if (spec.cell === 'sum' || spec.sum?.includes(c.metric)) return hits.reduce((s, h) => s + h.value, 0);
      return hits.reduce((b, h) => ((c.lowerIsBetter ? h.value < b : h.value > b) ? h.value : b), hits[0].value);
    }),
  }));
  // Rows with nothing in any column stay out (a method not tried yet), unless every row is empty.
  const shown = rows.some((r) => r.cells.some((v) => v != null)) ? rows.filter((r) => r.cells.some((v) => v != null)) : rows;
  const best = columns.map((c, j) => {
    let bi: number | undefined;
    shown.forEach((r, i) => {
      const v = r.cells[j];
      if (v == null) return;
      if (bi == null || (c.lowerIsBetter ? v < shown[bi].cells[j]! : v > shown[bi].cells[j]!)) bi = i;
    });
    return bi;
  });
  return { ...(spec.title ? { title: spec.title } : {}), columns, rows: shown, best };
}
