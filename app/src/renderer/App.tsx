import { useCallback, useEffect, useState } from 'react';
import { call, errorText } from './api';
import { AgentCard } from './components/AgentCard';
import { PROVIDER_LABEL } from './components/bits';
import { ImportDialog, NewTaskDialog } from './components/Dialogs';
import { FocusView } from './components/FocusView';
import { VoiceDock } from './components/VoiceDock';
import { useTick, useTranscripts, useWorkspace } from './state';

interface Toast {
  id: number;
  text: string;
  taskId?: string;
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
  useEffect(() => {
    if (focusId) load(focusId);
  }, [focusId, load]);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if (e.key === 'Escape' && !typing && !dialog) setFocusId(null);
      if ((e.metaKey || e.ctrlKey) && /^[0-9]$/.test(e.key) && snapshot) {
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => setFocusId(null)}>
          Agent Meeting Workspace
        </div>
        <div className="topbar-summary" data-testid="topbar-summary">
          {snapshot.tasks.length} agents · {needYou ? <strong>{needYou} need you</strong> : 'none waiting on you'}
        </div>
        <div className="topbar-actions">
          {snapshot.capabilities.map((c) => (
            <span key={c.provider} className={`cap${c.available ? '' : ' off'}`} title={c.detail}>
              {c.available ? '●' : '○'} {PROVIDER_LABEL[c.provider]}
            </span>
          ))}
          <span className={`cap${snapshot.voice.sttAvailable ? '' : ' off'}`} title={snapshot.voice.sttModel ? `STT ${snapshot.voice.sttModel}, router ${snapshot.voice.routerModel}` : 'No OpenAI key found'}>
            {snapshot.voice.sttAvailable ? '●' : '○'} Voice
          </span>
          <label className="small check" title="When off, clearly targeted voice commands are sent immediately">
            <input type="checkbox" checked={snapshot.settings.alwaysConfirmVoice} onChange={(e) => void call('settings:update', { alwaysConfirmVoice: e.target.checked })} /> Confirm every voice send
          </label>
          <button className="btn" onClick={() => setDialog('import')} disabled={!snapshot.projects.length}>
            Resume session…
          </button>
          <button className="btn btn-strong" onClick={() => setDialog('new')} data-testid="new-task">
            + New task
          </button>
        </div>
      </header>
      {error ? <div className="error-text pad">{error}</div> : null}

      <main className="main">
        {focusTask ? (
          <FocusView
            snapshot={snapshot}
            task={focusTask}
            transcript={transcripts[focusTask.taskId] ?? []}
            onSelect={setFocusId}
            onBack={() => setFocusId(null)}
            now={now}
          />
        ) : snapshot.tasks.length === 0 ? (
          <div className="empty">
            <h1>Your agents meet here.</h1>
            <p>
              Each coding agent gets a card that reports what it did and what it needs from you. Requests stay on their card until you answer them, however long
              you spend talking to another agent.
            </p>
            <div className="row center">
              <button className="btn btn-strong" onClick={() => setDialog('new')}>
                + New task
              </button>
              <button
                className="btn"
                data-testid="load-demo"
                onClick={() =>
                  call('demo:seed', {})
                    .then(() => toast('Demo loaded: three mock agents in a throwaway repo.'))
                    .catch((e) => setError(errorText(e)))
                }
              >
                Load demo (mock agents)
              </button>
            </div>
          </div>
        ) : (
          <div className="grid" data-testid="overview">
            {snapshot.tasks.map((t) => (
              <AgentCard
                key={t.taskId}
                task={t}
                project={snapshot.projects.find((p) => p.projectId === t.projectId)}
                items={openItems.filter((a) => a.taskId === t.taskId)}
                connected={snapshot.connectedTaskIds.includes(t.taskId)}
                flash={flash === t.taskId}
                onOpen={() => setFocusId(t.taskId)}
                now={now}
              />
            ))}
          </div>
        )}
      </main>

      <VoiceDock snapshot={snapshot} focusedTaskId={focusId} onDispatched={(taskId, text) => toast(text, taskId)} />

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-testid="toast">
            {t.text}
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
