import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fillSlots, OVERVIEW_SLOTS, overviewCandidates, slotsFor, teams, visibleOrder } from '../shared/agent-order';
import { call, errorText } from './api';
import { AgentCard } from './components/AgentCard';
import { savePreview } from './preview-store';
import { SideSlot } from './side-slot';
import { Icon } from './components/bits';
import { ImportDialog, NewTaskDialog } from './components/Dialogs';
import { readiness, ReadinessBadge, SettingsPage } from './components/Settings';
import { PROVIDER_LABEL } from './components/bits';
import { FocusView } from './components/FocusView';
import { NewResearchDialog, ResearchView } from './components/Research';
import { SubtaskView } from './components/SubtaskView';
import { Onboarding } from './components/Onboarding';
import { Sidebar } from './components/Sidebar';
import { VoiceDock } from './components/VoiceDock';
import { setLanguage, t } from './i18n';
import { useTick, useTranscripts, useWorkspace } from './state';
import { useTeamExpansion } from './teams';

interface Toast {
  id: number;
  text: string;
  taskId?: string;
}

const SIDEBAR_KEY = 'amw.sidebar.width';
const SIDEBAR_WIDTH = 252;
/** Never narrower than its header needs (the name beside the window buttons): `min`, measured once shown. */
const clampSidebar = (w: number, min = 224) => Math.min(460, Math.max(min, Math.round(w)));

