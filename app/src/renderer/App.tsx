import { useCallback, useEffect, useRef, useState } from 'react';
import { fillSlots, OVERVIEW_SLOTS, overviewCandidates, slotsFor, teams, visibleOrder } from '../shared/agent-order';
import { call, errorText } from './api';
import { AgentCard } from './components/AgentCard';
import { Icon } from './components/bits';
import { ImportDialog, NewTaskDialog } from './components/Dialogs';
import { readiness, ReadinessBadge, SettingsPage } from './components/Settings';
import { PROVIDER_LABEL } from './components/bits';
import { FocusView } from './components/FocusView';
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

/** Columns for a chosen layout: 2 and 4 tiles in two columns, 6 and 9 in three. */
const LAYOUT_COLUMNS: Record<number, number> = { 1: 1, 2: 2, 4: 2, 6: 3, 9: 3 };

/** Gallery columns like a video call: fill the window, keep tiles roughly square-ish. */
function columnsFor(n: number): number {
  if (n <= 1) return 1;
  if (n === 2 || n === 4) return 2;
  if (n <= 6) return 3;
  return 4;
}

export function App() {
  const snapshot = useWorkspace();
  const { transcripts, load } = useTranscripts();
  // Every launch starts in Overview (spec 02).
  const [focusId, setFocusId] = useState<string | null>(null);
  // A task created from a dialog shows up with the next snapshot; focus it then.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);
  // Settings is a page in the main area, like VS Code, not a dialog.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Overview: a clicked card is who you are talking to (voice/typed default target) without opening it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState('');
  const now = useTick();

  const { expanded, toggle } = useTeamExpansion();
  // The Overview holds still while the pointer is over it; tiles settle when it leaves.
  const [hovering, setHovering] = useState(false);
  const slotsRef = useRef<string[]>([]);
  const openAll = snapshot?.attention.filter((a) => a.state === 'open') ?? [];
  const teamList = snapshot ? teams(snapshot.tasks, snapshot.projects, openAll, now) : [];
  const order = visibleOrder(teamList, expanded);
  // Overview: busy or recently busy agents, by priority, in as many tiles as the layout has.
  const layout = snapshot?.settings.overviewSlots ?? 0;
  const candidates = snapshot ? overviewCandidates(snapshot.tasks, openAll, now) : [];
  const exists = new Set(snapshot?.tasks.map((t) => t.taskId) ?? []);
  const shownIds = hovering ? slotsRef.current.filter((id) => exists.has(id)) : fillSlots(slotsRef.current, candidates, openAll, slotsFor(layout, candidates.length), selectedId);
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
  // Opening an agent, or picking its tile to talk to, counts as using it (it moves up in its team).
  useEffect(() => {
    const id = focusId ?? selectedId;
    if (id && snapshot?.tasks.some((t) => t.taskId === id)) void call('task:viewed', { taskId: id }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, selectedId]);
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
        if (settingsOpen || focusId) {
          setSettingsOpen(false);
          setFocusId(null);
        } else setSelectedId(null);
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
  }, [dialog, snapshot, settingsOpen, focusId]);

  if (!snapshot) return <div className="loading">{t('Loading workspace…')}</div>;
  setLanguage(snapshot.settings.language ?? 'en');
  const openItems = snapshot.attention.filter((a) => a.state === 'open');
  const needYou = new Set(openItems.filter((a) => a.kind !== 'completion').map((a) => a.taskId)).size;
  const working = snapshot.tasks.filter((t) => t.status === 'running' || t.status === 'starting').length;
  const cols = layout ? LAYOUT_COLUMNS[layout] : columnsFor(shown.length);

  const loadDemo = () =>
    call('demo:seed', {})
      .then(() => toast(t('Demo loaded: three mock agents in a throwaway repo.')))
      .catch((e) => setError(errorText(e)));

  return (
    <div className="app">
      <Sidebar
        snapshot={snapshot}
        focusId={focusTask ? focusId : null}
        onSelect={(id) => {
          setSettingsOpen(false);
          setFocusId(id);
        }}
        onOverview={() => {
          setSettingsOpen(false);
          setFocusId(null);
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
        {settingsOpen ? (
          <SettingsPage snapshot={snapshot} onClose={() => setSettingsOpen(false)} />
        ) : focusTask ? (
          <FocusView snapshot={snapshot} task={focusTask} transcript={transcripts[focusTask.taskId] ?? []} now={now} onOpen={setFocusId} />
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
                      title={n ? t('Up to {n} tiles; the most urgent agents fill them', { n }) : t('Every agent that is busy or recently was')}
                      onClick={() => void call('settings:update', { overviewSlots: n }).catch((e) => setError(errorText(e)))}
                      data-testid={`layout-${n}`}
                    >
                      {n ? n : t('Auto')}
                    </button>
                  ))}
                </div>
                <button className="btn btn-primary" onClick={() => setDialog('new')} data-testid="new-task">
                  <Icon name="plus" /> {t('New task')}
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
                  <p>{t('Each coding agent joins as a tile that reports what it did and what it needs from you. Requests stay on the tile until you answer, however long you talk to another agent.')}</p>
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
                      {t('Settings, language and sign-in help')}
                    </button>
                  </div>
                  <ol className="empty-steps">
                    <li>
                      <strong>{t('Add agents')}</strong> — {t('pick a project folder and Claude Code or Codex; each agent gets its own worktree.')}
                    </li>
                    <li>
                      <strong>{t('Just talk')}</strong> — {t('the mic is on like in a call. Say “Bob, …” and it goes to Bob without changing your view.')}
                    </li>
                    <li>
                      <strong>{t('Answer from the tile')}</strong> — {t('questions and permission requests wait on their tile.')}
                    </li>
                  </ol>
                  <div className="row center">
                    <button className="btn btn-primary" onClick={() => setDialog('new')}>
                      <Icon name="plus" /> {t('New task')}
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
                  <p className="muted">{t('Nothing is running or waiting on you right now. Every agent is in its team on the left.')}</p>
                </div>
              ) : (
              <div
                className="gallery"
                data-testid="overview"
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
                    now={now}
                  />
                ))}
              </div>
              )}
              {offscreen.length ? (
                <div className="overview-more muted small" data-testid="overview-more">
                  {t('{n} more active agents are in their teams on the left', { n: offscreen.length })}
                </div>
              ) : null}
              </>
            )}
          </>
        )}

        <VoiceDock snapshot={snapshot} focusedTaskId={settingsOpen ? null : focusTask ? focusId : selectedId} onDispatched={flashTile} onView={setFocusId} mainTranscript={snapshot.main ? (transcripts[snapshot.main.taskId] ?? []) : []} />
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

      {dialog === 'new' ? <NewTaskDialog snapshot={snapshot} onClose={() => setDialog(null)} onCreated={(id) => toast(t('Task created'), id)} /> : null}
      {dialog === 'import' ? <ImportDialog snapshot={snapshot} onClose={() => setDialog(null)} onImported={(id) => { toast(t('Session imported'), id); setPendingFocus(id); }} /> : null}
    </div>
  );
}
