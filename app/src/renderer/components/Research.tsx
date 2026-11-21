import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
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
import { Composer, PanelResizer, type ComposerTarget } from './FocusView';
import { SidePanel } from './SidePanel';

const STATUS_LABEL: Record<ResearchStatus, string> = { idea: 'Not tried', running: 'Running', pass: 'Works', fail: 'Does not work', error: 'No result' };
const LINK_LABEL: Record<ResearchLinkKind, string> = { combine: 'Combined', mutate: 'Mutated', borrow: 'Borrows' };
const PANEL_W = 380;

/**
 * A project's research as a graph: the goal, its aspects, their methods and experiments, with
 * combinations, mutations and borrowed ideas drawn across. What is selected decides both the side
 * column (each level its own question) and who the box at the bottom talks to (its agent).
 */
export function ResearchView({ snapshot, projectId, onOpenAgent }: { snapshot: WorkspaceSnapshot; projectId: string; onOpenAgent: (taskId: string) => void }) {
  const project = snapshot.projects.find((p) => p.projectId === projectId);
  const [doc, setDoc] = useState<ResearchDoc | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [depth, setDepth] = useState<GraphDepth>('method');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string[]>([]);
  const [panel, setPanel] = useState(true);
  const [panelW, setPanelW] = useState(PANEL_W);
  const side = useContext(SideSlot);

  // Read again whenever the tree changes (an agent's tool call writes it; the summary's stamp moves).
  const stamp = snapshot.research.find((r) => r.projectId === projectId)?.updatedAt;
  const notesStamp = snapshot.research.find((r) => r.projectId === projectId)?.notesAt;
  const [notes, setNotes] = useState<ResearchNotes>({ aspects: {} });
  useEffect(() => {
    let live = true;
    call('research:notes', { projectId })
      .then((n) => live && setNotes(n))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, notesStamp]);
  useEffect(() => {
    setSel([]);
    setDoc(undefined);
  }, [projectId]);
  useEffect(() => {
    let live = true;
    call('research:get', { projectId })
      .then((d) => live && setDoc(d))
      .catch((e) => live && (setError(errorText(e)), setDoc(null)));
    return () => {
      live = false;
    };
  }, [projectId, stamp]);

  const taskOf = (id?: string) => (id ? snapshot.tasks.find((x) => x.taskId === id) : undefined);
  const statusOf = (n: ResearchNode): ResearchStatus => (n.type === 'experiment' ? experimentStatus(n, taskOf(n.taskId)?.status) : n.type === 'method' && doc ? methodStatus(doc, n, statusOf) : n.status);

  if (!project) return null;
  if (doc === undefined) return <div className="research-empty muted">{t('Loading…')}</div>;
  if (!doc) return <div className="research-empty muted">{error || t('This project has no research yet.')}</div>;

  const selected = sel.map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is ResearchNode => !!n);
  const exps = doc.nodes.filter((n) => n.type === 'experiment');
  const count = (s: ResearchStatus) => exps.filter((e) => statusOf(e) === s).length;
  const select = (id: string, add: boolean) => setSel((cur) => (add ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur.length === 1 && cur[0] === id ? [] : [id]));

  const ctx: Ctx = { snapshot, project: project.projectId, doc, notes, statusOf, taskOf, select: (id) => setSel(id ? [id] : []), onOpenAgent, setError };
  /** A double-click opens the node's agent (a method's is its aspect's); with none yet, it just selects the node. */
  const openNode = (n: ResearchNode) => {
    const id = n.type === 'method' ? aspectOf(doc, n)?.taskId : n.taskId;
    if (id && taskOf(id)) onOpenAgent(id);
    else setSel([n.id]);
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
  project: string;
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
  openNode: (n: ResearchNode) => void;
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
        {(['running', 'pass', 'fail', 'idea'] as const).map((s) => (
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

function GraphNode({ it, doc, sel, select, toggleOpen, openNode, statusOf, taskOf, snapshot }: { it: GraphItem; doc: ResearchDoc; sel: string[]; select: (id: string, add: boolean) => void; toggleOpen: (id: string) => void; openNode: (n: ResearchNode) => void; statusOf: (n: ResearchNode) => ResearchStatus; taskOf: (id?: string) => Task | undefined; snapshot: WorkspaceSnapshot }) {
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
      <g className={`rg-node goal${sel.length ? '' : ' sel'}`} transform={at} onClick={() => select('', false)} data-testid="research-node" data-kind="goal">
        <rect className="box" width={W} height={H} rx={10} />
        <text x={12} y={22} className="t1 inv">
          {clip(doc.title, 16)}
        </text>
        <text x={12} y={41} className="t2 inv">
          {t('Which aspects move the result?')}
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
  if (n.type === 'aspect') {
    const methods = childrenOf(doc, n.id);
    const agent = taskOf(n.taskId);
    return (
      <g className={`rg-node aspect${n.combos ? ' combos' : ''}${isSel ? ' sel' : ''}`} transform={at} onClick={click} onDoubleClick={dbl} data-testid="research-node" data-kind="aspect" data-title={n.title}>
        <rect className="box" width={W} height={H} rx={10} />
        <text x={12} y={22} className="t1 strong">
          {clip(n.title, 15)}
        </text>
        <text x={W - 10} y={22} className="t2" textAnchor="end">
          {methods.length === 1 ? t('1 method') : t('{n} methods', { n: methods.length })}
        </text>
        <text x={12} y={41} className="t2">
          {clip(`${agent ? agent.alias : t('no agent yet')} · ${n.metric ? n.metric.name : t('judged by hand')}`, 30)}
        </text>
        {badge(waiting(n.taskId))}
      </g>
    );
  }
  const metric = aspectOf(doc, n)?.metric;
  if (n.type === 'method') {
    const best = bestExperiment(doc, n);
    const link = n.links?.[0];
    const found = childrenOf(doc, n.id).reduce((s, e) => s + (e.findings?.length ?? 0), 0);
    return (
      <g className={`rg-node method st-${st}${isSel ? ' sel' : ''}`} transform={at} onClick={click} onDoubleClick={dbl} data-testid="research-node" data-kind="method" data-title={n.title}>
        <rect className="box" width={W} height={H} rx={10} />
        <circle cx={14} cy={17} r={4.8} className={`st-${st}`} />
        <text x={25} y={21} className="t1">
          {clip(n.title, 13)}
        </text>
        <text x={W - 10} y={21} className={`t-val ${st}`} textAnchor="end">
          {best ? formatValue(metric, best.value) : st === 'running' ? '…' : ''}
        </text>
        <text x={12} y={41} className="t2">
          {clip(st === 'idea' ? (n.source ?? t('Not tried')) : `${link ? t(LINK_LABEL[link.kind]) + ' · ' : ''}${childrenOf(doc, n.id).length === 1 ? t('1 experiment') : t('{n} experiments', { n: childrenOf(doc, n.id).length })}`, 24)}
        </text>
        {found ? (
          <text x={W - 10} y={41} className="t-find" textAnchor="end">
            ◆ {found}
          </text>
        ) : null}
      </g>
    );
  }
  const agent = taskOf(n.taskId);
  return (
    <g className={`rg-node experiment st-${st}${isSel ? ' sel' : ''}`} transform={at} onClick={click} onDoubleClick={dbl} data-testid="research-node" data-kind="experiment" data-title={n.title}>
      <rect className="box" width={W} height={H} rx={10} />
      <circle cx={14} cy={17} r={4.8} className={`st-${st}`} />
      <text x={25} y={21} className="t1">
        {clip(n.title, 14)}
      </text>
      <text x={W - 10} y={21} className={`t-val ${st}`} textAnchor="end">
        {n.value != null ? formatValue(metric, n.value) : st === 'running' ? '…' : ''}
      </text>
      <text x={12} y={41} className="t2">
        {agent ? `${agent.alias} · ${agent.worktree ? t('own worktree') : t('shared folder')}` : t('no agent')}
      </text>
      {n.findings?.length ? (
        <text x={W - 10} y={41} className="t-find" textAnchor="end">
          ◆ {n.findings.length}
        </text>
      ) : null}
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

function AspectPanel({ ctx, node }: { ctx: Ctx; node: ResearchNode }) {
  const { doc } = ctx;
  const methods = childrenOf(doc, node.id);
  const m = node.metric;
  return (
    <>
      <Question>{node.combos ? t('How do methods from different aspects work together?') : t('Which methods are there for "{aspect}"?', { aspect: node.title })}</Question>
      <AgentLine ctx={ctx} task={ctx.taskOf(node.taskId)} role={t('owns this aspect')} none={node.combos ? t('The main agent looks after combinations across aspects.') : t('No agent yet: the first thing you say to it below starts one.')} />
      <div className="rs-kv">
        <span>{t('Validated by')}</span>
        <span>{m ? `${m.name} · ${m.higherIsBetter ? t('higher is better') : t('lower is better')}${m.baseline != null ? ` · ${t('starts at {v}', { v: formatValue(m, m.baseline) })}` : ''}` : t('judged by hand')}</span>
      </div>
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
      <AgentLine ctx={ctx} task={ctx.taskOf(aspect.taskId)} role={t('owns "{aspect}"', { aspect: aspect.title })} none={aspect.combos ? t('The main agent looks after combinations across aspects.') : t('No agent yet: the first thing you say to it below starts one.')} />
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
          {best ? <div className="muted small">{t('best {v} ({name})', { v: formatValue(m, best.value), name: best.title })}</div> : null}
          {m ? <ResultBars metric={m} exps={exps} statusOf={ctx.statusOf} select={ctx.select} /> : null}
          <table className="rs-table">
            <tbody>
              {exps.map((e) => {
                const st = ctx.statusOf(e);
                return (
                  <tr key={e.id} className="clickable" onClick={() => ctx.select(e.id)}>
                    <td>
                      <i className={`rg-dot st-${st}`} /> {e.title}
                      {e.findings?.length ? <span className="rs-find-count">◆ {e.findings.length}</span> : null}
                    </td>
                    <td>{e.value != null ? formatValue(m, e.value) : t(STATUS_LABEL[st])}</td>
                    <td className="muted">{ctx.taskOf(e.taskId)?.alias ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <div className="muted small">{t('Not tried yet.')}</div>
      )}
      <Findings ctx={ctx} items={exps.flatMap((e) => (e.findings ?? []).map((f) => ({ ...f, on: e })))} />
    </>
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
          {m?.baseline != null ? <span className="muted"> · {t('start {v}', { v: formatValue(m, m.baseline) })}</span> : null}
        </span>
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
  // Who gets it (decided again in the main process when sent): the agent of the nearest node over the selection.
  const route = routeFor(doc, selected);
  const routed: Task | undefined = route.kind === 'experiment' ? ctx.taskOf(route.node.taskId) : route.kind === 'aspect' ? ctx.taskOf(route.aspect.taskId) : snapshot.main;
  const to =
    route.kind === 'experiment'
      ? t('{agent} (experiment "{name}")', { agent: routed?.alias ?? '', name: clip(route.node.title, 14) })
      : route.kind === 'aspect'
        ? routed
          ? t('{agent} ({aspect} aspect)', { agent: routed.alias, aspect: route.aspect.title })
          : t('a new agent for "{aspect}"', { aspect: route.aspect.title })
        : snapshot.main
          ? t('Main agent')
          : t('Main agent (off)');
  const disabled = route.kind === 'main' && !snapshot.main;
  const target: ComposerTarget = {
    label: (
      <span data-testid="research-to">
        {t('To: {alias}', { alias: to })}
        {routed && route.kind !== 'main' ? ` · ${PROVIDER_LABEL[routed.provider]}` : ''}
      </span>
    ),
    placeholder: disabled
      ? t('Turn the main agent on in Settings to talk about the whole research.')
      : selected.length > 1
        ? t('e.g. Combine these into one method')
        : one?.type === 'aspect'
          ? t('e.g. Which methods would you try first?')
          : one?.type === 'method'
            ? t('e.g. Try thresholds 0.82 and 0.87 in parallel')
            : one?.type === 'experiment'
              ? t('e.g. Rerun with half the learning rate')
              : t('e.g. Add an aspect for inference speed · Turn Alice’s and Bob’s conversations into this tree'),
    disabled,
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
        const r = await call('research:message', { projectId: ctx.project, nodeIds: selected.map((n) => n.id), text, ...(images.length ? { images } : {}) });
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
