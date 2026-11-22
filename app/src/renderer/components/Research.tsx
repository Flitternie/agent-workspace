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
  ancestry,
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
  researchColor,
  researchId,
} from '../../shared/research';
import { call, errorText } from '../api';
import { language as currentLanguage, t } from '../i18n';
import { SideSlot } from '../side-slot';
import { Alias, Icon, PROVIDER_LABEL, STATUS_LABEL as AGENT_STATUS } from './bits';
import { Markdown } from './Markdown';
import { timeAgo } from '../state';
import { Modal } from './Dialogs';
import { Composer, PanelResizer, WaitingOnYou, type ComposerTarget } from './FocusView';
import { SidePanel } from './SidePanel';
import { defaultProject, ProjectChooser } from './ProjectChooser';
import { menuAt, useContextMenu } from './ContextMenu';
import { parseUi, statText, type ResearchUi, type UiNodeField } from '../../shared/research-ui';
import { defaultView, levelOf, liveTable, parseView, templatesFor, viewKey, type TableSpec, type ViewBlockKind, type ViewLevel } from '../../shared/research-views';

const STATUS_LABEL: Record<ResearchStatus, string> = { idea: 'Not tried', running: 'Running', pass: 'Works', fail: 'Does not work', unclear: 'Unclear', error: 'No result' };

