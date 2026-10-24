import { useCallback, useEffect, useState } from 'react';
import { call, errorText } from './api';
import { AgentCard } from './components/AgentCard';
import { Icon } from './components/bits';
import { ImportDialog, NewTaskDialog } from './components/Dialogs';
import { FocusView } from './components/FocusView';
import { Sidebar } from './components/Sidebar';
import { VoiceDock } from './components/VoiceDock';
import { useTick, useTranscripts, useWorkspace } from './state';

interface Toast {
  id: number;
  text: string;
  taskId?: string;
}

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
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState('');
  const now = useTick();

  const focusTask = snapshot?.tasks.find((t) => t.taskId === focusId);
  const taskIds = snapshot?.tasks.map((t) => t.taskId).join(',') ?? '';
  // Tiles show recent activity, so every task's transcript is kept current.
  useEffect(() => {
    for (const id of taskIds.split(',').filter(Boolean)) load(id);
  }, [taskIds, load]);
  useEffect(() => {
    if (focusId && snapshot && !focusTask) setFocusId(null);
  }, [focusId, focusTask, snapshot]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (e.key === 'Escape' && !typing && !dialog) setFocusId(null);
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && /^[0-9]$/.test(e.key) && snapshot) {
        e.preventDefault();
        if (e.key === '0') setFocusId(null);
        else setFocusId(snapshot.tasks[Number(e.key) - 1]?.taskId ?? null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, snapshot]);

  if (!snapshot) return <div className="loading">Loading workspace…</div>;
  const openItems = snapshot.attention.filter((a) => a.state === 'open');
  const needYou = new Set(openItems.filter((a) => a.kind !== 'completion').map((a) => a.taskId)).size;
  const working = snapshot.tasks.filter((t) => t.status === 'running' || t.status === 'starting').length;
  const cols = columnsFor(snapshot.tasks.length);

  const loadDemo = () =>
    call('demo:seed', {})
      .then(() => toast('Demo loaded: three mock agents in a throwaway repo.'))
      .catch((e) => setError(errorText(e)));

  return (
    <div className="app">
      <Sidebar
        snapshot={snapshot}
        focusId={focusTask ? focusId : null}
        onSelect={setFocusId}
        onOverview={() => setFocusId(null)}
        onNewTask={() => setDialog('new')}
        onResume={() => setDialog('import')}
      />

      <div className="stage">
        {focusTask ? (
          <FocusView snapshot={snapshot} task={focusTask} transcript={transcripts[focusTask.taskId] ?? []} now={now} />
        ) : (
          <>
            <header className="stage-head drag">
              <h1>Overview</h1>
              <div className="stage-summary" data-testid="topbar-summary">
                {snapshot.tasks.length} agents
                {working ? ` · ${working} working` : ''} ·{' '}
                {needYou ? <strong className="needs-text">{needYou} need you</strong> : <span>none waiting on you</span>}
              </div>
              <div className="stage-actions">
                <button className="btn btn-primary" onClick={() => setDialog('new')} data-testid="new-task">
                  <Icon name="plus" /> New task
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
                  <h2>Your agents meet here</h2>
                  <p>Each coding agent joins as a tile that reports what it did and what it needs from you. Requests stay on the tile until you answer, however long you talk to another agent.</p>
                  <ol className="empty-steps">
                    <li>
                      <strong>Add agents</strong> — Claude Code or Codex, each in its own worktree.
                    </li>
                    <li>
                      <strong>Just talk</strong> — the mic is on like in a call. Say “Agent B, …” and it goes to B without changing your view.
                    </li>
                    <li>
                      <strong>Answer from the tile</strong> — questions and permission requests wait on their tile.
                    </li>
                  </ol>
                  <div className="row center">
                    <button className="btn btn-primary" onClick={() => setDialog('new')}>
                      <Icon name="plus" /> New task
                    </button>
                    {snapshot.demo ? (
                      <button className="btn" data-testid="load-demo" onClick={() => void loadDemo()}>
                        Load demo (mock agents)
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <div className="gallery" data-testid="overview" style={{ ['--cols' as string]: cols }}>
                {snapshot.tasks.map((t) => (
                  <AgentCard
                    key={t.taskId}
                    task={t}
                    project={snapshot.projects.find((p) => p.projectId === t.projectId)}
                    items={openItems.filter((a) => a.taskId === t.taskId)}
                    activity={(transcripts[t.taskId] ?? []).filter((x) => x.role !== 'system').slice(-5)}
                    connected={snapshot.connectedTaskIds.includes(t.taskId)}
                    flash={flash === t.taskId}
                    onOpen={() => setFocusId(t.taskId)}
                    now={now}
                  />
                ))}
              </div>
            )}
          </>
        )}

        <VoiceDock snapshot={snapshot} focusedTaskId={focusTask ? focusId : null} onDispatched={flashTile} onView={setFocusId} />
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-testid="toast">
            <Icon name="check" /> {t.text}
            {t.taskId && t.taskId !== focusId ? (
              <button className="link" onClick={() => setFocusId(t.taskId!)}>
                View
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {dialog === 'new' ? <NewTaskDialog snapshot={snapshot} onClose={() => setDialog(null)} onCreated={(id) => toast('Task created', id)} /> : null}
      {dialog === 'import' ? <ImportDialog snapshot={snapshot} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