/** The sidebar's edge: drag to widen (long labels), double-click for the default width. */
function SidebarResizer({ width, min, onChange }: { width: number; min: number; onChange: (w: number) => void }) {
  const save = (w: number) => {
    onChange(w);
    localStorage.setItem(SIDEBAR_KEY, String(w));
  };
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize the sidebar')}
      title={t('Drag to resize; double-click to reset')}
      data-testid="sidebar-resizer"
      onDoubleClick={() => save(clampSidebar(SIDEBAR_WIDTH, min))}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        let w = width;
        document.body.classList.add('resizing');
        // On the window, so a fast drag that outruns the thin bar keeps going.
        const move = (ev: PointerEvent) => {
          w = clampSidebar(startW + ev.clientX - startX, min);
          onChange(w);
        };
        const up = () => {
          document.body.classList.remove('resizing');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          save(w);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

/**
 * Layouts are the tile counts that fill a whole grid (1, 2×1, 2×2, 3×2, 3×3); any other count leaves
 * a hole. Shown as little grids, so the choice reads as a layout, not a number.
 */
const LAYOUT_COLUMNS: Record<number, number> = { 1: 1, 2: 2, 4: 2, 6: 3, 9: 3 };
const GRID_LABEL: Record<number, string> = { 1: '1×1', 2: '2×1', 4: '2×2', 6: '3×2', 9: '3×3' };

function LayoutGlyph({ slots }: { slots: number }) {
  const cols = LAYOUT_COLUMNS[slots];
  const rows = Math.ceil(slots / cols);
  const gap = 1.5;
  const w = (16 - gap * (cols - 1)) / cols;
  const h = (12 - gap * (rows - 1)) / rows;
  return (
    <svg className="layout-glyph" width="16" height="12" viewBox="0 0 16 12" aria-hidden>
      {Array.from({ length: slots }, (_, i) => (
        <rect key={i} x={(i % cols) * (w + gap)} y={Math.floor(i / cols) * (h + gap)} width={w} height={h} rx="1" />
      ))}
    </svg>
  );
}

/** Narrowest a tile gets before the Overview uses fewer columns. */
const MIN_TILE = 320;
const GALLERY_GAP = 12;

/** How many tiles of at least MIN_TILE fit across `width` (the gallery's content box). */
function fitColumns(width: number): number {
  return Math.max(1, Math.floor((width + GALLERY_GAP) / (MIN_TILE + GALLERY_GAP)));
}

/** An element's content width, kept current as it resizes. */
function useElementWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

/** Gallery columns like a video call: fill the window, keep tiles roughly square-ish. */
function columnsFor(n: number): number {
  if (n <= 1) return 1;
  if (n === 2 || n === 4) return 2;
  if (n <= 6) return 3;
  return 4;
}

export function App() {
  const [sideEl, setSideEl] = useState<HTMLDivElement | null>(null);
  const snapshot = useWorkspace();
  const { transcripts, load } = useTranscripts();
  // Every launch starts in Overview (spec 02).
  const [focusId, setFocusId] = useState<string | null>(null);
  // A task created from a dialog shows up with the next snapshot; focus it then.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);
  // A project's research page, and the project a new research is being started in.
  const [researchOf, setResearchOf] = useState<string | null>(null);
  const [newResearchIn, setNewResearchIn] = useState<string | null>(null);
  // Settings is a page in the main area, like VS Code, not a dialog.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Opened from elsewhere (e.g. an agent's memory chip) at a given section.
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  useEffect(() => {
    const open = (e: Event) => {
      setSettingsSection((e as CustomEvent<{ section?: string }>).detail?.section);
      setSettingsOpen(true);
    };
    // The setup guide, reopened from Settings: it shows where the Overview is.
    const guide = () => {
      setSettingsOpen(false);
      setSettingsSection(undefined);
      setFocusId(null);
    };
    window.addEventListener('amw:open-settings', open);
    window.addEventListener('amw:open-guide', guide);
    return () => {
      window.removeEventListener('amw:open-settings', open);
      window.removeEventListener('amw:open-guide', guide);
    };
  }, []);
  // Overview: a clicked card is who you are talking to (voice/typed default target) without opening it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A sub-agent's read-only view, opened from its row.
  const [subView, setSubView] = useState<{ taskId: string; subtaskId: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Every second while a sub-agent runs (its timer on the card), else every half minute.
  const now = useTick(snapshot?.tasks.some((t) => t.subtasks?.some((x) => x.status === 'running')) ? 1000 : 30_000);

  const { expanded, toggle } = useTeamExpansion();
  // The sidebar's width: the user's own, kept on this machine.
  const [sidebarW, setSidebarW] = useState(() => clampSidebar(Number(localStorage.getItem(SIDEBAR_KEY)) || SIDEBAR_WIDTH));
  // The sidebar's least width: what its header needs to show the app's name whole (beside the window
  // buttons), measured as shown; a narrower saved width widens.
  const [sidebarMin, setSidebarMin] = useState(224);
  useLayoutEffect(() => {
    const top = document.querySelector<HTMLElement>('.sidebar-top');
    const brand = top?.querySelector<HTMLElement>('.brand');
    const bar = top?.closest<HTMLElement>('.sidebar');
    if (!top || !brand || !bar) return;
    const px = (el: HTMLElement, k: 'paddingLeft' | 'paddingRight') => parseFloat(getComputedStyle(el)[k]) || 0;
    // The name itself (a Demo badge after it may be cut short; the name may not).
    const badge = brand.querySelector<HTMLElement>('.demo-badge');
    const name = brand.scrollWidth - (badge ? badge.scrollWidth + (parseFloat(getComputedStyle(brand).columnGap) || 0) : 0);
    const need = Math.ceil(px(top, 'paddingLeft') + name + px(bar, 'paddingLeft') + px(bar, 'paddingRight') + 16);
    if (need !== sidebarMin) setSidebarMin(need);
    if (sidebarW < need) setSidebarW(need);
  });
  // The Overview holds still while the pointer is over it; tiles settle when it leaves.
  const [hovering, setHovering] = useState(false);
  const slotsRef = useRef<string[]>([]);
  // Leaving the Overview (opening an agent, settings) unmounts it under the pointer without a mouseleave:
  // not held still when you come back.
  useEffect(() => {
    setHovering(false);
  }, [focusId, settingsOpen]);
  // The Overview's own width: columns follow it (window size, sidebar width).
  const [galleryEl, setGalleryEl] = useState<HTMLDivElement | null>(null);
  const galleryW = useElementWidth(galleryEl);
  const openAll = snapshot?.attention.filter((a) => a.state === 'open') ?? [];
  // A research's agents live on its page (its one row in the sidebar), not one by one in their project's team.
  const researchIds = new Set(snapshot?.research.flatMap((r) => r.taskIds) ?? []);
  const teamList = snapshot ? teams(snapshot.tasks.filter((t) => !researchIds.has(t.taskId)), snapshot.projects, openAll, now) : [];
  const order = visibleOrder(teamList, expanded);
  // Overview: busy or recently busy agents, by priority, in as many tiles as the layout has.
  const layout = snapshot?.settings.overviewSlots ?? 0;
  const candidates = snapshot ? overviewCandidates(snapshot.tasks, openAll, now) : [];
  const exists = new Set(snapshot?.tasks.map((t) => t.taskId) ?? []);
  // (Held still under the pointer, an agent still leaves at once when it is removed or set aside.)
  const asideIds = new Set(snapshot?.tasks.filter((t) => t.setAside).map((t) => t.taskId) ?? []);
  const shownIds = hovering ? slotsRef.current.filter((id) => exists.has(id) && !asideIds.has(id)) : fillSlots(slotsRef.current, candidates, openAll, slotsFor(layout, candidates.length), selectedId);
  slotsRef.current = shownIds;
  const shown = shownIds.map((id) => snapshot!.tasks.find((t) => t.taskId === id)!).filter(Boolean);
  const offscreen = candidates.filter((t) => !shownIds.includes(t.taskId));

  // The main agent opens in the same Focus view as any agent.
  const focusTask = snapshot?.tasks.find((t) => t.taskId === focusId) ?? (snapshot?.main?.taskId === focusId ? snapshot.main : undefined);
  // Tiles show recent activity: transcripts are kept current for what is on screen (not every agent ever).
  const taskIds = [...shownIds, ...(focusId ? [focusId] : []), ...(snapshot?.main ? [snapshot.main.taskId] : [])].join(',');
  useEffect(() => {
    for (const id of taskIds.split(',').filter(Boolean)) load(id);
  }, [taskIds, load]);
  useEffect(() => {
    if (focusId && snapshot && !focusTask) setFocusId(null);
  }, [focusId, focusTask, snapshot]);
  // A fresh workspace starts the guide; marking it started keeps it up while work is brought in.
  useEffect(() => {
    const o = snapshot?.settings.onboarding;
    if (snapshot && !snapshot.demo && snapshot.tasks.length === 0 && !o?.started && !o?.dismissed)
      void call('settings:update', { onboarding: { ...o, started: true } }).catch(() => {});
  }, [snapshot]);
  // Opening an agent, or picking its tile to talk to, counts as using it (it moves up in its team).
  useEffect(() => {
    const id = focusId ?? selectedId;
    if (id && snapshot?.tasks.some((t) => t.taskId === id)) void call('task:viewed', { taskId: id }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, selectedId]);
  // Finishing while you are looking at it: already seen.
  const focusedUnread = snapshot?.tasks.find((t) => t.taskId === focusId)?.unread;
  useEffect(() => {
    if (focusId && focusedUnread) void call('task:viewed', { taskId: focusId }).catch(() => {});
  }, [focusId, focusedUnread]);
  useEffect(() => {
    if (selectedId && snapshot && !snapshot.tasks.some((x) => x.taskId === selectedId)) setSelectedId(null);
  }, [selectedId, snapshot]);
  useEffect(() => {
    if (pendingFocus && snapshot?.tasks.some((x) => x.taskId === pendingFocus)) {
      setFocusId(pendingFocus);
      setPendingFocus(null);
    }
  }, [pendingFocus, snapshot]);

  const toast = useCallback((text: string, taskId?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, taskId }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
    if (taskId) {
      setFlash(taskId);
      setTimeout(() => setFlash((f) => (f === taskId ? null : f)), 1600);
    }
  }, []);

  // Dock sends are confirmed in the captions; the receiving tile lights up briefly.
  const flashTile = useCallback((taskId?: string) => {
    if (!taskId) return;
    setFlash(taskId);
    setTimeout(() => setFlash((f) => (f === taskId ? null : f)), 1600);
  }, []);

  const orderRef = useRef(order);
  orderRef.current = order;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (e.key === 'Escape' && !typing && !dialog) {
        // Esc steps back one level: settings / focus first, then the Overview selection.
        // From an agent opened on a research page, back to that page.
        if (subView) setSubView(null);
        else if (settingsOpen || focusId) {
          setSettingsOpen(false);
          setFocusId(null);
        } else if (researchOf) setResearchOf(null);
        else setSelectedId(null);
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && /^[0-9]$/.test(e.key) && snapshot) {
        e.preventDefault();
        if (e.key === '0') setFocusId(null);
        // The numbers shown in the sidebar: expanded teams, in order.
        else setFocusId(orderRef.current[Number(e.key) - 1]?.taskId ?? null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, snapshot, settingsOpen, focusId, subView, researchOf]);

  if (!snapshot) return <div className="loading">{t('Loading workspace…')}</div>;
  // First run: the guide takes the Overview's place on a fresh workspace until finished or skipped
  // (it stays while the user brings work in). Not in the demo, which seeds its own agents.
  const ob = snapshot.settings.onboarding ?? {};
  const onboarding = !snapshot.demo && !ob.dismissed && (!!ob.started || snapshot.tasks.length === 0);
  setLanguage(snapshot.settings.language ?? 'en');
  const openItems = snapshot.attention.filter((a) => a.state === 'open');
  const needYou = new Set(openItems.filter((a) => a.kind !== 'completion' && !snapshot.tasks.find((t) => t.taskId === a.taskId)?.setAside).map((a) => a.taskId)).size;
  const working = snapshot.tasks.filter((t) => t.status === 'running' || t.status === 'starting').length;
  // A layout keeps its number of tiles; when the Overview is too narrow for its columns, the same
  // tiles go into fewer columns (3×2 becomes 2×3) rather than squeezing below a readable width.
  const baseCols = layout ? LAYOUT_COLUMNS[layout] : columnsFor(shown.length);
  const cols = galleryW ? Math.min(baseCols, fitColumns(galleryW)) : baseCols;

  const loadDemo = () =>
    call('demo:seed', {})
      .then(() => toast(t('Demo loaded: three mock agents in a throwaway repo.')))
      .catch((e) => setError(errorText(e)));

  return (
    <div className={`app${researchOf && !focusTask && !settingsOpen && !subView ? ' research-open' : ''}`} style={{ ['--sidebar-w' as string]: `${sidebarW}px` }}>
      <SidebarResizer width={sidebarW} min={sidebarMin} onChange={setSidebarW} />
      <Sidebar
        snapshot={snapshot}
        focusId={focusTask ? focusId : null}
        onSelect={(id) => {
          setSettingsOpen(false);
          setSubView(null);
          setResearchOf(null);
          setFocusId(id);
        }}
        onOverview={() => {
          setSettingsOpen(false);
          setSubView(null);
          setResearchOf(null);
          setFocusId(null);
        }}
        researchOpen={!focusTask && !settingsOpen ? researchOf : null}
        onOpenResearch={(id) => {
          setSettingsOpen(false);
          setSubView(null);
          setFocusId(null);
          setResearchOf(id);
        }}
        onNewResearch={setNewResearchIn}
        onOpenSubtask={(taskId, subtaskId) => {
          setSettingsOpen(false);
          setSubView({ taskId, subtaskId });
        }}
        onNewTask={() => setDialog('new')}
        onResume={() => setDialog('import')}
        onSettings={() => setSettingsOpen(true)}
        settingsOpen={settingsOpen}
        teamList={teamList}
        expanded={expanded}
        toggle={toggle}
      />

      <div className="stage">
        <SideSlot.Provider value={sideEl}>
        <div className="stage-main">
        {subView && !settingsOpen && snapshot.tasks.some((x) => x.taskId === subView.taskId) ? (
          <SubtaskView
            task={snapshot.tasks.find((x) => x.taskId === subView.taskId)!}
            subtask={snapshot.tasks.find((x) => x.taskId === subView.taskId)!.subtasks?.find((s) => s.id === subView.subtaskId)}
            now={now}
            onBack={() => {
              setFocusId(subView.taskId);
              setSubView(null);
            }}
          />
        ) : settingsOpen ? (
          <SettingsPage snapshot={snapshot} section={settingsSection} onClose={() => (setSettingsOpen(false), setSettingsSection(undefined))} />
        ) : focusTask ? (
          <FocusView snapshot={snapshot} task={focusTask} transcript={transcripts[focusTask.taskId] ?? []} now={now} onOpen={setFocusId} />
        ) : researchOf && snapshot.research.some((r) => r.id === researchOf) ? (
          <ResearchView snapshot={snapshot} researchId={researchOf} onOpenAgent={setFocusId} />
        ) : onboarding ? (
          <Onboarding snapshot={snapshot} now={now} onSettings={() => setSettingsOpen(true)} />
        ) : (
          <>
            <header className="stage-head drag">
              <h1>{t('Overview')}</h1>
              <div className="stage-summary" data-testid="topbar-summary">
                {t('{n} agents', { n: snapshot.tasks.length })}
                {working ? ` · ${t('{n} working', { n: working })}` : ''} ·{' '}
                {needYou ? <strong className="needs-text">{t('{n} need you', { n: needYou })}</strong> : <span>{t('none waiting on you')}</span>}
              </div>
              <div className="stage-actions">
                <div className="layout-pick" role="radiogroup" aria-label={t('Overview layout')} data-testid="layout-pick">
                  {OVERVIEW_SLOTS.map((n) => (
                    <button
                      key={n}
                      role="radio"
                      aria-checked={layout === n}
                      className={`layout-opt${layout === n ? ' on' : ''}`}
                      title={n ? t('{n} tiles ({grid})', { n, grid: GRID_LABEL[n] }) : t('Every agent that is busy or recently was')}
                      aria-label={n ? t('{n} tiles ({grid})', { n, grid: GRID_LABEL[n] }) : t('Auto')}
                      onClick={() => void call('settings:update', { overviewSlots: n }).catch((e) => setError(errorText(e)))}
                      data-testid={`layout-${n}`}
                    >
                      {n ? <LayoutGlyph slots={n} /> : t('Auto')}
                    </button>
                  ))}
                </div>
                <button className="btn btn-primary" onClick={() => setDialog('new')} data-testid="new-task">
                  <Icon name="plus" /> {t('New agent')}
                </button>
              </div>
            </header>
            {error ? <div className="error-text pad">{error}</div> : null}
            {snapshot.tasks.length === 0 ? (
              <div className="empty">
                <div className="empty-card">
                  <div className="empty-icon" aria-hidden>
                    <Icon name="grid" size={22} />
                  </div>
                  <h2>{t('Your agents meet here')}</h2>
                  <div className="setup-check" data-testid="setup-check">
                    {(['claude', 'codex'] as const).map((p) => {
                      const c = snapshot.capabilities.find((x) => x.provider === p);
                      return (
                        <div key={p} className="setup-row">
                          <span>{PROVIDER_LABEL[p]}</span>
                          <ReadinessBadge state={readiness(c)} method={c?.auth?.method} />
                        </div>
                      );
                    })}
                    <div className="setup-row">
                      <span>{t('Voice')}</span>
                      <ReadinessBadge state={snapshot.voice.sttAvailable ? 'ready' : 'missing'} missing="Not configured" />
                    </div>
                    <button className="link small" onClick={() => setSettingsOpen(true)}>
                      {t('Settings')}
                    </button>
                  </div>
                  <div className="row center">
                    <button className="btn btn-primary" onClick={() => setDialog('new')}>
                      <Icon name="plus" /> {t('New agent')}
                    </button>
                    {snapshot.demo ? (
                      <button className="btn" data-testid="load-demo" onClick={() => void loadDemo()}>
                        {t('Load demo (mock agents)')}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <>
              {shown.length === 0 ? (
                <div className="empty overview-quiet" data-testid="overview-quiet">
                  <p className="muted">{t('Nothing needs you right now.')}</p>
                </div>
              ) : (
              <div
                ref={setGalleryEl}
                className="gallery"
                data-testid="overview"
                data-cols={cols}
                style={{ ['--cols' as string]: cols }}
                onClick={(e) => e.target === e.currentTarget && setSelectedId(null)}
                onMouseEnter={() => setHovering(true)}
                onMouseLeave={() => setHovering(false)}
              >
                {shown.map((t) => (
                  <AgentCard
                    key={t.taskId}
                    task={t}
                    project={snapshot.projects.find((p) => p.projectId === t.projectId)}
                    items={openItems.filter((a) => a.taskId === t.taskId)}
                    activity={(transcripts[t.taskId] ?? []).filter((x) => x.role !== 'system' && x.tool?.name !== 'ToolSearch').slice(-5)}
                    connected={snapshot.connectedTaskIds.includes(t.taskId)}
                    flash={flash === t.taskId}
                    selected={selectedId === t.taskId}
                    onSelect={() => setSelectedId((cur) => (cur === t.taskId ? null : t.taskId))}
                    onOpen={() => setFocusId(t.taskId)}
                    onPreview={(path, line) => {
                      savePreview(t.taskId, { path, line });
                      setFocusId(t.taskId);
                    }}
                    onOpenSubtask={(taskId, subtaskId) => setSubView({ taskId, subtaskId })}
                    now={now}
                  />
                ))}
              </div>
              )}
              {offscreen.length ? (
                <div className="overview-more muted small" data-testid="overview-more">
                  {t('+{n} more on the left', { n: offscreen.length })}
                </div>
              ) : null}
              </>
            )}
          </>
        )}

        <VoiceDock snapshot={snapshot} focusedTaskId={settingsOpen ? null : focusTask ? focusId : selectedId} composeTo={!settingsOpen && !subView && focusTask ? focusTask.taskId : null} onDispatched={flashTile} onView={setFocusId} mainTranscript={snapshot.main ? (transcripts[snapshot.main.taskId] ?? []) : []} onSettings={() => setSettingsOpen(true)} />
        </div>
        </SideSlot.Provider>
        {/* The agent view's preview and memory panels, full height on the right. */}
        <div className="stage-side" ref={setSideEl} data-testid="stage-side" />
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className="toast" data-testid="toast">
            <Icon name="check" /> {x.text}
            {x.taskId && x.taskId !== focusId ? (
              <button className="link" onClick={() => setFocusId(x.taskId!)}>
                {t('View')}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {dialog === 'new' ? <NewTaskDialog snapshot={snapshot} onClose={() => setDialog(null)} onCreated={(id) => { toast(t('Agent created'), id); setPendingFocus(id); }} /> : null}
      {newResearchIn ? (
        <NewResearchDialog
          snapshot={snapshot}
          projectId={newResearchIn}
          onClose={() => setNewResearchIn(null)}
          onCreated={() => {
            setResearchOf(newResearchIn);
            setFocusId(null);
            setSettingsOpen(false);
            setNewResearchIn(null);
          }}
        />
      ) : null}
      {dialog === 'import' ? <ImportDialog snapshot={snapshot} onClose={() => setDialog(null)} onImported={(id) => { toast(t('Session imported'), id); setPendingFocus(id); }} /> : null}
    </div>
  );
}