// The research's own interface settings (.research/ui.json, research-ui.ts), as read for the page being
// drawn: names of levels and states, each level's question, what nodes show, totals, default views.
let UI: ResearchUi = {};
const statusName = (st: ResearchStatus) => UI.statuses?.[st] ?? t(STATUS_LABEL[st]);
const LEVEL_NAME = { aspect: 'Aspect', method: 'Method', experiment: 'Experiment' } as const;
const LEVEL_PLURAL = { aspect: 'Aspects', method: 'Methods', experiment: 'Experiments' } as const;
const levelLabel = (l: 'aspect' | 'method' | 'experiment') => UI.labels?.[l] ?? t(LEVEL_NAME[l]);
const levelPlural = (l: 'aspect' | 'method' | 'experiment') => UI.plural?.[l] ?? UI.labels?.[l] ?? t(LEVEL_PLURAL[l]);
const LINK_LABEL: Record<ResearchLinkKind, string> = { combine: 'Combined', mutate: 'Mutated', borrow: 'Borrows' };
const PANEL_W = 380;
/** The graph keeps at least this much beside the side column. */
const GRAPH_MIN = 360;

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
  // Maximized: the panel takes the graph's place (as a side panel does a conversation's) until Esc or restored.
  const [panelMax, setPanelMax] = useState(false);
  useEffect(() => {
    if (!panelMax) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPanelMax(false);
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [panelMax]);
  const side = useContext(SideSlot);
  // What is new since the user last had this research open (kept on this Mac): marked until looked at.
  const seenKey = `amw.research.seen.${researchId}`;
  const lastSeen = useMemo(() => localStorage.getItem(seenKey) ?? new Date().toISOString(), [seenKey]);
  const [looked, setLooked] = useState<ReadonlySet<string>>(new Set());
  /** Nodes to bring into view (the graph pans to them): a click on a count at the top. */
  const [look, setLook] = useState<{ ids: string[]; n: number }>({ ids: [], n: 0 });
  const menu = useContextMenu();
  useEffect(() => {
    setLooked(new Set());
    const leave = () => localStorage.setItem(seenKey, new Date().toISOString());
    window.addEventListener('beforeunload', leave);
    return () => {
      leave();
      window.removeEventListener('beforeunload', leave);
    };
  }, [seenKey]);
  // The room the page and its side column share: the column never takes so much that the graph (or the
  // column's own title row, with its buttons) is pushed out; a narrower window narrows it too.
  const rootRef = useRef<HTMLDivElement>(null);
  const [pageW, setPageW] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPageW(el.clientWidth));
    ro.observe(el);
    setPageW(el.clientWidth);
    return () => ro.disconnect();
  }, [!!doc]);
  const shared = pageW + (panel && !panelMax ? panelW : 0);
  const maxPanel = shared ? Math.max(320, Math.min(shared * 0.7, shared - GRAPH_MIN)) : Infinity;
  const shownW = Math.min(panelW, maxPanel);

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

  // Read as the settings are now (an agent's change shows at the next render).
  UI = parseUi(notes.ui?.text);
  const selected = sel.map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is ResearchNode => !!n);
  const exps = doc.nodes.filter((n) => n.type === 'experiment');
  const count = (s: ResearchStatus) => exps.filter((e) => statusOf(e) === s).length;
  const select = (id: string, add: boolean) => {
    if (id) setLooked((l) => new Set(l).add(id));
    setSel((cur) => (add ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur.length === 1 && cur[0] === id ? [] : [id]));
  };
  // Who is at work and who waits on the user: what the graph unfolds, and the counts at the top.
  const asking = new Set(snapshot.attention.filter((a) => a.state === 'open' && a.kind !== 'completion').map((a) => a.taskId));
  const busy = (id?: string) => ['running', 'starting'].includes(taskOf(id)?.status ?? '');
  const inResearch = taskIdsOf(doc);
  const runningTasks = inResearch.filter((id) => busy(id));
  const waitingTasks = inResearch.filter((id) => asking.has(id));
  const active = new Set<string>();
  for (const n of doc.nodes) if ((n.taskId && (busy(n.taskId) || asking.has(n.taskId))) || (n.type === 'experiment' && statusOf(n) === 'running')) for (const a of ancestry(doc, n)) active.add(a.id);
  const fresh = new Set(exps.filter((e) => e.resultAt && e.resultAt > lastSeen && !looked.has(e.id)).map((e) => e.id));
  /** Rings the nodes of these agents (the lead's is the goal: nothing selected). */
  const ring = (taskIds: string[]) => {
    const ids = doc.nodes.filter((n) => n.taskId && taskIds.includes(n.taskId)).map((n) => n.id);
    setSel(ids);
    setLook((l) => ({ ids, n: l.n + 1 }));
  };
  /** A right-click on a node with an agent: open its conversation, or take it out of the research (it is an ordinary agent again; the node stays). */
  const nodeMenu = (e: ReactMouseEvent, n?: ResearchNode) => {
    const task = taskOf(n ? n.taskId : doc.leadTaskId);
    if (!task) return;
    const out = () =>
      void call('research:save', { researchId, doc: { ...(n ? { ...doc, nodes: doc.nodes.map((x) => (x.id === n.id ? { ...x, taskId: undefined } : x)) } : { ...doc, leadTaskId: undefined }), updatedAt: new Date().toISOString() } }).catch((err) => setError(errorText(err)));
    menu.open(
      menuAt(
        e,
        [
          { id: 'node-open', label: t('Open {alias}’s conversation', { alias: task.alias }), onSelect: () => onOpenAgent(task.taskId) },
          { id: 'node-out', label: t('Take {alias} out of the research', { alias: task.alias }), onSelect: out },
        ],
        'research-node-menu',
      ),
    );
  };
  const ringFresh = () => {
    setOpened((o) => new Set([...o, ...exps.filter((e) => fresh.has(e.id)).map((e) => e.parent!)]));
    setSel([...fresh]);
    setLook((l) => ({ ids: [...fresh], n: l.n + 1 }));
    setLooked((l) => new Set([...l, ...fresh]));
  };

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
      frame={{ width: shownW, maximized: panelMax, onToggleMax: () => setPanelMax(!panelMax), onClose: () => (setPanel(false), setPanelMax(false)) }}
    >
      <div className="research-side">{selected.length > 1 ? <MultiPanel ctx={ctx} nodes={selected} /> : <NodeView ctx={ctx} node={selected[0]} />}</div>
    </SidePanel>
  ) : null;

  return (
    <div className="research" ref={rootRef} data-testid="research" style={{ ['--research-color' as string]: researchColor(summary ?? { id: researchId }) }}>
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
            {(['pass', 'unclear', 'running', 'fail', 'error'] as const).map((s) => (count(s) ? <i key={s} className={`st-${s}`} style={{ width: `${(count(s) / exps.length) * 100}%` }} /> : null))}
          </span>
          <span className="muted">{t('{n} work', { n: count('pass') })}</span>
        </div>
        {/* What is going on, at a glance; a click rings those nodes in the graph. */}
        {runningTasks.length || waitingTasks.length || fresh.size || UI.header?.some((h) => statText(doc, undefined, h)) ? (
          <div className="research-now" data-testid="research-now">
            {(UI.header ?? []).map((h, i) =>
              statText(doc, undefined, h) ? (
                <span key={i} className="research-chip total" data-testid="research-total">
                  {statText(doc, undefined, h)}
                </span>
              ) : null,
            )}
            {runningTasks.length ? (
              <button className="research-chip run" onClick={() => ring(runningTasks)} data-testid="research-now-running">
                <i className="rg-dot st-running" /> {t('{n} running', { n: runningTasks.length })}
              </button>
            ) : null}
            {waitingTasks.length ? (
              <button className="research-chip wait" onClick={() => ring(waitingTasks)} data-testid="research-now-waiting">
                ⚑ {t('{n} waiting on you', { n: waitingTasks.length })}
              </button>
            ) : null}
            {fresh.size ? (
              <button className="research-chip new" onClick={ringFresh} title={t('Results recorded since you last had this research open')} data-testid="research-now-new">
                <i className="rg-fresh-dot" /> {fresh.size === 1 ? t('1 new result') : t('{n} new results', { n: fresh.size })}
              </button>
            ) : null}
          </div>
        ) : null}
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
      {panelMax ? sidePanel : null}
      <div className="research-stage" hidden={panelMax}>
      <Graph doc={doc} depth={depth} setDepth={setDepth} openNode={openNode} opened={opened} toggleOpen={(id) => setOpened((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; })} sel={sel} select={select} statusOf={statusOf} taskOf={taskOf} snapshot={snapshot} active={active} fresh={fresh} onMenu={nodeMenu} look={look} />
      {menu.element}
      <ResearchComposer ctx={ctx} selected={selected} onClear={() => setSel([])} />
      </div>
      {sidePanel && !panelMax
        ? side
          ? createPortal(
              <>
                <PanelResizer width={shownW} room={0} onChange={(w) => setPanelW(Math.min(w, maxPanel))} reset={PANEL_W} min={320} />
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
  return n.type === 'aspect' && n.combos ? t('Across aspects') : levelLabel(n.type);
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
  active,
  fresh,
  onMenu,
  look,
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
  /** Nodes with an agent at work or waiting on the user, and their ancestors: always unfolded. */
  active: ReadonlySet<string>;
  /** Experiments with a result the user has not looked at. */
  fresh: ReadonlySet<string>;
  onMenu: (e: ReactMouseEvent, n?: ResearchNode) => void;
  /** Nodes to bring into view (each new `n` pans once). */
  look: { ids: string[]; n: number };
}) {
  const box = useRef<HTMLDivElement>(null);
  const [only, setOnly] = useState(false);
  const activeKey = [...active].sort().join(',');
  const L = useMemo(() => layoutGraph(doc, depth, opened, { active, only }), [doc, depth, opened, activeKey, only]);
  const [view, setView] = useState({ x: 24, y: 60, k: 1 });
  const [legend, setLegend] = useState(false);
  const fitted = useRef('');
  const fit = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const w = L.width + 60, h = L.height + 90;
    // Room left above the box floating at the bottom.
    const below = box.current?.parentElement?.querySelector('.research-composer')?.getBoundingClientRect().height ?? 0;
    // Never below a readable size: a tree too big for the page is panned (and zoomed out by hand), not shrunk unreadable.
    const k = Math.min(1.1, Math.max(0.75, Math.min(r.width / w, h > (r.height - 40 - below) * 1.6 ? Infinity : (r.height - 40 - below) / h)));
    setView({ x: 24, y: 60, k });
  };
  // Fit when the graph's shape changes level, not on every edit (the view stays where the user put it).
  useLayoutEffect(() => {
    if (fitted.current !== `${depth}:${only}`) {
      fitted.current = `${depth}:${only}`;
      fit();
    }
  });
  // Asked to look at some nodes: pan so they sit in the room above the box (their middle at the middle).
  useEffect(() => {
    if (!look.n) return;
    const r = box.current?.getBoundingClientRect();
    const its = look.ids.map((id) => L.at.get(id)).filter((x): x is GraphItem => !!x);
    if (!r || !its.length) return;
    const below = box.current?.parentElement?.querySelector('.research-composer')?.getBoundingClientRect().height ?? 0;
    setView((v) => {
      const x0 = Math.min(...its.map((i) => i.x)), x1 = Math.max(...its.map((i) => i.x)) + GRAPH.nodeW;
      const y0 = Math.min(...its.map((i) => i.y)), y1 = Math.max(...its.map((i) => i.y)) + GRAPH.nodeH;
      return { k: v.k, x: r.width / 2 - ((x0 + x1) / 2) * v.k, y: (r.height - below) / 2 - ((y0 + y1) / 2) * v.k };
    });
  }, [look.n]);
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
              ['aspect', levelPlural('aspect')],
              ['method', levelPlural('method')],
              ['experiment', levelPlural('experiment')],
            ] as const
          ).map(([d, l]) => (
            <button key={d} className={depth === d ? 'on' : ''} aria-pressed={depth === d} onClick={() => setDepth(d)} data-testid={`research-depth-${d}`}>
              {l}
            </button>
          ))}
        </div>
        <button className={`btn btn-sm btn-ghost research-only${only ? ' on' : ''}`} onClick={() => setOnly(!only)} aria-pressed={only} title={t('Show only what has an agent at work or waiting on you')} data-testid="research-only">
          {t('In progress only')}
        </button>
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
            <GraphNode key={it.id} it={it} doc={doc} sel={sel} select={select} toggleOpen={toggleOpen} openNode={openNode} statusOf={statusOf} taskOf={taskOf} snapshot={snapshot} fresh={fresh} onMenu={onMenu} />
          ))}
        </g>
      </svg>
      {legend ? (
      <div className="research-legend" data-testid="research-legend">
        {(['running', 'pass', 'fail', 'unclear', 'idea'] as const).map((s) => (
          <span key={s}>
            <i className={`rg-dot st-${s}`} /> {statusName(s)}
          </span>
        ))}
        <span className="lk combine">┅ {t('Combined')}</span>
        <span className="lk mutate">┅ {t('Mutated')}</span>
        <span className="lk borrow">┈ {t('Borrows')}</span>
        <span className="lk finding">◆ {t('Finding')}</span>
        <span className="lk-how">{t('Click: talk to its agent · ⇧-click: several · double-click: open its conversation')}</span>
      </div>
      ) : null}
      {only && !active.size ? <div className="research-hint">{t('Nothing in progress right now.')}</div> : null}
      {!childrenOf(doc, null).length ? <div className="research-hint">{t('Ask below to add the aspects that may move the result: data, model, training…')}</div> : null}
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Clipped to a width: a CJK character counts as two. */
const clipW = (s: string, units: number) => {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    w += s.charCodeAt(i) > 0x2e7f ? 2 : 1;
    if (w > units) return `${s.slice(0, Math.max(0, i - 1))}…`;
  }
  return s;
};
const sinceText = (iso?: string) => {
  const m = iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000)) : 0;
  return m < 1 ? '' : m < 60 ? t('{n} min', { n: m }) : t('{n} h', { n: (m / 60).toFixed(1) });
};

