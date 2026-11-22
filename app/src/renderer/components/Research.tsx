import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Task, WorkspaceSnapshot } from '../../shared/types';
import {
  aspectOf,
  bestExperiment,
  childrenOf,
  contributions,
  experimentStatus,
  formatValue,
  GRAPH,
  layoutGraph,
  methodStatus,
  resultsSince,
  routeFor,
  runStats,
  taskIdsOf,
  gain,
  confidence,
  experimentsUnder,
  type GraphDepth,
  type GraphItem,
  type ResearchDoc,
  type ResearchLinkKind,
  type ResearchMetric,
  type ResearchNode,
  type ResearchNote,
  type ResearchNotes,
  type ResearchStatus,
} from '../../shared/research';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { SideSlot } from '../side-slot';
import { Alias, Icon, PROVIDER_LABEL, STATUS_LABEL as AGENT_STATUS } from './bits';
import { Markdown } from './Markdown';
import { timeAgo } from '../state';
import { Modal } from './Dialogs';
import { Composer, PanelResizer, WaitingOnYou, type ComposerTarget } from './FocusView';
import { SidePanel } from './SidePanel';

const STATUS_LABEL: Record<ResearchStatus, string> = { idea: 'Not tried', running: 'Running', pass: 'Works', fail: 'Does not work', unclear: 'Unclear', error: 'No result' };
const LINK_LABEL: Record<ResearchLinkKind, string> = { combine: 'Combined', mutate: 'Mutated', borrow: 'Borrows' };
const PANEL_W = 380;

/**
 * A project's research as a graph: the goal, its aspects, their methods and experiments, with
 * combinations, mutations and borrowed ideas drawn across. What is selected decides both the side
 * column (each level its own question) and who the box at the bottom talks to (its agent).
 */
export function ResearchView({ snapshot, researchId, onOpenAgent }: { snapshot: WorkspaceSnapshot; researchId: string; onOpenAgent: (taskId: string) => void }) {
  const summary = snapshot.research.find((r) => r.id === researchId);
  const project = snapshot.projects.find((p) => p.projectId === summary?.projectId);
  const [doc, setDoc] = useState<ResearchDoc | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [depth, setDepth] = useState<GraphDepth>('method');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string[]>([]);
  const [panel, setPanel] = useState(true);
  const [panelW, setPanelW] = useState(PANEL_W);
  const side = useContext(SideSlot);

  // Read again whenever the tree changes (an agent's tool call writes it; the summary's stamp moves).
  const stamp = summary?.updatedAt;
  const notesStamp = summary?.notesAt;
  const [notes, setNotes] = useState<ResearchNotes>({ aspects: {} });
  useEffect(() => {
    let live = true;
    call('research:notes', { researchId })
      .then((n) => live && setNotes(n))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [researchId, notesStamp]);
  useEffect(() => {
    setSel([]);
    setDoc(undefined);
  }, [researchId]);
  useEffect(() => {
    let live = true;
    call('research:get', { researchId })
      .then((d) => live && setDoc(d))
      .catch((e) => live && (setError(errorText(e)), setDoc(null)));
    return () => {
      live = false;
    };
  }, [researchId, stamp]);

  const taskOf = (id?: string) => (id ? snapshot.tasks.find((x) => x.taskId === id) : undefined);
  const statusOf = (n: ResearchNode): ResearchStatus => (n.type === 'experiment' ? experimentStatus(n, taskOf(n.taskId)?.status) : n.type === 'method' && doc ? methodStatus(doc, n, statusOf) : n.status);

  if (!project) return null;
  if (doc === undefined) return <div className="research-empty muted">{t('Loading…')}</div>;
  if (!doc) return <div className="research-empty muted">{error || t('This project has no research yet.')}</div>;

  const selected = sel.map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is ResearchNode => !!n);
  const exps = doc.nodes.filter((n) => n.type === 'experiment');
  const count = (s: ResearchStatus) => exps.filter((e) => statusOf(e) === s).length;
  const select = (id: string, add: boolean) => setSel((cur) => (add ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur.length === 1 && cur[0] === id ? [] : [id]));

  const ctx: Ctx = { snapshot, research: researchId, doc, notes, statusOf, taskOf, select: (id) => setSel(id ? [id] : []), onOpenAgent, setError };
  /** A double-click opens the node's agent (a method's is its aspect's); with none yet, it just selects the node. */
  const openNode = (n?: ResearchNode) => {
    // The goal (no node) is the lead's.
    const id = !n ? doc.leadTaskId : n.type === 'method' ? aspectOf(doc, n)?.taskId : n.taskId;
    if (id && taskOf(id)) onOpenAgent(id);
    else setSel(n ? [n.id] : []);
  };
  const sidePanel = panel ? (
    <SidePanel
      title={selected.length > 1 ? t('{n} selected', { n: selected.length }) : selected[0] ? selected[0].title : doc.title}
      subtitle={levelName(selected)}
      label={t('Research details')}
      testId="research-panel"
      frame={{ width: panelW, onClose: () => setPanel(false) }}
    >
      <div className="research-side">{selected.length > 1 ? <MultiPanel ctx={ctx} nodes={selected} /> : selected[0] ? <NodePanel ctx={ctx} node={selected[0]} /> : <GoalPanel ctx={ctx} />}</div>
    </SidePanel>
  ) : null;

  return (
    <div className="research" data-testid="research">
      <header className="stage-head drag research-head">
        <div className="research-title">
          <h1 className="truncate">{doc.title}</h1>
          <div className="research-goal truncate" title={doc.goal}>
            {doc.goal}
          </div>
        </div>
        <div className="research-progress" title={t('{a} running · {b} work · {c} do not work', { a: count('running'), b: count('pass'), c: count('fail') + count('error') })} data-testid="research-progress">
          <span>{t('{n} experiments', { n: exps.length })}</span>
          <span className="research-bar">
            {(['pass', 'running', 'fail', 'error'] as const).map((s) => (count(s) ? <i key={s} className={`st-${s}`} style={{ width: `${(count(s) / exps.length) * 100}%` }} /> : null))}
          </span>
          <span className="muted">
            {count('running') ? t('{n} running', { n: count('running') }) + ' · ' : ''}
            {t('{n} work', { n: count('pass') })}
          </span>
        </div>
        <div className="stage-actions">
          {panel ? null : (
            <button className="btn" onClick={() => setPanel(true)} data-testid="research-panel-open">
              {t('Details')}
            </button>
          )}
        </div>
      </header>
      {error ? <div className="error-text pad">{error}</div> : null}
      {/* The graph fills the page; the box floats on it at the bottom, as on an agent's page (no band of its own). */}
      <div className="research-stage">
      <Graph doc={doc} depth={depth} setDepth={setDepth} openNode={openNode} opened={opened} toggleOpen={(id) => setOpened((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; })} sel={sel} select={select} statusOf={statusOf} taskOf={taskOf} snapshot={snapshot} />
      <ResearchComposer ctx={ctx} selected={selected} onClear={() => setSel([])} />
      </div>
      {sidePanel
        ? side
          ? createPortal(
              <>
                <PanelResizer width={panelW} room={window.innerWidth} onChange={setPanelW} reset={PANEL_W} min={320} />
                {sidePanel}
              </>,
              side,
            )
          : sidePanel
        : null}
    </div>
  );
}

