import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentProvider, Task, WorkspaceSnapshot } from '../../shared/types';
import {
  addFinding,
  addNode,
  aspectOf,
  bestExperiment,
  childrenOf,
  contributions,
  experimentStatus,
  formatValue,
  GRAPH,
  judge,
  layoutGraph,
  methodStatus,
  newId,
  removeNode,
  updateNode,
  type GraphDepth,
  type GraphItem,
  type ResearchDoc,
  type ResearchLinkKind,
  type ResearchMetric,
  type ResearchNode,
  type ResearchStatus,
} from '../../shared/research';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { SideSlot } from '../side-slot';
import { Alias, Icon, STATUS_LABEL as AGENT_STATUS } from './bits';
import { Modal } from './Dialogs';
import { PanelResizer } from './FocusView';
import { SidePanel } from './SidePanel';

const STATUS_LABEL: Record<ResearchStatus, string> = { idea: 'Not tried', running: 'Running', pass: 'Works', fail: 'Does not work', error: 'No result' };
const LINK_LABEL: Record<ResearchLinkKind, string> = { combine: 'Combined', mutate: 'Mutated', borrow: 'Borrows' };
const PANEL_W = 380;

/** A provider that can start an agent now (as the new-task dialog picks its default). */
function providerFor(snapshot: WorkspaceSnapshot): AgentProvider | null {
  // The demo shows the page with mock agents (no model calls); otherwise Claude Code, then Codex.
  const list: AgentProvider[] = snapshot.demo ? ['mock', 'claude', 'codex'] : ['claude', 'codex'];
  return list.find((p) => snapshot.capabilities.find((c) => c.provider === p)?.available) ?? null;
}

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

  useEffect(() => {
    let live = true;
    setDoc(undefined);
    setSel([]);
    call('research:get', { projectId })
      .then((d) => live && setDoc(d))
      .catch((e) => live && (setError(errorText(e)), setDoc(null)));
    return () => {
      live = false;
    };
  }, [projectId]);

  /** Every edit: shown at once, then written to the repository. */
  const commit = (next: ResearchDoc) => {
    setDoc(next);
    call('research:save', { projectId, doc: next }).catch((e) => setError(errorText(e)));
  };

  const taskOf = (id?: string) => (id ? snapshot.tasks.find((x) => x.taskId === id) : undefined);
  const statusOf = (n: ResearchNode): ResearchStatus => (n.type === 'experiment' ? experimentStatus(n, taskOf(n.taskId)?.status) : n.type === 'method' && doc ? methodStatus(doc, n, statusOf) : n.status);

  if (!project) return null;
  if (doc === undefined) return <div className="research-empty muted">{t('Loading…')}</div>;
  if (!doc) return <div className="research-empty muted">{error || t('This project has no research yet.')}</div>;

  const selected = sel.map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is ResearchNode => !!n);
  const exps = doc.nodes.filter((n) => n.type === 'experiment');
  const count = (s: ResearchStatus) => exps.filter((e) => statusOf(e) === s).length;
  const select = (id: string, add: boolean) => setSel((cur) => (add ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur.length === 1 && cur[0] === id ? [] : [id]));

  const ctx: Ctx = { snapshot, project: project.projectId, doc, commit, statusOf, taskOf, select: (id) => setSel(id ? [id] : []), onOpenAgent, setError, open: (id) => setOpened((o) => new Set(o).add(id)) };
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
      <Graph doc={doc} depth={depth} setDepth={setDepth} opened={opened} toggleOpen={(id) => setOpened((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; })} sel={sel} select={select} statusOf={statusOf} taskOf={taskOf} snapshot={snapshot} />
      <ResearchComposer ctx={ctx} selected={selected} onClear={() => setSel([])} />
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
  commit: (d: ResearchDoc) => void;
  statusOf: (n: ResearchNode) => ResearchStatus;
  taskOf: (id?: string) => Task | undefined;
  select: (id: string | null) => void;
  onOpenAgent: (taskId: string) => void;
  setError: (e: string) => void;
  open: (methodId: string) => void;
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
  const fitted = useRef('');
  const fit = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const w = L.width + 160, h = L.height + 110;
    const k = Math.min(1.1, Math.max(0.3, Math.min(r.width / w, (r.height - 40) / h)));
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
        </div>
      </div>
      <svg className="research-svg">
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges}
          {/* Under the nodes, so they never cover a title or a number; a selected method's own links come forward. */}
          <g className={`rg-links${sel.length ? ' has-sel' : ''}`}>{cross}</g>
          {L.items.map((it) => (
            <GraphNode key={it.id} it={it} doc={doc} sel={sel} select={select} toggleOpen={toggleOpen} statusOf={statusOf} taskOf={taskOf} snapshot={snapshot} />
          ))}
        </g>
      </svg>
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
      </div>
      {!childrenOf(doc, null).length ? <div className="research-hint">{t('Add the aspects that may move the result from the side column: data, model, training…')}</div> : null}
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function GraphNode({ it, doc, sel, select, toggleOpen, statusOf, taskOf, snapshot }: { it: GraphItem; doc: ResearchDoc; sel: string[]; select: (id: string, add: boolean) => void; toggleOpen: (id: string) => void; statusOf: (n: ResearchNode) => ResearchStatus; taskOf: (id?: string) => Task | undefined; snapshot: WorkspaceSnapshot }) {
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
  if (n.type === 'aspect') {
    const methods = childrenOf(doc, n.id);
    const agent = taskOf(n.taskId);
    return (
      <g className={`rg-node aspect${n.combos ? ' combos' : ''}${isSel ? ' sel' : ''}`} transform={at} onClick={click} data-testid="research-node" data-kind="aspect" data-title={n.title}>
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
      <g className={`rg-node method st-${st}${isSel ? ' sel' : ''}`} transform={at} onClick={click} data-testid="research-node" data-kind="method" data-title={n.title}>
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
    <g className={`rg-node experiment st-${st}${isSel ? ' sel' : ''}`} transform={at} onClick={click} data-testid="research-node" data-kind="experiment" data-title={n.title}>
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

// ------------------------------------------------------------------ side column: each level its own question

function Question({ children }: { children: ReactNode }) {
  return <div className="rs-question">{children}</div>;
}

function AgentLine({ ctx, task, role, onStart }: { ctx: Ctx; task?: Task; role: string; onStart?: () => void }) {
  if (!task)
    return (
      <div className="rs-agent none">
        <span className="muted">{t('No agent on this yet.')}</span>
        {onStart ? (
          <button className="btn btn-primary btn-sm" onClick={onStart} data-testid="research-start-agent">
            {t('Start an agent for it')}
          </button>
        ) : null}
      </div>
    );
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

function GoalPanel({ ctx }: { ctx: Ctx }) {
  const { doc } = ctx;
  const rows = contributions(doc);
  const max = Math.max(0.0001, ...rows.map((r) => Math.abs(r.estimate ?? 0)));
  const m = doc.endMetric;
  const [adding, setAdding] = useState<'aspect' | 'evidence' | null>(null);
  return (
    <>
      <Question>{t('Which aspects move the end result?')}</Question>
      <div className="rs-text">{doc.goal}</div>
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
          <div className="muted small">{t('Estimated from ablations: what taking an aspect’s changes out costs end to end. Hatched: one ablation only.')}</div>
        </div>
      ) : null}
      <div className="rs-sec">{t('Evidence: end-to-end runs and ablations')}</div>
      {doc.evidence.length ? (
        <table className="rs-table">
          <thead>
            <tr>
              <th>{t('Run')}</th>
              <th>{m?.name ?? t('Result')}</th>
              <th>{t('Change')}</th>
            </tr>
          </thead>
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
      ) : (
        <div className="muted small">{t('None yet. Record an end-to-end run, or an ablation (an aspect’s changes taken out), to see which aspects matter.')}</div>
      )}
      <div className="rs-actions">
        <button className="btn btn-sm" onClick={() => setAdding(adding === 'aspect' ? null : 'aspect')} data-testid="research-add-aspect">
          {t('Add an aspect')}
        </button>
        <button className="btn btn-sm" onClick={() => setAdding(adding === 'evidence' ? null : 'evidence')}>
          {t('Record a run')}
        </button>
      </div>
      {adding === 'aspect' ? <AddAspect ctx={ctx} onDone={() => setAdding(null)} /> : null}
      {adding === 'evidence' ? <AddEvidence ctx={ctx} onDone={() => setAdding(null)} /> : null}
    </>
  );
}

function AddAspect({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [metric, setMetric] = useState('');
  const [higher, setHigher] = useState(true);
  const [baseline, setBaseline] = useState('');
  const save = () => {
    if (!title.trim()) return;
    const m: ResearchMetric | undefined = metric.trim() ? { name: metric.trim(), higherIsBetter: higher, ...(baseline.trim() && !isNaN(+baseline) ? { baseline: +baseline } : {}) } : undefined;
    const r = addNode(ctx.doc, { type: 'aspect', parent: null, title: title.trim(), status: 'running', metric: m });
    ctx.commit(r.doc);
    ctx.select(r.node.id);
    onDone();
  };
  return (
    <div className="rs-form" data-testid="research-aspect-form">
      <input className="input" autoFocus placeholder={t('Aspect, e.g. Data')} value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="rs-form-row">
        <input className="input" placeholder={t('How it is validated: a metric (optional)')} value={metric} onChange={(e) => setMetric(e.target.value)} />
        <select className="input" value={higher ? 'up' : 'down'} onChange={(e) => setHigher(e.target.value === 'up')} disabled={!metric.trim()}>
          <option value="up">{t('higher is better')}</option>
          <option value="down">{t('lower is better')}</option>
        </select>
        <input className="input rs-num" placeholder={t('start')} value={baseline} onChange={(e) => setBaseline(e.target.value)} disabled={!metric.trim()} />
      </div>
      <div className="muted small">{t('Without a metric, its results are judged by hand: works / does not work.')}</div>
      <div className="rs-actions">
        <button className="btn btn-primary btn-sm" onClick={save} disabled={!title.trim()}>
          {t('Add')}
        </button>
        <button className="btn btn-sm" onClick={onDone}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}

function AddEvidence({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const aspects = childrenOf(ctx.doc, null).filter((a) => !a.combos);
  const [kind, setKind] = useState<'e2e' | 'ablation'>('e2e');
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [delta, setDelta] = useState('');
  const [aspect, setAspect] = useState(aspects[0]?.id ?? '');
  const ok = title.trim() && value.trim() && !isNaN(+value) && delta.trim() && !isNaN(+delta) && (kind === 'e2e' || aspect);
  const save = () => {
    if (!ok) return;
    ctx.commit({ ...ctx.doc, evidence: [...ctx.doc.evidence, { id: newId('ev'), kind, title: title.trim(), value: +value, delta: +delta, ...(kind === 'ablation' ? { aspect } : {}), at: new Date().toISOString() }], updatedAt: new Date().toISOString() });
    onDone();
  };
  return (
    <div className="rs-form">
      <div className="rs-form-row">
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'e2e' | 'ablation')}>
          <option value="e2e">{t('End-to-end run')}</option>
          <option value="ablation">{t('Ablation: an aspect taken out')}</option>
        </select>
        {kind === 'ablation' ? (
          <select className="input" value={aspect} onChange={(e) => setAspect(e.target.value)}>
            {aspects.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <input className="input" placeholder={t('What was run')} value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="rs-form-row">
        <input className="input" placeholder={ctx.doc.endMetric?.name ?? t('Result')} value={value} onChange={(e) => setValue(e.target.value)} />
        <input className="input" placeholder={t('Change against the run compared with')} value={delta} onChange={(e) => setDelta(e.target.value)} />
      </div>
      <div className="rs-actions">
        <button className="btn btn-primary btn-sm" onClick={save} disabled={!ok}>
          {t('Record')}
        </button>
        <button className="btn btn-sm" onClick={onDone}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}

function NodePanel({ ctx, node }: { ctx: Ctx; node: ResearchNode }) {
  if (node.type === 'aspect') return <AspectPanel ctx={ctx} node={node} />;
  if (node.type === 'method') return <MethodPanel ctx={ctx} node={node} />;
  return <ExperimentPanel ctx={ctx} node={node} />;
}

/** The instruction an agent starts with: its place in the research, what to do, and how it is validated. */
function roleBrief(doc: ResearchDoc, node: ResearchNode, extra = ''): string {
  const aspect = aspectOf(doc, node);
  const m = aspect?.metric;
  const how = m ? t('Validation: {metric} ({dir}){base}.', { metric: m.name, dir: m.higherIsBetter ? t('higher is better') : t('lower is better'), base: m.baseline != null ? t(', starting at {v}', { v: formatValue(m, m.baseline) }) : '' }) : t('Validation: judged by the user (works / does not work).');
  if (node.type === 'aspect')
    return [
      t('You own the "{aspect}" aspect of the research "{title}" ({goal}).', { aspect: node.title, title: doc.title, goal: doc.goal }),
      how,
      t('First list methods worth trying here, each in a line or two, and which could run in parallel. Do not change code yet; wait for the user to pick.'),
      extra,
    ]
      .filter(Boolean)
      .join('\n\n');
  const method = node.type === 'experiment' ? doc.nodes.find((n) => n.id === node.parent) : node;
  return [
    t('Research "{title}" · aspect "{aspect}" · method "{method}".', { title: doc.title, aspect: aspect?.title ?? '', method: method?.title ?? '' }),
    method?.design ? t('Design: {design}', { design: method.design }) : '',
    t('Try this variant: {config}', { config: node.config ?? node.title }),
    how,
    t('When done, report the result in one line ({metric}: value) and anything learned.', { metric: m?.name ?? t('works / does not work') }),
    extra,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function startAgent(ctx: Ctx, node: ResearchNode, opts: { isolate: boolean; message?: string }): Promise<string | undefined> {
  const provider = providerFor(ctx.snapshot);
  if (!provider) {
    ctx.setError(t('No signed-in Claude Code or Codex to start an agent. Open Settings to sign in.'));
    return undefined;
  }
  try {
    const task = await call('task:create', {
      projectId: ctx.project,
      provider,
      title: node.type === 'aspect' ? t('{title} (research)', { title: node.title }) : `${aspectOf(ctx.doc, node)?.title ?? ''} · ${node.title}`,
      instruction: roleBrief(ctx.doc, node, opts.message),
      isolate: opts.isolate,
      ...(provider === 'mock' ? { mockScript: 'work' } : {}),
    });
    return task.taskId;
  } catch (e) {
    ctx.setError(errorText(e));
    return undefined;
  }
}

function AspectPanel({ ctx, node }: { ctx: Ctx; node: ResearchNode }) {
  const { doc } = ctx;
  const methods = childrenOf(doc, node.id);
  const task = ctx.taskOf(node.taskId);
  const [adding, setAdding] = useState(false);
  const m = node.metric;
  return (
    <>
      <Question>{node.combos ? t('How do methods from different aspects work together?') : t('Which methods are there for "{aspect}"?', { aspect: node.title })}</Question>
      <AgentLine
        ctx={ctx}
        task={task}
        role={t('owns this aspect')}
        onStart={
          node.combos
            ? undefined
            : async () => {
                const id = await startAgent(ctx, node, { isolate: false });
                if (id) ctx.commit(updateNode(ctx.doc, node.id, { taskId: id }));
              }
        }
      />
      <div className="rs-kv">
        <span>{t('Validated by')}</span>
        <span>{m ? `${m.name} · ${m.higherIsBetter ? t('higher is better') : t('lower is better')}${m.baseline != null ? ` · ${t('starts at {v}', { v: formatValue(m, m.baseline) })}` : ''}` : t('judged by hand')}</span>
      </div>
      {methods.length ? (
        <table className="rs-table">
          <thead>
            <tr>
              <th>{t('Method')}</th>
              <th>{t('Status')}</th>
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
                    <i className={`rg-dot st-${st}`} /> {x.title}
                    {x.links?.[0] ? <span className={`pill link-${x.links[0].kind}`}>{t(LINK_LABEL[x.links[0].kind])}</span> : null}
                  </td>
                  <td>{t(STATUS_LABEL[st])}</td>
                  <td>{best ? formatValue(m, best.value) : '—'}</td>
                  <td>{childrenOf(doc, x.id).length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="muted small">{t('No methods yet. Add the ones you know, or ask the aspect’s agent for ideas in the box below.')}</div>
      )}
      <div className="rs-actions">
        <button className="btn btn-sm" onClick={() => setAdding(!adding)} data-testid="research-add-method">
          {t('Add a method')}
        </button>
      </div>
      {adding ? <AddMethod ctx={ctx} aspect={node} onDone={() => setAdding(false)} /> : null}
      {!node.combos ? <div className="muted small">{t('Dashed: not tried yet. Select a method to try variants of it in parallel, one agent each.')}</div> : <div className="muted small">{t('⇧-click methods from different aspects on the graph to combine them here.')}</div>}
    </>
  );
}

function AddMethod({ ctx, aspect, onDone, link }: { ctx: Ctx; aspect: ResearchNode; onDone: () => void; link?: { from: string; kind: ResearchLinkKind } }) {
  const [title, setTitle] = useState('');
  const [design, setDesign] = useState('');
  const save = () => {
    if (!title.trim()) return;
    const r = addNode(ctx.doc, { type: 'method', parent: aspect.id, title: title.trim(), status: 'idea', design: design.trim() || undefined, ...(link ? { links: [link] } : {}) });
    ctx.commit(r.doc);
    ctx.select(r.node.id);
    onDone();
  };
  return (
    <div className="rs-form" data-testid="research-method-form">
      <input className="input" autoFocus placeholder={link ? t('What changes in the new version') : t('Method, e.g. Deduplication')} value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="input" rows={3} placeholder={t('Design: how it works, its key parameters (optional)')} value={design} onChange={(e) => setDesign(e.target.value)} />
      <div className="rs-actions">
        <button className="btn btn-primary btn-sm" onClick={save} disabled={!title.trim()}>
          {t('Add')}
        </button>
        <button className="btn btn-sm" onClick={onDone}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}

function MethodPanel({ ctx, node }: { ctx: Ctx; node: ResearchNode }) {
  const { doc } = ctx;
  const aspect = aspectOf(doc, node)!;
  const m = aspect.metric;
  const exps = childrenOf(doc, node.id);
  const best = bestExperiment(doc, node);
  const [mode, setMode] = useState<'variants' | 'mutate' | 'design' | null>(null);
  const [variants, setVariants] = useState('');
  const [design, setDesign] = useState(node.design ?? '');
  const [busy, setBusy] = useState(false);
  const aspectAgent = ctx.taskOf(aspect.taskId);
  const findings = exps.flatMap((e) => (e.findings ?? []).map((f) => ({ f, e })));
  const tryVariants = async () => {
    const list = variants.split(/\s*[/、,，\n]\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
    if (!list.length) return;
    setBusy(true);
    let next = ctx.doc;
    for (const v of list) {
      const r = addNode(next, { type: 'experiment', parent: node.id, title: v, config: v, status: 'running' });
      next = r.doc;
      const id = await startAgent(ctx, { ...r.node }, { isolate: true });
      next = id ? updateNode(next, r.node.id, { taskId: id }) : updateNode(next, r.node.id, { status: 'idea' });
    }
    if (node.status === 'idea') next = updateNode(next, node.id, { status: 'running' });
    ctx.commit(next);
    ctx.open(node.id);
    setVariants('');
    setMode(null);
    setBusy(false);
  };
  return (
    <>
      <Question>{t('How is "{method}" designed, and how well does it work?', { method: node.title })}</Question>
      <div className="muted small">
        {t('In "{aspect}", owned by its agent', { aspect: aspect.title })}
        {aspectAgent ? ` ${aspectAgent.alias}` : ''}
      </div>
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
      <div className="rs-sec">
        {t('Design')}
        <button className="link small" onClick={() => setMode(mode === 'design' ? null : 'design')}>
          {mode === 'design' ? t('Cancel') : t('Edit')}
        </button>
      </div>
      {mode === 'design' ? (
        <div className="rs-form">
          <textarea className="input" rows={4} value={design} onChange={(e) => setDesign(e.target.value)} />
          <div className="rs-actions">
            <button className="btn btn-primary btn-sm" onClick={() => (ctx.commit(updateNode(doc, node.id, { design: design.trim() || undefined })), setMode(null))}>
              {t('Save')}
            </button>
          </div>
        </div>
      ) : (
        <div className="rs-design">{node.design || <span className="muted">{t('Not written yet.')}</span>}</div>
      )}
      {node.source && ctx.statusOf(node) === 'idea' ? <div className="muted small">{t('Idea from: {source}', { source: node.source })}</div> : null}
      {exps.length ? (
        <>
          <div className="rs-sec">
            {t('Results')} · {m?.name ?? t('judged by hand')}
          </div>
          {best ? <div className="muted small">{t('best {v} ({name})', { v: formatValue(m, best.value), name: best.title })}</div> : null}
          {m ? <ResultBars metric={m} exps={exps} statusOf={ctx.statusOf} select={ctx.select} /> : null}
          <table className="rs-table">
            <thead>
              <tr>
                <th>{t('Variant')}</th>
                <th>{t('Result')}</th>
                <th>{t('Agent')}</th>
              </tr>
            </thead>
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
                    <td className="muted">{ctx.taskOf(e.taskId)?.alias ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}
      {findings.length ? (
        <>
          <div className="rs-sec">{t('Findings (on its experiments)')}</div>
          {findings.map(({ f, e }) => (
            <div key={f.id} className="rs-finding">
              {f.text}{' '}
              <button className="link small" onClick={() => ctx.select(e.id)}>
                — {f.by ? `${f.by}, ` : ''}
                {e.title}
              </button>
            </div>
          ))}
        </>
      ) : null}
      <div className="rs-actions">
        <button className="btn btn-primary btn-sm" onClick={() => setMode(mode === 'variants' ? null : 'variants')} data-testid="research-try-variants">
          {t('Try variants in parallel')}
        </button>
        <button className="btn btn-sm" onClick={() => setMode(mode === 'mutate' ? null : 'mutate')} data-testid="research-mutate">
          {t('Mutate into a new method')}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => (ctx.commit(removeNode(doc, node.id)), ctx.select(null))}>
          {t('Remove')}
        </button>
      </div>
      {mode === 'variants' ? (
        <div className="rs-form" data-testid="research-variants-form">
          <input className="input" autoFocus placeholder={t('Variants, separated by / — e.g. 0.82 / 0.87 / 0.9')} value={variants} onChange={(e) => setVariants(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void tryVariants()} />
          <div className="muted small">{t('One agent per variant, each in its own worktree, told the design and how this aspect is validated.')}</div>
          <div className="rs-actions">
            <button className="btn btn-primary btn-sm" onClick={() => void tryVariants()} disabled={busy || !variants.trim()} data-testid="research-start-variants">
              {busy ? t('Starting…') : t('Start the agents')}
            </button>
          </div>
        </div>
      ) : null}
      {mode === 'mutate' ? <AddMethod ctx={ctx} aspect={aspect} link={{ from: node.id, kind: 'mutate' }} onDone={() => setMode(null)} /> : null}
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
  const [value, setValue] = useState(node.value != null ? String(node.value) : '');
  const [finding, setFinding] = useState('');
  useEffect(() => setValue(node.value != null ? String(node.value) : ''), [node.id, node.value]);
  const record = () => {
    if (!value.trim() || isNaN(+value)) return;
    ctx.commit(updateNode(doc, node.id, { value: +value, status: judge(m, +value) }));
  };
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
      <AgentLine
        ctx={ctx}
        task={task}
        role={task?.worktree ? t('one variant, own worktree') : t('one variant')}
        onStart={async () => {
          const id = await startAgent(ctx, node, { isolate: true });
          if (id) ctx.commit(updateNode(ctx.doc, node.id, { taskId: id, status: node.status === 'idea' ? 'running' : node.status }));
        }}
      />
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
      <div className="rs-sec">{t('Record the result')}</div>
      {m ? (
        <div className="rs-form-row">
          <input className="input rs-num" placeholder={m.name} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && record()} data-testid="research-result-input" />
          <button className="btn btn-sm btn-primary" onClick={record} disabled={!value.trim() || isNaN(+value)} data-testid="research-result-save">
            {t('Record')}
          </button>
          <button className="btn btn-sm" onClick={() => ctx.commit(updateNode(doc, node.id, { status: 'error', value: undefined }))}>
            {t('No result')}
          </button>
        </div>
      ) : (
        <div className="rs-actions">
          <button className="btn btn-sm btn-primary" onClick={() => ctx.commit(updateNode(doc, node.id, { status: 'pass' }))}>
            {t('Works')}
          </button>
          <button className="btn btn-sm" onClick={() => ctx.commit(updateNode(doc, node.id, { status: 'fail' }))}>
            {t('Does not work')}
          </button>
        </div>
      )}
      <div className="muted small">{m ? t('Compared with the aspect’s start: better passes, otherwise it does not.') : t('This aspect is judged by hand.')}</div>
      {node.config && node.config !== node.title ? (
        <>
          <div className="rs-sec">{t('What it changes')}</div>
          <div className="rs-design">{node.config}</div>
        </>
      ) : null}
      <div className="rs-sec">{t('Findings')}</div>
      {(node.findings ?? []).map((f) => (
        <div key={f.id} className="rs-finding">
          {f.text}
          {f.by ? <span className="muted"> — {f.by}</span> : null}
        </div>
      ))}
      <div className="rs-form-row">
        <input className="input" placeholder={t('What was learned (it stays with this experiment)')} value={finding} onChange={(e) => setFinding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && finding.trim() && (ctx.commit(addFinding(doc, node.id, finding.trim(), t('you'))), setFinding(''))} data-testid="research-finding-input" />
        <button className="btn btn-sm" disabled={!finding.trim()} onClick={() => (ctx.commit(addFinding(doc, node.id, finding.trim(), t('you'))), setFinding(''))}>
          {t('Add')}
        </button>
      </div>
      <div className="rs-actions">
        <button className="btn btn-sm btn-ghost" onClick={() => (ctx.commit(removeNode(doc, node.id)), ctx.select(method?.id ?? null))}>
          {t('Remove')}
        </button>
      </div>
    </>
  );
}

function MultiPanel({ ctx, nodes }: { ctx: Ctx; nodes: ResearchNode[] }) {
  const { doc } = ctx;
  const methods = nodes.filter((n) => n.type === 'method');
  const aspects = [...new Set(methods.map((m) => aspectOf(doc, m)?.id))];
  const cross = aspects.length > 1;
  const combine = () => {
    let next = doc;
    let where = cross ? childrenOf(next, null).find((a) => a.combos) : aspectOf(doc, methods[0]);
    if (!where) {
      const r = addNode(next, { type: 'aspect', parent: null, title: t('Across aspects'), status: 'running', combos: true, metric: doc.endMetric });
      next = r.doc;
      where = r.node;
    }
    const r = addNode(next, { type: 'method', parent: where.id, title: methods.map((m) => m.title).join(' + '), status: 'idea', design: methods.map((m) => t('From "{m}": its best variant', { m: m.title })).join('\n'), links: methods.map((m) => ({ from: m.id, kind: 'combine' as const })) });
    ctx.commit(r.doc);
    ctx.select(r.node.id);
  };
  return (
    <>
      <Question>{t('{n} selected', { n: nodes.length })}</Question>
      {nodes.map((n) => (
        <div key={n.id}>
          {n.title} <span className="muted">· {aspectOf(doc, n)?.title ?? ''}</span>
        </div>
      ))}
      {methods.length >= 2 ? (
        <>
          <div className="muted small">{cross ? t('From different aspects: the combination goes under "Across aspects", validated end to end.') : t('From the same aspect: the combination stays in it, validated by its metric.')}</div>
          <div className="rs-actions">
            <button className="btn btn-primary btn-sm" onClick={combine} data-testid="research-combine">
              {t('Combine into a new method')}
            </button>
          </div>
        </>
      ) : (
        <div className="muted small">{t('Select two or more methods to combine them.')}</div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the box: what is selected is who it talks to

function ResearchComposer({ ctx, selected, onClear }: { ctx: Ctx; selected: ResearchNode[]; onClear: () => void }) {
  const { doc, snapshot } = ctx;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ to: string; taskId: string } | null>(null);
  const one = selected.length === 1 ? selected[0] : undefined;
  const aspect = one ? aspectOf(doc, one) : undefined;
  // Who gets it: an experiment's agent, else its aspect's; a method is its aspect agent's; the goal (or several) the main agent's.
  const target: { task?: Task; label: string; prefix: string; startAspect?: ResearchNode } = (() => {
    if (one?.type === 'experiment' && ctx.taskOf(one.taskId)) return { task: ctx.taskOf(one.taskId), label: t('{agent} (experiment "{name}")', { agent: ctx.taskOf(one.taskId)!.alias, name: clip(one.title, 14) }), prefix: '' };
    if (one && aspect && !aspect.combos) {
      const at = ctx.taskOf(aspect.taskId);
      const prefix = one.type === 'aspect' ? '' : t('About "{name}" in the research tree: ', { name: one.title });
      if (at) return { task: at, label: t('{agent} ({aspect} aspect)', { agent: at.alias, aspect: aspect.title }), prefix };
      return { label: t('a new agent for "{aspect}"', { aspect: aspect.title }), prefix, startAspect: aspect };
    }
    const main = snapshot.main;
    const about = selected.length ? t('About {list} in the research "{title}": ', { list: selected.map((n) => `"${n.title}"`).join(', '), title: doc.title }) : t('About the research "{title}" ({goal}): ', { title: doc.title, goal: doc.goal });
    return main ? { task: main, label: t('Main agent'), prefix: about } : { label: t('Main agent (off)'), prefix: about };
  })();
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      let taskId = target.task?.taskId;
      if (!taskId && target.startAspect) {
        // An aspect with no agent: this message is the first thing its new agent hears.
        taskId = await startAgent(ctx, target.startAspect, { isolate: false, message: `${target.prefix}${text}` });
        if (taskId) ctx.commit(updateNode(ctx.doc, target.startAspect.id, { taskId }));
      } else if (taskId) {
        const r = await call('task:send', { taskId, text: `${target.prefix}${text}`, via: 'text' });
        if (!r.ok) throw new Error(r.error ?? t('Not delivered'));
      }
      if (taskId) {
        setSent({ to: target.task?.alias ?? ctx.snapshot.tasks.find((x) => x.taskId === taskId)?.alias ?? '', taskId });
        setDraft('');
      }
    } catch (e) {
      ctx.setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  const disabled = !target.task && !target.startAspect;
  return (
    <div className="composer research-composer">
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
      <div className="composer-about research-to" data-testid="research-to">
        <span className="composer-about-label">{t('To')}</span>
        <span className="composer-about-text">{target.label}</span>
        {selected.length ? (
          <button className="composer-about-clear" onClick={onClear} aria-label={t('Clear the selection')} title={t('Clear the selection')}>
            <Icon name="x" size={11} />
          </button>
        ) : null}
      </div>
      <div className="composer-box">
        <textarea
          className="composer-input"
          rows={2}
          value={draft}
          disabled={disabled}
          placeholder={disabled ? t('Turn the main agent on in Settings to talk about the whole research.') : one?.type === 'aspect' ? t('e.g. Which methods would you try first?') : one?.type === 'method' ? t('e.g. What would you change in this design?') : one?.type === 'experiment' ? t('e.g. Rerun with half the learning rate') : t('e.g. Which aspect deserves the next experiments?')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          data-testid="research-input"
        />
        <div className="composer-foot">
          <span className="hint">{t('Select a node to talk to its agent; ⇧-click to select several.')}</span>
          <button className="btn btn-primary btn-sm" onClick={() => void send()} disabled={disabled || sending || !draft.trim()} data-testid="research-send">
            {t('Send')}
          </button>
        </div>
      </div>
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