function GraphNode({ it, doc, sel, select, toggleOpen, openNode, statusOf, taskOf, snapshot, fresh, onMenu }: { it: GraphItem; doc: ResearchDoc; sel: string[]; select: (id: string, add: boolean) => void; toggleOpen: (id: string) => void; openNode: (n?: ResearchNode) => void; statusOf: (n: ResearchNode) => ResearchStatus; taskOf: (id?: string) => Task | undefined; snapshot: WorkspaceSnapshot; fresh: ReadonlySet<string>; onMenu: (e: ReactMouseEvent, n?: ResearchNode) => void }) {
  const { nodeW: W, nodeH: H } = GRAPH;
  const waiting = (taskId?: string) => (taskId ? snapshot.attention.filter((a) => a.taskId === taskId && a.state === 'open' && a.kind !== 'completion').length : 0);
  /** What an agent is up to, as far as the user cares: waiting on them, or running (for how long); else nothing. */
  const doing = (task?: Task): string => {
    if (!task) return '';
    if (waiting(task.taskId)) return `${task.alias} · ${t('waiting on you')}`;
    if (task.status === 'running' || task.status === 'starting') return [task.alias, t('running'), sinceText(task.statusSince)].filter(Boolean).join(' · ');
    return '';
  };
  /** The node's second line as the research's settings say (when they do), from its built-in pieces and its results. */
  const custom = (n: ResearchNode, pieces: { agent?: string; tally?: string; findings?: number }): string | null => {
    const fields: UiNodeField[] | undefined = UI.node?.[n.type];
    if (!fields) return null;
    return fields
      .map((f) => (f === 'takeaway' ? (n.takeaway ?? '') : f === 'agent' ? (pieces.agent ?? '') : f === 'tally' ? (pieces.tally ?? '') : f === 'findings' ? (pieces.findings ? `◆${pieces.findings}` : '') : statText(doc, n, f)))
      .filter(Boolean)
      .join(' · ');
  };
  /** A result not looked at yet: on the node itself, or under it when nothing is drawn below it. */
  const under = (id: string): string[] => doc.nodes.filter((x) => x.parent === id).flatMap((x) => [x.id, ...under(x.id)]);
  const isFresh = it.kind === 'runs' ? it.runs!.some((e) => fresh.has(e.id)) : it.node ? fresh.has(it.node.id) || (!it.children.length && under(it.node.id).some((id) => fresh.has(id))) : false;
  const freshDot = isFresh ? <circle cx={W - 1} cy={H - 1} r={4.5} className="rg-fresh" /> : null;
  const at = `translate(${it.x},${it.y})`;
  const badge = (n: number) =>
    n ? (
      <g transform={`translate(${W - 6},-6)`} className="rg-badge">
        <circle r={9} />
        <text y={4}>{n}</text>
      </g>
    ) : null;
  if (it.kind === 'goal')
    return (
      <g className={`rg-node goal${sel.length ? '' : ' sel'}`} transform={at} onClick={() => select('', false)} onDoubleClick={() => openNode()} onContextMenu={(e) => onMenu(e)} data-testid="research-node" data-kind="goal">
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
        {freshDot}
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
    const own = custom(n, { agent: agent?.alias, tally: tally(exps), findings: exps.reduce((a, e) => a + (e.findings?.length ?? 0), 0) });
    return (
      <g className={`rg-node aspect${n.combos ? ' combos' : ''}${isSel ? ' sel' : ''}${waiting(n.taskId) ? ' waiting' : ''}`} transform={at} onClick={click} onDoubleClick={dbl} onContextMenu={(e) => onMenu(e, n)} data-testid="research-node" data-kind="aspect" data-title={n.title}>
        {tip([n.title, n.takeaway, n.metric ? `${n.metric.name} (${n.metric.higherIsBetter ? '↑' : '↓'})` : t('judged by hand'), agent ? `${agent.alias} · ${t(AGENT_STATUS[agent.status])}` : t('no agent yet'), tally(exps)])}
        <rect className="box" width={W} height={H} rx={10} />
        <text x={12} y={22} className="t1 strong">
          {clip(n.title, 13)}
        </text>
        <text x={W - 10} y={22} className={`t2${bestG > -Infinity ? ' gain' : ''}`} textAnchor="end">
          {bestG > -Infinity ? pct(bestG) : methods.length === 1 ? t('1 method') : t('{n} methods', { n: methods.length })}
        </text>
        <text x={12} y={41} className="t2">
          {doing(agent) ? clipW(doing(agent), 34) : own != null ? clipW(own, 34) : n.takeaway ? clipW(n.takeaway, 34) : clip(`${agent ? agent.alias : t('no agent yet')} · ${n.metric ? n.metric.name : t('judged by hand')}`, 22)}
        </text>
        {doing(agent) || own != null || n.takeaway ? null : (
          <text x={W - 10} y={41} className="t2 tally" textAnchor="end">
            {tally(exps)}
          </text>
        )}
        {badge(waiting(n.taskId))}
        {freshDot}
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
    const own = custom(n, { agent: taskOf(aspectOf(doc, n)?.taskId)?.alias, tally: tally(exps), findings: found });
    return (
      <g className={`rg-node method ns-${st}${isSel ? ' sel' : ''}`} transform={at} onClick={click} onDoubleClick={dbl} data-testid="research-node" data-kind="method" data-title={n.title}>
        {tip([n.title, n.takeaway, statusName(st), best ? `${t('best {v} ({name})', { v: formatValue(metric, best.value), name: best.title })}${g != null ? ` · ${pct(g)}` : ''}` : '', link ? `${t(LINK_LABEL[link.kind])}: ${doc.nodes.find((x) => x.id === link.from)?.title ?? ''}` : '', lastFinding ? `◆ ${lastFinding.text}` : '', n.design])}
        <rect className="box" width={W} height={H} rx={10} />
        <circle cx={14} cy={17} r={4.8} className={`st-${st}`} />
        <text x={25} y={21} className="t1">
          {clip(n.title, 13)}
        </text>
        <text x={W - 10} y={21} className={`t-val ${st}`} textAnchor="end">
          {best ? formatValue(metric, best.value) : st === 'running' ? '…' : ''}
        </text>
        <text x={12} y={41} className="t2">
          {own != null ? clipW(own, 34) : n.takeaway ? clipW(n.takeaway, 34) : clip(st === 'idea' ? (n.source ?? t('Not tried')) : [link ? t(LINK_LABEL[link.kind]) : '', tally(exps), found ? `◆${found}` : ''].filter(Boolean).join(' · '), 26)}
        </text>
        {freshDot}
        {g != null && !n.takeaway && own == null ? (
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
  const own = custom(n, { agent: agent?.alias, findings: n.findings?.length });
  return (
    <g className={`rg-node experiment ns-${st}${isSel ? ' sel' : ''}${isBest ? ' best' : ''}${waiting(n.taskId) ? ' waiting' : ''}`} transform={at} onClick={click} onDoubleClick={dbl} onContextMenu={(e) => onMenu(e, n)} data-testid="research-node" data-kind="experiment" data-title={n.title}>
      {tip([`${isBest ? '★ ' : ''}${n.title}`, n.takeaway, statusName(st), n.value != null ? `${formatValue(metric, n.value)}${spread ? ` ± ${formatValue(metric, spread.sd)} (${spread.n})` : ''}${g != null ? ` · ${pct(g)}` : ''}` : '', agent ? `${agent.alias} · ${t(AGENT_STATUS[agent.status])}` : '', n.findings?.at(-1) ? `◆ ${n.findings.at(-1)!.text}` : ''])}
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
        {doing(agent) ? clipW(doing(agent), 34) : own != null ? clipW(own, 34) : n.takeaway ? clipW(n.takeaway, 34) : agent ? agent.alias : st === 'running' ? t('running') : t('no agent')}
      </text>
      {doing(agent) || own != null || n.takeaway ? null : (
        <text x={W - 10} y={41} className={n.findings?.length ? 't-find' : `t2 ${g != null && g >= 0 ? 'gain' : 'loss'}`} textAnchor="end">
          {n.findings?.length ? `◆ ${n.findings.length}` : pct(g)}
        </text>
      )}
      {badge(waiting(n.taskId))}
      {freshDot}
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
/** `of`: the name the note is about; a first heading repeating it is left out (the panel says it already). */
function NoteCard({ title, of, note, behind, empty, testId }: { title: string; of?: string; note?: ResearchNote; behind: number; empty: string; testId: string }) {
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
          <Markdown text={of && note.text.trimStart().startsWith(`# ${of}\n`) ? note.text.trimStart().slice(of.length + 3) : note.text} />
        </div>
      ) : (
        <div className="muted small">{empty}</div>
      )}
    </div>
  );
}


// ------------------------------------------------------------------ a node's view: blocks, from its view file or its level's template

/** What a node's panel shows: who works on it (fixed), then its view (research-views.ts), which agents and people rewrite. */
function NodeView({ ctx, node }: { ctx: Ctx; node?: ResearchNode }) {
  const { doc } = ctx;
  const level = levelOf(node);
  const key = viewKey(node);
  const own = ctx.notes.views?.[key];
  const text = own?.text ?? UI.views?.[level] ?? defaultView(level);
  const aspect = node ? aspectOf(doc, node) : undefined;
  const method = node?.type === 'experiment' ? doc.nodes.find((n) => n.id === node.parent) : undefined;
  const lead = { task: ctx.taskOf(doc.leadTaskId), role: t('research lead'), none: t('No research lead yet: what you say below starts one; lay the research out with it step by step.') };
  const who = !node
    ? lead
    : node.type === 'experiment'
      ? { task: ctx.taskOf(node.taskId), role: ctx.taskOf(node.taskId)?.worktree ? t('one variant, own worktree') : t('one variant'), none: t('No agent on this one.') }
      : aspect?.combos
        ? { ...lead, none: t('The research lead looks after combinations across aspects.') }
        : { task: ctx.taskOf(aspect?.taskId), role: node.type === 'aspect' ? t('owns this aspect') : t('owns "{aspect}"', { aspect: aspect?.title ?? '' }), none: t('No agent yet: the first thing you say to it below starts one.') };
  const asked = UI.questions?.[level]?.replaceAll('{title}', node?.title ?? doc.title);
  const question = asked ? asked : !node
    ? t('Which aspects move the end result?')
    : node.type === 'aspect'
      ? node.combos
        ? t('How do methods from different aspects work together?')
        : t('Which methods are there for "{aspect}"?', { aspect: node.title })
      : node.type === 'method'
        ? t('How is "{method}" designed, and how well does it work?', { method: node.title })
        : node.title;
  return (
    <>
      <Question>{question}</Question>
      {!node ? <div className="rs-text">{doc.goal}</div> : null}
      {method ? (
        <div className="muted small">
          {t('Variant of')}{' '}
          <button className="link small" onClick={() => ctx.select(method.id)}>
            {method.title}
          </button>{' '}
          · {aspect?.title}
        </div>
      ) : null}
      <AgentLine ctx={ctx} task={who.task} role={who.role} none={who.none} />
      <ViewBar ctx={ctx} level={level} viewKey={key} text={text} own={!!own} />
      <div className="rs-view" data-testid="research-view">
        {parseView(text).map((part, i) =>
          part.type === 'md' ? (
            <div key={i} className="rs-view-md">
              <Markdown text={part.text} />
            </div>
          ) : part.type === 'html' ? (
            <HtmlBlock key={i} html={part.html} height={part.height} />
          ) : part.error ? (
            <div key={i} className="error-text small">
              {part.error}
            </div>
          ) : (
            <Fragment key={i}>{renderBlock(ctx, node, part.kind, part.options)}</Fragment>
          ),
        )}
      </div>
    </>
  );
}

/** Which view it is (its own, or a template), and putting a template in place. Asking below rewrites it. */
function ViewBar({ ctx, level, viewKey: key, text, own }: { ctx: Ctx; level: ViewLevel; viewKey: string; text: string; own: boolean }) {
  const list = templatesFor(level);
  const at = list.find((v) => v.text.trim() === text.trim());
  const lang = currentLanguage() === 'zh' ? 'zh' : 'en';
  return (
    <div className="rs-viewbar" title={t('What this panel shows is a view an agent can rewrite: ask below for what you want to see.')}>
      <span className="muted small">{t('Panel view')}</span>
      <select
        className="rs-viewpick"
        value={at?.id ?? ''}
        onChange={(e) => {
          const v = list.find((x) => x.id === e.target.value);
          if (v) void call('research:view', { researchId: ctx.research, key, text: v.text }).catch((err) => ctx.setError(String((err as Error).message)));
        }}
        data-testid="research-view-pick"
      >
        {at ? null : <option value="">{own ? t('Its own view') : t('Template')}</option>}
        {list.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name[lang]}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A view's live block, drawn from the tree as it is now. */
function renderBlock(ctx: Ctx, node: ResearchNode | undefined, kind: ViewBlockKind, options: Record<string, unknown>): ReactNode {
  const { doc } = ctx;
  const aspect = node ? aspectOf(doc, node) : undefined;
  const m = aspect?.metric ?? (!node ? doc.endMetric : undefined);
  const exps = !node ? doc.nodes.filter((n) => n.type === 'experiment') : node.type === 'experiment' ? [node] : node.type === 'method' ? childrenOf(doc, node.id) : experimentsUnder(doc, node);
  switch (kind) {
    case 'summary':
      return <SummaryNote ctx={ctx} />;
    case 'notes':
      return !aspect ? <SummaryNote ctx={ctx} /> : aspect.combos ? null : (
        <NoteCard title={t('Notes')} of={aspect.title} note={ctx.notes.aspects[aspect.id]} behind={resultsSince(doc, ctx.notes.aspects[aspect.id]?.updatedAt, aspect.id)} empty={t('No notes yet. Its agent writes them when a batch of experiments has its results.')} testId="research-notes" />
      );
    case 'kpis':
      return exps.length ? (
        <>
          <Kpis metric={m} exps={exps} statusOf={ctx.statusOf} />
          <Confidence metric={m} exps={exps} />
        </>
      ) : null;
    case 'children':
      return <ChildrenBlock ctx={ctx} node={node} />;
    case 'table':
      return <LiveTableBlock ctx={ctx} node={node} spec={options as TableSpec} />;
    case 'findings':
      return <Findings ctx={ctx} items={(node ? (node.type === 'experiment' ? [node] : exps) : exps).flatMap((e) => (e.findings ?? []).map((f) => ({ ...f, on: node?.id === e.id ? undefined : e })))} />;
    case 'design':
      return <DesignBlock ctx={ctx} node={node} />;
    case 'result':
      return node?.type === 'experiment' ? <ResultBlock ctx={ctx} node={node} /> : null;
    case 'evidence':
      return <EvidenceBlock ctx={ctx} />;
  }
}

function SummaryNote({ ctx }: { ctx: Ctx }) {
  const { doc } = ctx;
  return (
    <NoteCard
      title={t('Summary')}
      of={doc.title}
      note={ctx.notes.summary}
      behind={resultsSince(doc, ctx.notes.summary?.updatedAt)}
      empty={t('No summary yet. The main agent writes it from the aspects’ notes as results come in; you can also ask it below.')}
      testId="research-summary"
    />
  );
}

/** The nodes under it: aspects (goal), methods (aspect), variants (method). */
function ChildrenBlock({ ctx, node }: { ctx: Ctx; node?: ResearchNode }) {
  const { doc } = ctx;
  if (node?.type === 'experiment') return null;
  if (node?.type === 'method') {
    const exps = childrenOf(doc, node.id);
    return exps.length ? <ResultTable ctx={ctx} aspect={aspectOf(doc, node)!} exps={exps} best={bestExperiment(doc, node)} /> : <div className="muted small">{t('Not tried yet.')}</div>;
  }
  const kids = childrenOf(doc, node?.id ?? null);
  if (!kids.length) return <div className="muted small">{node ? t('No methods yet.') : t('No aspects yet.')}</div>;
  const m = node?.metric;
  const top = Math.max(0.0001, ...kids.map((x) => Math.abs(gain(m, bestExperiment(doc, x)?.value) ?? 0)));
  return (
    <table className="rs-table">
      <thead>
        <tr>
          <th>{node ? levelLabel('method') : levelLabel('aspect')}</th>
          {m ? <th className="num">{t('Best')}</th> : null}
          {m?.baseline != null ? <th className="num">{t('vs start')}</th> : null}
          <th className="num">{node ? levelPlural('experiment') : levelPlural('method')}</th>
        </tr>
      </thead>
      <tbody>
        {kids.map((x) => {
          const st = ctx.statusOf(x);
          const best = node ? bestExperiment(doc, x) : undefined;
          return (
            <tr key={x.id} className="clickable" onClick={() => ctx.select(x.id)}>
              <td>
                <i className={`rg-dot st-${st}`} title={statusName(st)} /> {x.title}
                {x.links?.[0] ? <span className={`pill link-${x.links[0].kind}`}>{t(LINK_LABEL[x.links[0].kind])}</span> : null}
              </td>
              {m ? <td className="num">{best ? formatValue(m, best.value) : '—'}</td> : null}
              {m?.baseline != null ? <HeatCell g={best ? gain(m, best.value) : null} top={top} /> : null}
              <td className="num">{childrenOf(doc, x.id).length}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** How it is validated (aspect), designed and linked (method), or configured (variant). */
function DesignBlock({ ctx, node }: { ctx: Ctx; node?: ResearchNode }) {
  const { doc } = ctx;
  if (!node) return null;
  if (node.type === 'aspect') {
    const m = node.metric;
    return (
      <div className="rs-kv">
        <span>{t('Validated by')}</span>
        <span>
          {m ? `${m.name} · ${m.higherIsBetter ? t('higher is better') : t('lower is better')}${m.baseline != null ? ` · ${t('starts at {v}', { v: formatValue(m, m.baseline) })}` : ''}${m.noise ? ` · ${t('noise ±{v}', { v: formatValue(m, m.noise) })}` : ''}` : t('judged by hand')}
          {node.metrics?.length ? <span className="muted"> · {t('also watched: {list}', { list: node.metrics.map((x) => x.name).join(', ') })}</span> : null}
        </span>
      </div>
    );
  }
  if (node.type === 'experiment') return node.config && node.config !== node.title ? <Clamp text={node.config} /> : null;
  return (
    <>
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
      {node.design ? <Clamp text={node.design} /> : null}
      {node.source && ctx.statusOf(node) === 'idea' ? <div className="muted small">{t('Idea from: {source}', { source: node.source })}</div> : null}
    </>
  );
}

/** A variant's numbers: status, its result against the start, runs, other metrics, results by dataset. */
function ResultBlock({ ctx, node }: { ctx: Ctx; node: ResearchNode }) {
  const { doc } = ctx;
  const aspect = aspectOf(doc, node);
  const m = aspect?.metric;
  const st = ctx.statusOf(node);
  return (
    <div className="rs-kv">
      <span>{t('Status')}</span>
      <span>
        <i className={`rg-dot st-${st}`} /> {statusName(st)}
      </span>
      <span>{t('Result')}</span>
      <span>
        {node.value != null ? <b>{formatValue(m, node.value)}</b> : '—'}
        {node.runs && node.runs.length > 1 ? <span className="muted"> ± {formatValue(m, runStats(node.runs).sd)}</span> : null}
        {gain(m, node.value) != null ? <span className={gain(m, node.value)! >= 0 ? 'gain' : 'loss'}> {pctOf(gain(m, node.value))}</span> : null}
        {m?.baseline != null ? <span className="muted"> · {t('start {v}', { v: formatValue(m, m.baseline) })}</span> : null}
        {m ? <span className="muted rs-metric">{m.name}</span> : null}
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
      {(node.results ?? []).map((r) => (
        <Fragment key={`${r.metric}@${r.dataset ?? ''}`}>
          <span>{r.dataset ? `${r.metric} · ${r.dataset}` : r.metric}</span>
          <span>{formatValue(undefined, r.value)}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** End-to-end runs and ablations, and what they say each aspect contributes. */
function EvidenceBlock({ ctx }: { ctx: Ctx }) {
  const { doc } = ctx;
  if (!doc.evidence.length) return null;
  const rows = contributions(doc);
  const max = Math.max(0.0001, ...rows.map((r) => Math.abs(r.estimate ?? 0)));
  const m = doc.endMetric;
  return (
    <>
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
  );
}

/** A live table of recorded results (shared/research-views.ts liveTable): new methods add rows, new datasets columns. */
function LiveTableBlock({ ctx, node, spec }: { ctx: Ctx; node?: ResearchNode; spec: TableSpec }) {
  const tb = liveTable(ctx.doc, node, spec);
  if (!tb.columns.length) return <div className="muted small">{t('No results recorded for this table yet.')}</div>;
  const metrics = [...new Set(tb.columns.map((c) => c.metric))];
  const grouped = tb.columns.some((c) => c.dataset);
  // One number of decimals per column (as many as its values use, at most 3), so a column reads straight down.
  const places = tb.columns.map((_, j) => Math.min(3, Math.max(0, ...tb.rows.map((r) => (r.cells[j] == null ? 0 : (String(r.cells[j]).split('.')[1] ?? '').length)))));
  return (
    <div className="rs-live" data-testid="research-live-table">
      {tb.title ? <div className="rs-sec">{tb.title}</div> : null}
      <div className="rs-live-scroll">
        <table className="rs-table">
          <thead>
            {grouped ? (
              <tr>
                <th />
                {metrics.map((mt) => (
                  <th key={mt} className="num rs-live-group" colSpan={tb.columns.filter((c) => c.metric === mt).length}>
                    {mt}
                    {tb.columns.find((c) => c.metric === mt)?.lowerIsBetter ? ' ↓' : ''}
                  </th>
                ))}
              </tr>
            ) : null}
            <tr>
              <th>{spec.rows === 'experiments' ? levelLabel('experiment') : spec.rows === 'aspects' ? levelLabel('aspect') : levelLabel('method')}</th>
              {tb.columns.map((c, j) => (
                <th key={j} className="num">
                  {grouped ? (c.dataset ?? t('no dataset')) : `${c.metric}${c.lowerIsBetter ? ' ↓' : ''}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r, i) => (
              <tr key={r.node.id} className="clickable" onClick={() => ctx.select(r.node.id)}>
                <td className="rs-live-name" title={r.node.title}>
                  <i className={`rg-dot st-${ctx.statusOf(r.node)}`} /> {r.node.title}
                </td>
                {r.cells.map((v, j) => (
                  <td key={j} className={`num${tb.best[j] === i ? ' rs-live-best' : ''}`}>
                    {v == null ? '—' : v.toFixed(places[j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * An agent's own HTML, isolated (no access to the app, no network), styled like the panel and as wide
 * as it; it grows to its content.
 */
function HtmlBlock({ html, height }: { html: string; height?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(height ?? 120);
  useEffect(() => {
    if (height) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && typeof e.data?.amwHeight === 'number') setH(Math.min(2000, Math.max(40, e.data.amwHeight)));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [height]);
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:">
<style>
:root{color-scheme:light dark}
body{margin:0;font:13px/1.55 ${v('--font') || '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'};color:${v('--text') || '#1f2328'};background:transparent;overflow:hidden}
table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:5px 6px;border-bottom:1px solid ${v('--border') || '#e5e7eb'}}
th{font-size:11px;font-weight:600;color:${v('--text-3') || '#6b7280'}}
h1,h2,h3{font-size:13px;margin:12px 0 6px} p{margin:6px 0} code{font-family:${v('--mono') || 'ui-monospace, monospace'};font-size:12px}
svg{max-width:100%;height:auto}
</style></head><body>${html}<script>
new ResizeObserver(()=>parent.postMessage({amwHeight:document.documentElement.scrollHeight},'*')).observe(document.body);
</script></body></html>`;
  // Served from amw-preview:// (as HTML previews are): a srcdoc frame would inherit the app's CSP and run no script.
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    void call('research:html', { html: doc }).then((u) => live && setSrc(u)).catch(() => {});
    return () => {
      live = false;
    };
  }, [doc]);
  return <iframe ref={ref} className="rs-html" sandbox="allow-scripts" src={src || 'about:blank'} style={{ height: h }} title="view" data-testid="research-html" />;
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
  // The best is among those that work and have a value on the metric (a check that works has none).
  const scored = passed.filter((e) => e.value != null);
  const best = metric && scored.length ? scored.reduce((b, e) => ((metric.higherIsBetter ? e.value! > b.value! : e.value! < b.value!) ? e : b)) : undefined;
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
 * Variants with their results: the change from the start in a cell tinted by its size (green better,
 * red worse, as autoresearcherUI's table does), repeated runs as mean ± spread, other metrics as columns.
 */
/** A change against the start, tinted by its size (green better, red worse) among the rows'. */
function HeatCell({ g, top }: { g: number | null; top: number }) {
  return (
    <td className="rs-heat num" style={g != null ? { background: `${g >= 0 ? 'rgba(22,163,74,' : 'rgba(192,38,45,'}${0.08 + 0.3 * (Math.abs(g) / top)})` } : undefined}>
      {g != null ? pctOf(g) : '—'}
    </td>
  );
}

/** A method's design or a variant's config: prose, a few lines, the rest on a click. */
function Clamp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280 || text.split('\n').length > 5;
  return (
    <div>
      <div className={`rs-design${long && !open ? ' clamped' : ''}`}>{text}</div>
      {long ? (
        <button className="link small rs-more" onClick={() => setOpen(!open)}>
          {open ? t('Show less') : t('Show more')}
        </button>
      ) : null}
    </div>
  );
}

function ResultTable({ ctx, aspect, exps, best }: { ctx: Ctx; aspect: ResearchNode; exps: ResearchNode[]; best?: ResearchNode }) {
  const m = aspect.metric;
  const others = aspect.metrics ?? [];
  const gains = exps.map((e) => gain(m, e.value)).filter((g): g is number => g != null);
  const top = Math.max(0.0001, ...gains.map(Math.abs));
  const agents = exps.some((e) => ctx.taskOf(e.taskId));
  return (
    <table className="rs-table" data-testid="research-results">
      <thead>
        <tr>
          <th>{UI.labels?.experiment ?? t('Variant')}</th>
          <th className="num">{t('Result')}</th>
          {m?.baseline != null ? <th>{t('vs start')}</th> : null}
          {others.map((o) => (
            <th key={o.name}>{o.name}</th>
          ))}
          {agents ? <th>{t('Agent')}</th> : null}
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
                <i className={`rg-dot st-${st}`} title={statusName(st)} /> {best?.id === e.id && st === 'pass' ? '★ ' : ''}
                {e.title}
                {e.findings?.length ? <span className="rs-find-count">◆ {e.findings.length}</span> : null}
              </td>
              <td className="num">
                {e.value != null ? formatValue(m, e.value) : statusName(st)}
                {spread ? <span className="muted"> ±{formatValue(m, spread.sd)} ({spread.n})</span> : null}
              </td>
              {m?.baseline != null ? <HeatCell g={g} top={top} /> : null}
              {others.map((o) => (
                <td key={o.name}>{e.values?.[o.name] != null ? formatValue(o, e.values[o.name]) : '—'}</td>
              ))}
              {agents ? <td className="muted">{ctx.taskOf(e.taskId)?.alias ?? ''}</td> : null}
            </tr>
          );
        })}
      </tbody>
    </table>
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
  // Where it went: said for a moment, then out of the way of the graph.
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(null), 8000);
    return () => clearTimeout(t);
  }, [sent]);
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
            ? t('e.g. Try two more variants of this in parallel')
            : one?.type === 'experiment'
              ? t('e.g. Run it again to confirm')
              : doc.nodes.length
                ? t('e.g. Add an aspect, or record an end-to-end run')
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

export function NewResearchDialog({ snapshot, projectId: suggested, onClose, onCreated }: { snapshot: WorkspaceSnapshot; projectId: string; onClose: () => void; onCreated: (researchId: string) => void }) {
  const [projectId, setProjectId] = useState(suggested || defaultProject(snapshot));
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [sample, setSample] = useState(false);
  const [dir, setDir] = useState('');
  const [error, setError] = useState('');
  const folder = dir.trim().replace(/^\.\/+|\/+$/g, '');
  const create = () =>
    call('research:create', { projectId, title: title.trim() || (sample ? ' ' : ''), goal: goal.trim(), sample, ...(folder ? { dir: folder } : {}) })
      .then(() => onCreated(researchId(projectId, folder || undefined)))
      .catch((e) => setError(errorText(e)));
  return (
    <Modal title={t('New research')} onClose={onClose}>
      <ProjectChooser snapshot={snapshot} value={projectId} onChange={setProjectId} />
      <div className="field" data-testid="research-new">
        <label>{t('Title')}</label>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('e.g. Pretraining quality')} />
      </div>
      <div className="field">
        <label>{t('Goal')}</label>
        <textarea className="input" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('What should improve, and how it is measured end to end')} />
      </div>
      <div className="field">
        <label>{t('Folder (optional)')}</label>
        <input className="input" value={dir} onChange={(e) => setDir(e.target.value)} placeholder={t('A folder of the project, e.g. the repository it is about')} data-testid="research-new-dir" />
      </div>
      <label className="check">
        <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} /> {t('Fill it with an example to look around (no agents)')}
      </label>
      <div className="muted small">{t('Kept in the project’s repository (or that folder of it), in .research/.')}</div>
      {error ? <div className="error-text">{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button className="btn btn-primary" onClick={create} disabled={!projectId || (!sample && !title.trim())} data-testid="research-create">
          {t('Create')}
        </button>
      </div>
    </Modal>
  );
}