interface Ctx {
  snapshot: WorkspaceSnapshot;
  /** The research's id. */
  research: string;
  doc: ResearchDoc;
  notes: ResearchNotes;
  statusOf: (n: ResearchNode) => ResearchStatus;
  taskOf: (id?: string) => Task | undefined;
  select: (id: string | null) => void;
  onOpenAgent: (taskId: string) => void;
  setError: (e: string) => void;
}

function levelName(sel: ResearchNode[]): string {
  if (sel.length > 1) return t('Several nodes');
  const n = sel[0];
  if (!n) return t('Goal');
  return n.type === 'aspect' ? (n.combos ? t('Across aspects') : t('Aspect')) : n.type === 'method' ? t('Method') : t('Experiment');
}

// ------------------------------------------------------------------ graph

function Graph({
  doc,
  depth,
  setDepth,
  openNode,
  opened,
  toggleOpen,
  sel,
  select,
  statusOf,
  taskOf,
  snapshot,
}: {
  doc: ResearchDoc;
  depth: GraphDepth;
  setDepth: (d: GraphDepth) => void;
  openNode: (n?: ResearchNode) => void;
  opened: Set<string>;
  toggleOpen: (id: string) => void;
  sel: string[];
  select: (id: string, add: boolean) => void;
  statusOf: (n: ResearchNode) => ResearchStatus;
  taskOf: (id?: string) => Task | undefined;
  snapshot: WorkspaceSnapshot;
}) {
  const box = useRef<HTMLDivElement>(null);
  const L = useMemo(() => layoutGraph(doc, depth, opened), [doc, depth, opened]);
  const [view, setView] = useState({ x: 24, y: 60, k: 1 });
  const [legend, setLegend] = useState(false);
  const fitted = useRef('');
  const fit = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const w = L.width + 160, h = L.height + 110;
    // Room left above the box floating at the bottom.
    const below = box.current?.parentElement?.querySelector('.research-composer')?.getBoundingClientRect().height ?? 0;
    const k = Math.min(1.1, Math.max(0.3, Math.min(r.width / w, (r.height - 40 - below) / h)));
    setView({ x: 24, y: 60, k });
  };
  // Fit when the graph's shape changes level, not on every edit (the view stays where the user put it).
  useLayoutEffect(() => {
    if (fitted.current !== depth) {
      fitted.current = depth;
      fit();
    }
  });
  const zoom = (f: number, cx?: number, cy?: number) =>
    setView((v) => {
      const r = box.current!.getBoundingClientRect();
      const x0 = cx ?? r.width / 2, y0 = cy ?? r.height / 2;
      const k = Math.min(2, Math.max(0.25, v.k * f));
      const g = k / v.k;
      return { k, x: x0 - (x0 - v.x) * g, y: y0 - (y0 - v.y) * g };
    });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Pinch (ctrl+wheel) and the wheel zoom; a trackpad's two-finger scroll pans.
      if (e.ctrlKey || Math.abs(e.deltaY) > 40 && !e.deltaX) zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });
  const pan = (e: ReactPointerEvent) => {
    if ((e.target as Element).closest('.rg-node,.research-tools')) return;
    const sx = e.clientX, sy = e.clientY, o = view;
    box.current!.classList.add('panning');
    const move = (ev: PointerEvent) => setView({ ...o, x: o.x + ev.clientX - sx, y: o.y + ev.clientY - sy });
    const up = () => {
      box.current?.classList.remove('panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const { nodeW: W, nodeH: H } = GRAPH;
  const edges: ReactNode[] = [];
  for (const it of L.items)
    for (const k of it.children) {
      const a = { x: it.x + W, y: it.y + H / 2 }, b = { x: k.x, y: k.y + H / 2 }, mx = (a.x + b.x) / 2;
      const idea = k.node && statusOf(k.node) === 'idea';
      edges.push(<path key={`${it.id}>${k.id}`} className={`rg-edge${idea ? ' idea' : ''}`} d={`M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`} />);
    }
  const cross: ReactNode[] = [];
  for (const it of L.items)
    if (it.node?.type === 'method')
      for (const l of it.node.links ?? []) {
        const src = L.at.get(l.from);
        if (!src) continue;
        const lit = sel.includes(it.node.id) || sel.includes(l.from);
        const down = it.y > src.y;
        const p1 = { x: src.x + W / 2, y: down ? src.y + H : src.y }, p2 = { x: it.x + W / 2, y: down ? it.y : it.y + H };
        const cx = Math.max(p1.x, p2.x) + 96;
        cross.push(
          <g key={`${l.from}~${it.id}`} className={`rg-link ${l.kind}${lit ? ' lit' : ''}`}>
            <path d={`M${p1.x},${p1.y} C${cx},${p1.y} ${cx},${p2.y} ${p2.x},${p2.y}`}>
              <title>{l.note ? `${t(LINK_LABEL[l.kind])}: ${l.note}` : t(LINK_LABEL[l.kind])}</title>
            </path>
            {lit ? (
              <g transform={`translate(${cx - 10},${(p1.y + p2.y) / 2})`}>
                <rect x={-4} y={-11} width={t(LINK_LABEL[l.kind]).length * 7 + 14} height={16} rx={8} className="rg-link-tag" />
                <text x={3} y={1}>
                  {t(LINK_LABEL[l.kind])}
                </text>
              </g>
            ) : null}
          </g>,
        );
      }

  return (
    <div className="research-canvas" ref={box} onPointerDown={pan} data-testid="research-canvas">
      <div className="research-tools">
        <div className="seg" role="group" aria-label={t('Show down to')}>
          <span className="seg-label">{t('Show down to')}</span>
          {(
            [
              ['aspect', 'Aspects'],
              ['method', 'Methods'],
              ['experiment', 'Experiments'],
            ] as const
          ).map(([d, l]) => (
            <button key={d} className={depth === d ? 'on' : ''} aria-pressed={depth === d} onClick={() => setDepth(d)} data-testid={`research-depth-${d}`}>
              {t(l)}
            </button>
          ))}
        </div>
        <div className="research-zoom">
          <button className="icon-btn" onClick={() => zoom(1.2)} aria-label={t('Zoom in')} title={t('Zoom in')}>
            +
          </button>
          <button className="icon-btn" onClick={() => zoom(1 / 1.2)} aria-label={t('Zoom out')} title={t('Zoom out')}>
            −
          </button>
          <button className="icon-btn" onClick={fit} aria-label={t('Fit')} title={t('Fit')} data-testid="research-fit">
            <Icon name="expand" size={12} />
          </button>
          <button className={`btn btn-sm btn-ghost${legend ? ' on' : ''}`} onClick={() => setLegend(!legend)} aria-expanded={legend} data-testid="research-legend-toggle">
            {t('Legend')}
          </button>
        </div>
      </div>
      <svg className="research-svg">
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges}
          {/* Under the nodes, so they never cover a title or a number; a selected method's own links come forward. */}
          <g className={`rg-links${sel.length ? ' has-sel' : ''}`}>{cross}</g>
          {L.items.map((it) => (
            <GraphNode key={it.id} it={it} doc={doc} sel={sel} select={select} toggleOpen={toggleOpen} openNode={openNode} statusOf={statusOf} taskOf={taskOf} snapshot={snapshot} />
          ))}
        </g>
      </svg>
      {legend ? (
      <div className="research-legend" data-testid="research-legend">
        {(['running', 'pass', 'fail', 'unclear', 'idea'] as const).map((s) => (
          <span key={s}>
            <i className={`rg-dot st-${s}`} /> {t(STATUS_LABEL[s])}
          </span>
        ))}
        <span className="lk combine">┅ {t('Combined')}</span>
        <span className="lk mutate">┅ {t('Mutated')}</span>
        <span className="lk borrow">┈ {t('Borrows')}</span>
        <span className="lk finding">◆ {t('Finding')}</span>
        <span className="lk-how">{t('Click: talk to its agent · ⇧-click: several · double-click: open its conversation')}</span>
      </div>
      ) : null}
      {!childrenOf(doc, null).length ? <div className="research-hint">{t('Ask below to add the aspects that may move the result: data, model, training…')}</div> : null}
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function GraphNode({ it, doc, sel, select, toggleOpen, openNode, statusOf, taskOf, snapshot }: { it: GraphItem; doc: ResearchDoc; sel: string[]; select: (id: string, add: boolean) => void; toggleOpen: (id: string) => void; openNode: (n?: ResearchNode) => void; statusOf: (n: ResearchNode) => ResearchStatus; taskOf: (id?: string) => Task | undefined; snapshot: WorkspaceSnapshot }) {
  const { nodeW: W, nodeH: H } = GRAPH;
  const at = `translate(${it.x},${it.y})`;
  const waiting = (taskId?: string) => (taskId ? snapshot.attention.filter((a) => a.taskId === taskId && a.state === 'open' && a.kind !== 'completion').length : 0);
  const badge = (n: number) =>
    n ? (
      <g transform={`translate(${W - 6},-6)`} className="rg-badge">
        <circle r={9} />
        <text y={4}>{n}</text>
      </g>
    ) : null;
  if (it.kind === 'goal')
    return (
      <g className={`rg-node goal${sel.length ? '' : ' sel'}`} transform={at} onClick={() => select('', false)} onDoubleClick={() => openNode()} data-testid="research-node" data-kind="goal">
        <rect className="box" width={W} height={H} rx={10} />
        <text x={12} y={22} className="t1 inv">
          {clip(doc.title, 16)}
        </text>
        <text x={12} y={41} className="t2 inv">
          {taskOf(doc.leadTaskId) ? `◇ ${taskOf(doc.leadTaskId)!.alias} · ${t('research lead')}` : t('Which aspects move the result?')}
        </text>
      </g>
    );
  if (it.kind === 'runs') {
    const runs = it.runs!;
    const method = doc.nodes.find((n) => `runs:${n.id}` === it.id)!;
    const best = bestExperiment(doc, method);
    const metric = aspectOf(doc, method)?.metric;
    const found = runs.reduce((s, e) => s + (e.findings?.length ?? 0), 0);
    const running = runs.filter((e) => statusOf(e) === 'running').length;
    return (
      <g className="rg-node runs" transform={at} onClick={() => toggleOpen(method.id)} data-testid="research-node" data-kind="runs">
        <rect className="box" width={W} height={H} rx={10} />
        <text x={12} y={21} className="t1">
          {runs.length === 1 ? t('1 experiment') : t('{n} experiments', { n: runs.length })}
        </text>
        {best ? (
          <text x={W - 10} y={21} className="t-val pass" textAnchor="end">
            {t('best {v}', { v: formatValue(metric, best.value) })}
          </text>
        ) : null}
        {runs.slice(0, 9).map((e, i) => (
          <circle key={e.id} cx={16 + i * 11} cy={38} r={4} className={`st-${statusOf(e)}`} />
        ))}
        <text x={W - 10} y={41} className={running ? 't2 run' : found ? 't-find' : 't-more'} textAnchor="end">
          {running ? t('{n} running', { n: running }) : found ? `◆ ${found}` : t('Show ›')}
        </text>
        {badge(runs.reduce((s, e) => s + waiting(e.taskId), 0))}
      </g>
    );
  }
  const n = it.node!;
  const st = statusOf(n);
  const isSel = sel.includes(n.id);
  const click = (e: ReactMouseEvent) => select(n.id, e.shiftKey || e.metaKey);
  const dbl = () => openNode(n);
  // Counts of what is under a node (as Arbor's tree shows them): ✓ works · ✗ does not · ≈ unclear · ▸ running.
  const tally = (exps: ResearchNode[]) => {
    const c = (x: ResearchStatus) => exps.filter((e) => statusOf(e) === x).length;
    return [c('pass') ? `✓${c('pass')}` : '', c('fail') + c('error') ? `✗${c('fail') + c('error')}` : '', c('unclear') ? `≈${c('unclear')}` : '', c('running') ? `▸${c('running')}` : ''].filter(Boolean).join(' ');
  };
  const pct = (g: number | null) => (g == null ? '' : `${g >= 0 ? '+' : ''}${(g * 100).toFixed(Math.abs(g) < 0.1 ? 1 : 0)}%`);
  const tip = (lines: Array<string | false | undefined | null>) => <title>{lines.filter(Boolean).join('\n')}</title>;
  if (n.type === 'aspect') {
    const methods = childrenOf(doc, n.id);
    const agent = taskOf(n.taskId);
    const exps = experimentsUnder(doc, n);
    const bestG = Math.max(-Infinity, ...exps.filter((e) => statusOf(e) === 'pass').map((e) => gain(n.metric, e.value) ?? -Infinity));
    return (
      <g className={`rg-node aspect${n.combos ? ' combos' : ''}${isSel ? ' sel' : ''}`} transform={at} onClick={click} onDoubleClick={dbl} data-testid="research-node" data-kind="aspect" data-title={n.title}>
        {tip([n.title, n.metric ? `${n.metric.name} (${n.metric.higherIsBetter ? '↑' : '↓'})` : t('judged by hand'), agent ? `${agent.alias} · ${t(AGENT_STATUS[agent.status])}` : t('no agent yet'), tally(exps)])}
        <rect className="box" width={W} height={H} rx={10} />
        <text x={12} y={22} className="t1 strong">
          {clip(n.title, 13)}
        </text>
        <text x={W - 10} y={22} className={`t2${bestG > -Infinity ? ' gain' : ''}`} textAnchor="end">
          {bestG > -Infinity ? pct(bestG) : methods.length === 1 ? t('1 method') : t('{n} methods', { n: methods.length })}
        </text>
        <text x={12} y={41} className="t2">
          {clip(`${agent ? agent.alias : t('no agent yet')} · ${n.metric ? n.metric.name : t('judged by hand')}`, 22)}
        </text>
        <text x={W - 10} y={41} className="t2 tally" textAnchor="end">
          {tally(exps)}
        </text>
        {badge(waiting(n.taskId))}
      </g>
    );
  }
  const metric = aspectOf(doc, n)?.metric;
  if (n.type === 'method') {
    const best = bestExperiment(doc, n);
    const link = n.links?.[0];
    const exps = childrenOf(doc, n.id);
    const found = exps.reduce((s, e) => s + (e.findings?.length ?? 0), 0);
    const g = best && statusOf(best) !== 'fail' ? gain(metric, best.value) : null;
    const lastFinding = exps.flatMap((e) => e.findings ?? []).at(-1);
    return (
      <g className={`rg-node method st-${st}${isSel ? ' sel' : ''}`} transform={at} onClick={click} onDoubleClick={dbl} data-testid="research-node" data-kind="method" data-title={n.title}>
        {tip([n.title, t(STATUS_LABEL[st]), best ? `${t('best {v} ({name})', { v: formatValue(metric, best.value), name: best.title })}${g != null ? ` · ${pct(g)}` : ''}` : '', link ? `${t(LINK_LABEL[link.kind])}: ${doc.nodes.find((x) => x.id === link.from)?.title ?? ''}` : '', lastFinding ? `◆ ${lastFinding.text}` : '', n.design])}
        <rect className="box" width={W} height={H} rx={10} />
        <circle cx={14} cy={17} r={4.8} className={`st-${st}`} />
        <text x={25} y={21} className="t1">
          {clip(n.title, 13)}
        </text>
        <text x={W - 10} y={21} className={`t-val ${st}`} textAnchor="end">
          {best ? formatValue(metric, best.value) : st === 'running' ? '…' : ''}
        </text>
        <text x={12} y={41} className="t2">
          {clip(st === 'idea' ? (n.source ?? t('Not tried')) : [link ? t(LINK_LABEL[link.kind]) : '', tally(exps), found ? `◆${found}` : ''].filter(Boolean).join(' · '), 26)}
        </text>
        {g != null ? (
          <text x={W - 10} y={41} className={`t2 ${g >= 0 ? 'gain' : 'loss'}`} textAnchor="end">
            {pct(g)}
          </text>
        ) : null}
      </g>
    );
  }
  const agent = taskOf(n.taskId);
  const method = doc.nodes.find((x) => x.id === n.parent);
  const isBest = !!method && bestExperiment(doc, method)?.id === n.id && st === 'pass';
  const g = gain(metric, n.value);
  const spread = n.runs && n.runs.length > 1 ? runStats(n.runs) : undefined;
  return (
    <g className={`rg-node experiment st-${st}${isSel ? ' sel' : ''}${isBest ? ' best' : ''}`} transform={at} onClick={click} onDoubleClick={dbl} data-testid="research-node" data-kind="experiment" data-title={n.title}>
      {tip([`${isBest ? '★ ' : ''}${n.title}`, t(STATUS_LABEL[st]), n.value != null ? `${formatValue(metric, n.value)}${spread ? ` ± ${formatValue(metric, spread.sd)} (${spread.n})` : ''}${g != null ? ` · ${pct(g)}` : ''}` : '', agent ? `${agent.alias} · ${agent.summary || t(AGENT_STATUS[agent.status])}` : '', n.findings?.at(-1) ? `◆ ${n.findings.at(-1)!.text}` : ''])}
      <rect className="box" width={W} height={H} rx={10} />
      <circle cx={14} cy={17} r={4.8} className={`st-${st}`} />
      <text x={25} y={21} className="t1">
        {isBest ? '★ ' : ''}
        {clip(n.title, isBest ? 12 : 14)}
      </text>
      <text x={W - 10} y={21} className={`t-val ${st}`} textAnchor="end">
        {n.value != null ? `${formatValue(metric, n.value)}${spread ? ` ±${formatValue(metric, spread.sd)}` : ''}` : st === 'running' ? '…' : ''}
      </text>
      <text x={12} y={41} className="t2">
        {clip(agent ? `${agent.alias} · ${st === 'running' && agent.summary ? agent.summary : agent.worktree ? t('own worktree') : t('shared folder')}` : t('no agent'), 24)}
      </text>
      <text x={W - 10} y={41} className={n.findings?.length ? 't-find' : `t2 ${g != null && g >= 0 ? 'gain' : 'loss'}`} textAnchor="end">
        {n.findings?.length ? `◆ ${n.findings.length}` : pct(g)}
      </text>
      {badge(waiting(n.taskId))}
    </g>
  );
}

// ------------------------------------------------------------------ side column: each level its question, to read
// Changes are made by talking (the box below, to the right agent, which has the research tools);
// the column shows where things stand and opens an agent's conversation when its context is wanted.

function Question({ children }: { children: ReactNode }) {
  return <div className="rs-question">{children}</div>;
}

function AgentLine({ ctx, task, role, none }: { ctx: Ctx; task?: Task; role: string; none: string }) {
  if (!task) return <div className="rs-agent none muted">{none}</div>;
  return (
    <div className="rs-agent">
      <Alias alias={task.alias} size="sm" />
      <span className="rs-agent-text">
        <b>{task.alias}</b>
        <small>
          {role} · {t(AGENT_STATUS[task.status])}
        </small>
      </span>
      <button className="link small" onClick={() => ctx.onOpenAgent(task.taskId)} data-testid="research-open-agent">
        {t('Open conversation')}
      </button>
    </div>
  );
}

function Findings({ ctx, items }: { ctx: Ctx; items: Array<{ text: string; by?: string; id: string; on?: ResearchNode }> }) {
  if (!items.length) return null;
  return (
    <>
      <div className="rs-sec">{t('Findings')}</div>
      {items.map((f) => (
        <div key={f.id} className="rs-finding">
          {f.text}
          {f.on ? (
            <button className="link small" onClick={() => ctx.select(f.on!.id)}>
              {' '}
              — {f.by ? `${f.by}, ` : ''}
              {f.on.title}
            </button>
          ) : f.by ? (
            <span className="muted"> — {f.by}</span>
          ) : null}
        </div>
      ))}
    </>
  );
}

/** A markdown note kept by the agents, with how fresh it is against the results recorded since. */
function NoteCard({ title, note, behind, empty, testId }: { title: string; note?: ResearchNote; behind: number; empty: string; testId: string }) {
  return (
    <div className="rs-note" data-testid={testId}>
      <div className="rs-note-head">
        <span className="rs-note-title">{title}</span>
        {note ? (
          <span className={`rs-note-age${behind ? ' behind' : ''}`}>
            {t('updated {ago}', { ago: timeAgo(note.updatedAt) })}
            {behind ? ` · ${behind === 1 ? t('1 new result since') : t('{n} new results since', { n: behind })}` : ''}
          </span>
        ) : null}
      </div>
      {note ? (
        <div className="rs-note-body">
          <Markdown text={note.text} />
        </div>
      ) : (
        <div className="muted small">{empty}</div>
      )}
    </div>
  );
}

function GoalPanel({ ctx }: { ctx: Ctx }) {
  const { doc } = ctx;
  const rows = contributions(doc);
  const max = Math.max(0.0001, ...rows.map((r) => Math.abs(r.estimate ?? 0)));
  const m = doc.endMetric;
  return (
    <>
      <Question>{t('Which aspects move the end result?')}</Question>
      <div className="rs-text">{doc.goal}</div>
      <AgentLine ctx={ctx} task={ctx.taskOf(doc.leadTaskId)} role={t('research lead')} none={t('No research lead yet: what you say below starts one; lay the research out with it step by step.')} />
      <NoteCard
        title={t('Summary')}
        note={ctx.notes.summary}
        behind={resultsSince(doc, ctx.notes.summary?.updatedAt)}
        empty={t('No summary yet. The main agent writes it from the aspects’ notes as results come in; you can also ask it below.')}
        testId="research-summary"
      />
      {rows.length ? (
        <div className="rs-contrib" data-testid="research-contrib">
          {rows.map((r) => (
            <div key={r.aspect.id} className="rs-contrib-row">
              <button className="link" onClick={() => ctx.select(r.aspect.id)}>
                {r.aspect.title}
              </button>
              <span className="rs-contrib-bar" title={r.evidence < 2 ? t('One ablation: a hint, not yet believable') : t('{n} ablations', { n: r.evidence })}>
                {r.estimate != null ? <i className={r.evidence < 2 ? 'unsure' : ''} style={{ width: `${(Math.abs(r.estimate) / max) * 100}%` }} /> : null}
              </span>
              <span className="rs-contrib-val">
                {r.estimate != null ? `${r.estimate >= 0 ? '+' : ''}${formatValue(m, r.estimate)}` : '—'}
                <small>{r.evidence === 1 ? t('1 ablation') : r.evidence ? t('{n} ablations', { n: r.evidence }) : t('no evidence')}</small>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {doc.evidence.length ? (
        <>
          <div className="rs-sec">{t('Evidence: end-to-end runs and ablations')}</div>
          <table className="rs-table">
            <tbody>
              {doc.evidence.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className={`pill${e.kind === 'ablation' ? '' : ' pill-e2e'}`}>{e.kind === 'ablation' ? t('Ablation') : t('End to end')}</span> {e.title}
                  </td>
                  <td>{formatValue(m, e.value)}</td>
                  <td className={e.delta >= 0 ? 'up' : 'down'}>
                    {e.delta >= 0 ? '+' : ''}
                    {formatValue(m, e.delta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <div className="rs-tip">{t('Manage it by talking: ask below to add an aspect, record an ablation, or turn earlier conversations into this tree.')}</div>
    </>
  );
}

function NodePanel({ ctx, node }: { ctx: Ctx; node: ResearchNode }) {
  if (node.type === 'aspect') return <AspectPanel ctx={ctx} node={node} />;
  if (node.type === 'method') return <MethodPanel ctx={ctx} node={node} />;
  return <ExperimentPanel ctx={ctx} node={node} />;
}

/** Change from the start as a percentage, positive when better. */
const pctOf = (g: number | null) => (g == null ? '' : `${g >= 0 ? '+' : ''}${(g * 100).toFixed(Math.abs(g) < 0.1 ? 1 : 0)}%`);

/**
 * Advisory, as pi-autoresearch shows it: how far the best working result stands out from the spread
 * (≥2 likely real, 1–2 marginal, <1 within the noise). It never decides anything.
 */
function Confidence({ metric, exps }: { metric?: ResearchMetric; exps: ResearchNode[] }) {
  const c = confidence(metric, exps);
  if (c == null) return null;
  const level = c >= 2 ? 'good' : c >= 1 ? 'marginal' : 'noise';
  const say = { good: t('likely real'), marginal: t('above the noise, marginal'), noise: t('within the noise: a rerun would tell') }[level];
  return (
    <span className={`rs-conf ${level}`} title={t('Best working result against the spread of all results (|best − start| / median deviation). A hint, not a verdict.')} data-testid="research-confidence">
      {t('confidence {x}×', { x: c.toFixed(1) })} · {say}
    </span>
  );
}

/** Start → best, the change, how many ran, how many work: one row of numbers (as autoresearch dashboards lead with). */
function Kpis({ metric, exps, statusOf }: { metric?: ResearchMetric; exps: ResearchNode[]; statusOf: (n: ResearchNode) => ResearchStatus }) {
  const done = exps.filter((e) => e.value != null && statusOf(e) !== 'error');
  const passed = exps.filter((e) => statusOf(e) === 'pass');
  const best = metric && passed.length ? passed.reduce((b, e) => ((metric.higherIsBetter ? e.value! > b.value! : e.value! < b.value!) ? e : b)) : undefined;
  return (
    <div className="rs-kpis" data-testid="research-kpis">
      {metric ? (
        <div>
          <small>{t('start → best')}</small>
          <b>
            {formatValue(metric, metric.baseline)} → {best ? formatValue(metric, best.value) : '—'}
          </b>
        </div>
      ) : null}
      {metric && best ? (
        <div>
          <small>{t('change')}</small>
          <b className="gain">{pctOf(gain(metric, best.value))}</b>
        </div>
      ) : null}
      <div>
        <small>{t('experiments')}</small>
        <b>{exps.length}</b>
      </div>
      <div>
        <small>{t('work')}</small>
        <b>
          {passed.length}/{done.length || exps.length}
        </b>
      </div>
    </div>
  );
}

/**
 * The search at a glance (after autoresearcherUI's hero chart): each experiment by when it started, the
 * dashed start, a step line through the running best; failures and running ones in a lane at the top.
 * A click selects the experiment.
 */
function ProgressChart({ metric, exps, statusOf, select }: { metric: ResearchMetric; exps: ResearchNode[]; statusOf: (n: ResearchNode) => ResearchStatus; select: (id: string) => void }) {
  const Ww = 330, Hh = 118, lane = 14, pad = 8;
  const vals = exps.filter((e) => e.value != null && statusOf(e) !== 'error').map((e) => e.value!);
  if (!exps.length) return null;
  const base = metric.baseline ?? vals[0] ?? 0;
  const lo = Math.min(base, ...vals), hi = Math.max(base, ...vals);
  const x = (i: number) => pad + (exps.length === 1 ? (Ww - 2 * pad) / 2 : (i / (exps.length - 1)) * (Ww - 2 * pad));
  const y = (v: number) => Hh - pad - ((v - lo) / (hi - lo || 1)) * (Hh - 2 * pad - lane - 6);
  const better = (a: number, b: number) => (metric.higherIsBetter ? a > b : a < b);
  let best = base;
  let path = `M${x(0)},${y(base)}`;
  exps.forEach((e, i) => {
    if (statusOf(e) === 'pass' && e.value != null && better(e.value, best)) {
      path += ` H${x(i)} V${y(e.value)}`;
      best = e.value;
    }
  });
  path += ` H${x(exps.length - 1)}`;
  let record = base;
  return (
    <svg className="rs-progress" width={Ww} height={Hh} data-testid="research-progress-chart">
      <line x1={0} x2={Ww} y1={y(base)} y2={y(base)} className="base" />
      <text x={Ww - 2} y={y(base) - 3} textAnchor="end" className="base-label">
        {t('start {v}', { v: formatValue(metric, base) })}
      </text>
      <path d={path} className="best-line" />
      {exps.map((e, i) => {
        const st = statusOf(e);
        const label = `${e.title}: ${e.value != null ? formatValue(metric, e.value) : t(STATUS_LABEL[st])}`;
        if (st === 'running' || st === 'error' || e.value == null)
          return (
            <rect key={e.id} x={x(i) - 1.5} y={3} width={3} height={lane - 4} rx={1.5} className={`st-${st} lane`} onClick={() => select(e.id)}>
              <title>{label}</title>
            </rect>
          );
        const isRecord = st === 'pass' && better(e.value, record);
        if (isRecord) record = e.value;
        return (
          <circle key={e.id} cx={x(i)} cy={y(e.value)} r={isRecord ? 4.2 : 3} className={`st-${st}${isRecord ? ' record' : ' faint'}`} onClick={() => select(e.id)}>
            <title>{label}</title>
          </circle>
        );
      })}
    </svg>
  );
}

function AspectPanel({ ctx, node }: { ctx: Ctx; node: ResearchNode }) {
  const { doc } = ctx;
  const methods = childrenOf(doc, node.id);
  const m = node.metric;
  return (
    <>
      <Question>{node.combos ? t('How do methods from different aspects work together?') : t('Which methods are there for "{aspect}"?', { aspect: node.title })}</Question>
      <AgentLine ctx={ctx} task={ctx.taskOf(node.taskId)} role={t('owns this aspect')} none={node.combos ? t('The research lead looks after combinations across aspects.') : t('No agent yet: the first thing you say to it below starts one.')} />
      <div className="rs-kv">
        <span>{t('Validated by')}</span>
        <span>
          {m ? `${m.name} · ${m.higherIsBetter ? t('higher is better') : t('lower is better')}${m.baseline != null ? ` · ${t('starts at {v}', { v: formatValue(m, m.baseline) })}` : ''}${m.noise ? ` · ${t('noise ±{v}', { v: formatValue(m, m.noise) })}` : ''}` : t('judged by hand')}
          {node.metrics?.length ? <span className="muted"> · {t('also watched: {list}', { list: node.metrics.map((x) => x.name).join(', ') })}</span> : null}
        </span>
      </div>
      {experimentsUnder(doc, node).length ? (
        <>
          <Kpis metric={m} exps={experimentsUnder(doc, node)} statusOf={ctx.statusOf} />
          {m ? <ProgressChart metric={m} exps={experimentsUnder(doc, node)} statusOf={ctx.statusOf} select={ctx.select} /> : null}
          <Confidence metric={m} exps={experimentsUnder(doc, node)} />
        </>
      ) : null}
      {node.combos ? null : (
        <NoteCard
          title={t('Notes')}
          note={ctx.notes.aspects[node.id]}
          behind={resultsSince(doc, ctx.notes.aspects[node.id]?.updatedAt, node.id)}
          empty={t('No notes yet. Its agent writes them when a batch of experiments has its results.')}
          testId="research-notes"
        />
      )}
      {methods.length ? (
        <table className="rs-table">
          <thead>
            <tr>
              <th>{t('Method')}</th>
              <th>{m?.name ?? t('Result')}</th>
              <th>{t('Runs')}</th>
            </tr>
          </thead>
          <tbody>
            {methods.map((x) => {
              const st = ctx.statusOf(x);
              const best = bestExperiment(doc, x);
              return (
                <tr key={x.id} className="clickable" onClick={() => ctx.select(x.id)}>
                  <td>
                    <i className={`rg-dot st-${st}`} title={t(STATUS_LABEL[st])} /> {x.title}
                    {x.links?.[0] ? <span className={`pill link-${x.links[0].kind}`}>{t(LINK_LABEL[x.links[0].kind])}</span> : null}
                  </td>
                  <td>{best ? formatValue(m, best.value) : '—'}</td>
                  <td>{childrenOf(doc, x.id).length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="muted small">{t('No methods yet.')}</div>
      )}
    </>
  );
}

function MethodPanel({ ctx, node }: { ctx: Ctx; node: ResearchNode }) {
  const { doc } = ctx;
  const aspect = aspectOf(doc, node)!;
  const m = aspect.metric;
  const exps = childrenOf(doc, node.id);
  const best = bestExperiment(doc, node);
  return (
    <>
      <Question>{t('How is "{method}" designed, and how well does it work?', { method: node.title })}</Question>
      <AgentLine ctx={ctx} task={ctx.taskOf(aspect.taskId)} role={t('owns "{aspect}"', { aspect: aspect.title })} none={aspect.combos ? t('The research lead looks after combinations across aspects.') : t('No agent yet: the first thing you say to it below starts one.')} />
      {node.links?.length ? (
        <div className="rs-links">
          {node.links.map((l) => (
            <div key={l.from}>
              <span className={`pill link-${l.kind}`}>{t(LINK_LABEL[l.kind])}</span>{' '}
              <button className="link" onClick={() => ctx.select(l.from)}>
                {doc.nodes.find((x) => x.id === l.from)?.title}
              </button>
              {l.note ? <span className="muted"> · {l.note}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {node.design ? <div className="rs-design">{node.design}</div> : null}
      {node.source && ctx.statusOf(node) === 'idea' ? <div className="muted small">{t('Idea from: {source}', { source: node.source })}</div> : null}
      {exps.length ? (
        <>
          <div className="rs-sec">
            {t('Results')} · {m?.name ?? t('judged by hand')}
          </div>
          <Kpis metric={m} exps={exps} statusOf={ctx.statusOf} />
          {m ? <ResultBars metric={m} exps={exps} statusOf={ctx.statusOf} select={ctx.select} /> : null}
          <Confidence metric={m} exps={exps} />
          <ResultTable ctx={ctx} aspect={aspect} exps={exps} best={best} />
        </>
      ) : (
        <div className="muted small">{t('Not tried yet.')}</div>
      )}
      <Findings ctx={ctx} items={exps.flatMap((e) => (e.findings ?? []).map((f) => ({ ...f, on: e })))} />
    </>
  );
}

/**
 * Variants with their results: the change from the start in a cell tinted by its size (green better,
 * red worse, as autoresearcherUI's table does), repeated runs as mean ± spread, other metrics as columns.
 */
function ResultTable({ ctx, aspect, exps, best }: { ctx: Ctx; aspect: ResearchNode; exps: ResearchNode[]; best?: ResearchNode }) {
  const m = aspect.metric;
  const others = aspect.metrics ?? [];
  const gains = exps.map((e) => gain(m, e.value)).filter((g): g is number => g != null);
  const top = Math.max(0.0001, ...gains.map(Math.abs));
  return (
    <table className="rs-table" data-testid="research-results">
      <thead>
        <tr>
          <th>{t('Variant')}</th>
          <th>{m?.name ?? t('Result')}</th>
          {m?.baseline != null ? <th>{t('vs start')}</th> : null}
          {others.map((o) => (
            <th key={o.name}>{o.name}</th>
          ))}
          <th>{t('Agent')}</th>
        </tr>
      </thead>
      <tbody>
        {exps.map((e) => {
          const st = ctx.statusOf(e);
          const g = gain(m, e.value);
          const spread = e.runs && e.runs.length > 1 ? runStats(e.runs) : undefined;
          return (
            <tr key={e.id} className="clickable" onClick={() => ctx.select(e.id)}>
              <td>
                <i className={`rg-dot st-${st}`} title={t(STATUS_LABEL[st])} /> {best?.id === e.id && st === 'pass' ? '★ ' : ''}
                {e.title}
                {e.findings?.length ? <span className="rs-find-count">◆ {e.findings.length}</span> : null}
              </td>
              <td>
                {e.value != null ? formatValue(m, e.value) : t(STATUS_LABEL[st])}
                {spread ? <span className="muted"> ±{formatValue(m, spread.sd)} ({spread.n})</span> : null}
              </td>
              {m?.baseline != null ? (
                <td className="rs-heat" style={g != null ? { background: `${g >= 0 ? 'rgba(22,163,74,' : 'rgba(192,38,45,'}${0.08 + 0.3 * (Math.abs(g) / top)})` } : undefined}>
                  {pctOf(g)}
                </td>
              ) : null}
              {others.map((o) => (
                <td key={o.name}>{e.values?.[o.name] != null ? formatValue(o, e.values[o.name]) : '—'}</td>
              ))}
              <td className="muted">{ctx.taskOf(e.taskId)?.alias ?? ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ResultBars({ metric, exps, statusOf, select }: { metric: ResearchMetric; exps: ResearchNode[]; statusOf: (n: ResearchNode) => ResearchStatus; select: (id: string) => void }) {
  const vals = exps.map((e) => e.value).filter((v): v is number => v != null);
  const base = metric.baseline ?? (vals.length ? vals[0] : 0);
  const lo = Math.min(base, ...vals), hi = Math.max(base, ...vals);
  const Hh = 76, Ww = 320;
  const y = (v: number) => Hh - 10 - ((v - lo) / (hi - lo || 1)) * (Hh - 24);
  const bw = Math.max(10, Math.min(30, (Ww - 16) / Math.max(exps.length, 1) - 6));
  return (
    <svg className="rs-bars" width={Ww} height={Hh} data-testid="research-bars">
      <line x1={0} x2={Ww} y1={y(base)} y2={y(base)} className="base" />
      <text x={Ww - 2} y={y(base) - 3} textAnchor="end" className="base-label">
        {t('start {v}', { v: formatValue(metric, base) })}
      </text>
      {exps.map((e, i) => {
        const x = 8 + i * (bw + 6);
        const st = statusOf(e);
        return e.value != null ? (
          <rect key={e.id} x={x} y={Math.min(y(e.value), y(base))} width={bw} height={Math.max(2, Math.abs(y(e.value) - y(base)))} rx={3} className={`st-${st}`} onClick={() => select(e.id)}>
            <title>
              {e.title}: {formatValue(metric, e.value)}
            </title>
          </rect>
        ) : (
          <rect key={e.id} x={x} y={Hh - 14} width={bw} height={5} rx={2.5} className={`st-${st} pending`} onClick={() => select(e.id)}>
            <title>
              {e.title}: {t(STATUS_LABEL[st])}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

function ExperimentPanel({ ctx, node }: { ctx: Ctx; node: ResearchNode }) {
  const { doc } = ctx;
  const aspect = aspectOf(doc, node);
  const method = doc.nodes.find((n) => n.id === node.parent);
  const m = aspect?.metric;
  const st = ctx.statusOf(node);
  const task = ctx.taskOf(node.taskId);
  return (
    <>
      <Question>{node.title}</Question>
      <div className="muted small">
        {t('Variant of')}{' '}
        <button className="link small" onClick={() => method && ctx.select(method.id)}>
          {method?.title}
        </button>{' '}
        · {aspect?.title}
      </div>
      <AgentLine ctx={ctx} task={task} role={task?.worktree ? t('one variant, own worktree') : t('one variant')} none={t('No agent on this one.')} />
      <div className="rs-kv">
        <span>{t('Status')}</span>
        <span>
          <i className={`rg-dot st-${st}`} /> {t(STATUS_LABEL[st])}
        </span>
        <span>{m?.name ?? t('Result')}</span>
        <span>
          {node.value != null ? <b>{formatValue(m, node.value)}</b> : '—'}
          {node.runs && node.runs.length > 1 ? <span className="muted"> ± {formatValue(m, runStats(node.runs).sd)}</span> : null}
          {gain(m, node.value) != null ? <span className={gain(m, node.value)! >= 0 ? 'gain' : 'loss'}> {pctOf(gain(m, node.value))}</span> : null}
          {m?.baseline != null ? <span className="muted"> · {t('start {v}', { v: formatValue(m, m.baseline) })}</span> : null}
        </span>
        {node.runs && node.runs.length > 1 ? (
          <>
            <span>{t('Runs')}</span>
            <span className="rs-runs">{node.runs.map((v) => formatValue(m, v)).join(' · ')}</span>
          </>
        ) : null}
        {Object.entries(node.values ?? {}).map(([k, v]) => (
          <Fragment key={k}>
            <span>{k}</span>
            <span>{formatValue(aspect?.metrics?.find((x) => x.name === k), v)}</span>
          </Fragment>
        ))}
      </div>
      {node.config && node.config !== node.title ? <div className="rs-design">{node.config}</div> : null}
      <Findings ctx={ctx} items={node.findings ?? []} />
    </>
  );
}

function MultiPanel({ ctx, nodes }: { ctx: Ctx; nodes: ResearchNode[] }) {
  const { doc } = ctx;
  return (
    <>
      <Question>{t('{n} selected', { n: nodes.length })}</Question>
      {nodes.map((n) => (
        <div key={n.id}>
          {n.title} <span className="muted">· {aspectOf(doc, n)?.title ?? ''}</span>
        </div>
      ))}
      <div className="rs-tip">{t('Ask below about them together, e.g. to combine them into a new method.')}</div>
    </>
  );
}

// ------------------------------------------------------------------ the box: what is selected is who it talks to

function ResearchComposer({ ctx, selected, onClear }: { ctx: Ctx; selected: ResearchNode[]; onClear: () => void }) {
  const { doc, snapshot } = ctx;
  const [sent, setSent] = useState<{ to: string; taskId: string } | null>(null);
  const one = selected.length === 1 ? selected[0] : undefined;
  const ids = new Set(taskIdsOf(doc));
  // Who gets it (decided again in the main process when sent): the agent of the nearest node over the selection.
  const route = routeFor(doc, selected);
  const routed: Task | undefined = route.kind === 'experiment' ? ctx.taskOf(route.node.taskId) : route.kind === 'aspect' ? ctx.taskOf(route.aspect.taskId) : ctx.taskOf(doc.leadTaskId);
  const to =
    route.kind === 'experiment'
      ? t('{agent} (experiment "{name}")', { agent: routed?.alias ?? '', name: clip(route.node.title, 14) })
      : route.kind === 'aspect'
        ? routed
          ? t('{agent} ({aspect} aspect)', { agent: routed.alias, aspect: route.aspect.title })
          : t('a new agent for "{aspect}"', { aspect: route.aspect.title })
        : routed
          ? t('{agent} (research lead)', { agent: routed.alias })
          : t('a new research lead');
  const target: ComposerTarget = {
    label: (
      <span data-testid="research-to">
        {t('To: {alias}', { alias: to })}
        {routed ? ` · ${PROVIDER_LABEL[routed.provider]}` : ''}
      </span>
    ),
    // A few questions that fit where one is (as Arbor's and autoresearcherUI's boxes offer): a click puts one in the box.
    chips:
      route.kind === 'experiment' || one?.type === 'experiment'
        ? [t('What did it find?'), t('Rerun it to confirm')]
        : one?.type === 'method'
          ? [t('How is this method doing?'), t('Which variants next?')]
          : one?.type === 'aspect'
            ? [t('Which methods would you try first?'), t('What has worked so far?')]
            : selected.length > 1
              ? [t('Compare these'), t('Combine these into one method')]
              : doc.nodes.length
                ? [t('Where do things stand?'), t('Which aspect deserves the next experiments?')]
                : [t('Help me lay out this research'), t('Turn earlier conversations into this tree')],
    placeholder: selected.length > 1
        ? t('e.g. Combine these into one method')
        : one?.type === 'aspect'
          ? t('e.g. Which methods would you try first?')
          : one?.type === 'method'
            ? t('e.g. Try thresholds 0.82 and 0.87 in parallel')
            : one?.type === 'experiment'
              ? t('e.g. Rerun with half the learning rate')
              : doc.nodes.length
                ? t('e.g. Add an aspect for inference speed')
                : t('Tell the lead what the research is about; lay out its aspects together'),
    // The selection is what the message is about: shown above the box, as on an agent's page.
    about: selected.length
      ? {
          label: t('About'),
          text: selected.length === 1 ? selected[0].title : t('{first} and {n} more', { first: selected[0].title, n: selected.length - 1 }),
          clearLabel: t('Clear the selection'),
          onClear,
        }
      : undefined,
    send: async (text, images) => {
      try {
        const r = await call('research:message', { researchId: ctx.research, nodeIds: selected.map((n) => n.id), text, ...(images.length ? { images } : {}) });
        setSent({ to: r.alias, taskId: r.taskId });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errorText(e) };
      }
    },
  };
  return (
    <div className="research-composer">
      {sent ? (
        <div className="research-sent" data-testid="research-sent">
          {t('Sent to {agent}.', { agent: sent.to })}{' '}
          <button className="link small" onClick={() => ctx.onOpenAgent(sent.taskId)}>
            {t('Open conversation')}
          </button>
          <button className="icon-btn" aria-label={t('Close')} onClick={() => setSent(null)}>
            <Icon name="x" size={11} />
          </button>
        </div>
      ) : null}
      {/* What the research's agents wait on, answerable here: the agent page's own bar, for this research's agents. */}
      <WaitingOnYou snapshot={snapshot} now={Date.now()} onOpen={ctx.onOpenAgent} bar only={(id) => ids.has(id)} />
      {/* The same box as on an agent's page (attachments, @ files of the agent it reaches), sending through the research. */}
      <Composer task={routed} target={target} />
    </div>
  );
}

// ------------------------------------------------------------------ starting one

export function NewResearchDialog({ snapshot, projectId, onClose, onCreated }: { snapshot: WorkspaceSnapshot; projectId: string; onClose: () => void; onCreated: () => void }) {
  const project = snapshot.projects.find((p) => p.projectId === projectId);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [sample, setSample] = useState(false);
  const [error, setError] = useState('');
  const create = () =>
    call('research:create', { projectId, title: title.trim() || (sample ? ' ' : ''), goal: goal.trim(), sample })
      .then(onCreated)
      .catch((e) => setError(errorText(e)));
  return (
    <Modal title={t('New research in {project}', { project: project?.name ?? '' })} onClose={onClose}>
      <div className="field" data-testid="research-new">
        <label>{t('Title')}</label>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('e.g. Pretraining quality')} />
      </div>
      <div className="field">
        <label>{t('Goal')}</label>
        <textarea className="input" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('What should improve, and how it is measured end to end')} />
      </div>
      <label className="check">
        <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} /> {t('Fill it with an example to look around (no agents)')}
      </label>
      <div className="muted small">{t('Kept in the project’s repository, in .research/research.json.')}</div>
      {error ? <div className="error-text">{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button className="btn btn-primary" onClick={create} disabled={!sample && !title.trim()} data-testid="research-create">
          {t('Create')}
        </button>
      </div>
    </Modal>
  );
}
