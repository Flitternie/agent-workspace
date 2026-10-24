import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { AgentProvider, RouteDecision, Task, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { timeAgo, useTick } from '../state';
import { ContinuousListener, isLikelyNoise } from '../voice/listener';
import { Alias, displayName, Icon, Kbd, PROVIDER_LABEL } from './bits';

type MicState = 'off' | 'starting' | 'listening' | 'speaking' | 'denied' | 'unavailable';
type EntryPhase = 'transcribing' | 'routing' | 'review' | 'sending' | 'sent' | 'dismissed' | 'error';
type Target = Parameters<typeof call<'route:dispatch'>>[1]['target'];

interface Entry {
  id: number;
  source: 'voice' | 'typed';
  text: string;
  phase: EntryPhase;
  decision?: RouteDecision;
  outcome?: string;
  error?: string;
  /** Where it was delivered. */
  taskId?: string;
  at: string;
}

let nextId = 1;

/**
 * Meeting-style control bar. The microphone is open from launch (like joining a
 * call) until the user mutes it. Each spoken utterance is transcribed, routed and
 * listed as a live caption; routing uses the focused task as context only and
 * never changes what the user is looking at.
 */
export function VoiceDock({
  snapshot,
  focusedTaskId,
  onDispatched,
  onView,
}: {
  snapshot: WorkspaceSnapshot;
  focusedTaskId: string | null;
  onDispatched: (taskId: string | undefined) => void;
  onView: (taskId: string) => void;
}) {
  const [mic, setMic] = useState<MicState>('off');
  const now = useTick(2000);
  const [level, setLevel] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [newProvider, setNewProvider] = useState<AgentProvider>('claude');
  const [newProject, setNewProject] = useState('');
  const listener = useRef<ContinuousListener | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const focusRef = useRef(focusedTaskId);
  focusRef.current = focusedTaskId;
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const tasks = snapshot.tasks;
  const taskById = (id?: string) => tasks.find((t) => t.taskId === id);
  const stt = snapshot.voice.sttAvailable;

  const patch = useCallback((id: number, p: Partial<Entry>) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...p } : e))), []);

  const dispatch = useCallback(
    async (entry: Pick<Entry, 'id' | 'text'>, target: Target) => {
      patch(entry.id, { phase: 'sending', error: undefined });
      try {
        const r = await call('route:dispatch', { utterance: entry.text, target, focusedTaskId: focusRef.current });
        if (!r.ok) throw new Error(r.error ?? 'Not delivered');
        const t = r.taskId ? snapRef.current.tasks.find((x) => x.taskId === r.taskId) : undefined;
        const outcome =
          target.kind === 'coordinator'
            ? 'Coordinator answered'
            : target.kind === 'create'
              ? `Started a new task${t ? ` (Agent ${t.alias})` : ''}`
              : `Sent to Agent ${t?.alias ?? '?'}${t && t.name !== t.alias ? ` (${t.name})` : ''}`;
        patch(entry.id, { phase: 'sent', outcome, taskId: target.kind === 'coordinator' ? undefined : r.taskId });
        onDispatched(target.kind === 'coordinator' ? undefined : r.taskId);
        if (target.kind === 'coordinator') setShowLog(true);
        setActiveId((a) => (a === entry.id ? null : a));
      } catch (e) {
        patch(entry.id, { phase: 'review', error: errorText(e) });
      }
    },
    [onDispatched, patch],
  );

  const route = useCallback(
    async (entry: Entry) => {
      patch(entry.id, { phase: 'routing' });
      try {
        const d = await call('route:decide', { utterance: entry.text, focusedTaskId: focusRef.current });
        patch(entry.id, { decision: d, phase: 'review' });
        if (d.kind === 'create') {
          setNewProvider(d.provider ?? 'claude');
          setNewProject(d.projectId ?? snapRef.current.projects[0]?.projectId ?? '');
        }
        const auto =
          entry.source === 'voice' &&
          !snapRef.current.settings.alwaysConfirmVoice &&
          ((d.kind === 'existing' && d.confidence === 'high') || (d.kind === 'coordinator' && d.reason === 'workspace status question'));
        if (auto) await dispatch(entry, d.kind === 'existing' ? { kind: 'existing', taskId: d.taskId } : { kind: 'coordinator' });
        else setActiveId(entry.id);
      } catch (e) {
        patch(entry.id, { phase: 'error', error: errorText(e) });
      }
    },
    [dispatch, patch],
  );

  const addEntry = (e: Entry) => setEntries((list) => [...list.slice(-30), e]);

  const onUtterance = useCallback(
    (wav: Uint8Array<ArrayBuffer>) => {
      const entry: Entry = { id: nextId++, source: 'voice', text: '', phase: 'transcribing', at: new Date().toISOString() };
      addEntry(entry);
      const heard = call('voice:transcribe', { audio: wav, mimeType: 'audio/wav' });
      // Transcribe in parallel, route in the order things were said.
      queue.current = queue.current.then(async () => {
        try {
          const { text: t } = await heard;
          if (!t || isLikelyNoise(t)) {
            setEntries((list) => list.filter((x) => x.id !== entry.id));
            return;
          }
          const withText = { ...entry, text: t };
          patch(entry.id, { text: t });
          await route(withText);
        } catch (e) {
          patch(entry.id, { phase: 'error', error: errorText(e) });
        }
      });
    },
    [patch, route],
  );

  const startMic = useCallback(async () => {
    if (!stt) return;
    setMic('starting');
    try {
      const granted = await call('voice:ensureMic', {});
      if (!granted) {
        setMic('denied');
        return;
      }
      const l =
        listener.current ??
        new ContinuousListener({
          onLevel: setLevel,
          onSpeechStart: () => setMic('speaking'),
          onUtterance: (wav) => {
            setMic('listening');
            onUtterance(wav);
          },
          onDiscard: () => setMic('listening'),
        });
      listener.current = l;
      await l.start();
      setMic('listening');
    } catch {
      setMic('denied');
    }
  }, [onUtterance, stt]);

  const stopMic = useCallback(() => {
    listener.current?.stop();
    setMic('off');
    setLevel(0);
  }, []);

  const live = mic === 'listening' || mic === 'speaking';
  const toggleMic = useCallback(() => (live || mic === 'starting' ? stopMic() : void startMic()), [live, mic, startMic, stopMic]);

  // Join the "meeting" with the mic open, like a call.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !snapshot.voice.autoListen) return;
    autoStarted.current = true;
    void startMic();
  }, [snapshot.voice.autoListen, startMic]);
  useEffect(() => () => listener.current?.stop(), []);

  // ⌘⇧A toggles mute (as in Zoom).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        toggleMic();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMic]);

  const submitTyped = () => {
    const u = text.trim();
    const active = entries.find((e) => e.id === activeId && e.phase === 'review');
    if (!u) {
      // Enter on an empty bar confirms the suggested target.
      if (active?.decision?.kind === 'existing') void dispatch(active, { kind: 'existing', taskId: active.decision.taskId });
      else if (active?.decision?.kind === 'coordinator') void dispatch(active, { kind: 'coordinator' });
      return;
    }
    const entry: Entry = { id: nextId++, source: 'typed', text: u, phase: 'routing', at: new Date().toISOString() };
    addEntry(entry);
    setText('');
    void route(entry);
  };

  const dismiss = (id: number) => {
    patch(id, { phase: 'dismissed', outcome: 'Not sent' });
    setActiveId((a) => (a === id ? null : a));
  };

  const active = entries.find((e) => e.id === activeId && (e.phase === 'review' || e.phase === 'sending'));
  // Captions fade out like subtitles; unresolved ones stay until handled.
  const recent = entries
    .filter((e) => e.id !== active?.id && (e.phase === 'review' || e.phase === 'transcribing' || e.phase === 'routing' || e.phase === 'sending' || now - Date.parse(e.at) < 12_000))
    .slice(-3);
  const busy = active?.phase === 'sending';

  const chips = (entry: Entry, ids: string[]) => (
    <div className="chips">
      {ids
        .map(taskById)
        .filter((t): t is Task => !!t)
        .map((t) => (
          <button key={t.taskId} className="chip" disabled={busy} onClick={() => void dispatch(entry, { kind: 'existing', taskId: t.taskId })} data-testid="route-choice" data-alias={t.alias}>
            <Alias alias={t.alias} size="sm" /> {displayName(t)}
          </button>
        ))}
    </div>
  );

  const micLabel =
    mic === 'speaking'
      ? 'Hearing you…'
      : mic === 'listening'
        ? 'Listening — just say “Agent A, …”'
        : mic === 'starting'
          ? 'Turning on the microphone…'
          : mic === 'denied'
            ? 'Microphone blocked — allow it in System Settings › Privacy › Microphone'
            : stt
              ? 'Muted'
              : 'Voice off — no OpenAI key; typing still works';

  return (
    <div className="dock" data-testid="voice-dock">
      {showLog && snapshot.coordinator.length ? (
        <div className="popover coord-log" data-testid="coordinator-log">
          <div className="popover-head">
            <span>
              <Icon name="spark" /> Coordinator
            </span>
            <button className="icon-btn" aria-label="Hide coordinator" onClick={() => setShowLog(false)}>
              <Icon name="x" />
            </button>
          </div>
          {snapshot.coordinator.slice(-6).map((c) => (
            <div key={c.id} className={`coord-entry ${c.role}`}>
              {c.text}
            </div>
          ))}
        </div>
      ) : null}

      {recent.length || active ? (
        <div className="captions" aria-live="polite">
          {recent.map((e) => (
            <div key={e.id} className={`caption phase-${e.phase}`} data-testid="caption">
              <span className="caption-src">{e.source === 'voice' ? <Icon name="mic" size={12} /> : '›'}</span>
              <span className="caption-text">{e.phase === 'transcribing' ? <span className="muted">Transcribing…</span> : e.text}</span>
              <span className="caption-out">
                {e.phase === 'routing' ? 'Finding the agent…' : null}
                {e.phase === 'sending' ? 'Sending…' : null}
                {e.phase === 'sent' ? (
                  <>
                    <Icon name="check" size={12} /> {e.outcome}
                    {e.taskId && e.taskId !== focusedTaskId && focusedTaskId ? (
                      <button className="link" onClick={() => onView(e.taskId!)}>
                        View
                      </button>
                    ) : null}
                  </>
                ) : null}
                {e.phase === 'dismissed' ? 'Not sent' : null}
                {e.phase === 'error' ? <span className="error-text">{e.error}</span> : null}
                {e.phase === 'review' ? (
                  <button className="link" onClick={() => setActiveId(e.id)}>
                    Choose target
                  </button>
                ) : null}
              </span>
              <span className="caption-time">{timeAgo(e.at, now)}</span>
            </div>
          ))}

          {active?.decision ? (
            <RoutePreview
              entry={active}
              decision={active.decision}
              busy={!!busy}
              focusedTaskId={focusedTaskId}
              taskById={taskById}
              tasks={tasks}
              chips={chips}
              snapshot={snapshot}
              newProvider={newProvider}
              setNewProvider={setNewProvider}
              newProject={newProject}
              setNewProject={setNewProject}
              onSend={(target) => void dispatch(active, target)}
              onDismiss={() => dismiss(active.id)}
            />
          ) : null}
        </div>
      ) : null}

      <div className="dock-bar">
        <button
          className={`mic mic-${mic}`}
          disabled={!stt}
          onClick={toggleMic}
          aria-pressed={live}
          aria-label={live ? 'Mute microphone' : 'Unmute microphone'}
          title={stt ? `${live ? 'Mute' : 'Unmute'} (⌘⇧A)` : 'Speech-to-text is not configured'}
          data-testid="mic-button"
          style={{ ['--level' as string]: live ? level.toFixed(2) : '0' }}
        >
          <Icon name="mic" size={18} />
          {!live ? <span className="mic-slash" aria-hidden /> : null}
        </button>
        <div className="mic-state">
          <div className={`mic-label state-${mic}`}>
            {live ? <span className="live-dot" aria-hidden /> : null}
            {micLabel}
          </div>
          {live ? (
            <div className="meter" aria-hidden>
              {[0.08, 0.18, 0.3, 0.45, 0.62].map((t) => (
                <span key={t} className={level > t ? 'on' : ''} />
              ))}
            </div>
          ) : null}
        </div>
        <div className="dock-input">
          <textarea
            className="input"
            rows={1}
            value={text}
            data-testid="dock-input"
            placeholder={focusedTaskId ? `Type to any agent — “this” means Agent ${taskById(focusedTaskId)?.alias}` : 'Type to any agent — “Agent C, hold the migration”'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitTyped();
              }
              if (e.key === 'Escape' && active) dismiss(active.id);
            }}
          />
          <span className="dock-hint">
            <Kbd>↵</Kbd> route
          </span>
        </div>
        <button className={`btn${showLog ? ' btn-pressed' : ''}`} onClick={() => setShowLog(!showLog)} disabled={!snapshot.coordinator.length}>
          <Icon name="spark" /> Coordinator
        </button>
      </div>
    </div>
  );
}

function RoutePreview({
  entry,
  decision,
  busy,
  focusedTaskId,
  taskById,
  tasks,
  chips,
  snapshot,
  newProvider,
  setNewProvider,
  newProject,
  setNewProject,
  onSend,
  onDismiss,
}: {
  entry: Entry;
  decision: RouteDecision;
  busy: boolean;
  focusedTaskId: string | null;
  taskById: (id?: string) => Task | undefined;
  tasks: Task[];
  chips: (entry: Entry, ids: string[]) => ReactElement;
  snapshot: WorkspaceSnapshot;
  newProvider: AgentProvider;
  setNewProvider: (p: AgentProvider) => void;
  newProject: string;
  setNewProject: (p: string) => void;
  onSend: (target: Target) => void;
  onDismiss: () => void;
}) {
  const target = decision.kind === 'existing' ? taskById(decision.taskId) : undefined;
  return (
    <div className={`route route-${decision.kind}`} data-testid="route-preview" data-route-kind={decision.kind}>
      <div className="route-said">
        <span className="caption-src">{entry.source === 'voice' ? <Icon name="mic" size={12} /> : '›'}</span> “{entry.text}”
        <button className="icon-btn route-close" aria-label="Don't send" onClick={onDismiss}>
          <Icon name="x" />
        </button>
      </div>
      {decision.kind === 'existing' && target ? (
        <>
          <div className="route-line">
            <span className="route-arrow">→</span>
            <Alias alias={target.alias} size="sm" />
            <strong>
              Agent {target.alias}
              {target.name !== target.alias ? ` · ${target.name}` : ''}
            </strong>
            <span className="muted small">
              {decision.confidence} confidence · {decision.reason}
              {decision.taskId !== focusedTaskId && focusedTaskId ? ' · your view stays where it is' : ''}
            </span>
          </div>
          <div className="route-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => onSend({ kind: 'existing', taskId: decision.taskId })} data-testid="route-send">
              Send to {target.alias}
            </button>
            <span className="muted small">or</span>
            {chips(
              entry,
              tasks.filter((t) => t.taskId !== decision.taskId).map((t) => t.taskId),
            )}
          </div>
        </>
      ) : null}
      {decision.kind === 'clarify' ? (
        <>
          <div className="route-line">
            <span className="route-arrow">?</span>
            <strong>{decision.question}</strong>
            <span className="muted small">Nothing has been sent.</span>
          </div>
          {chips(entry, decision.candidateTaskIds.length ? decision.candidateTaskIds : tasks.map((t) => t.taskId))}
        </>
      ) : null}
      {decision.kind === 'coordinator' ? (
        <>
          <div className="route-line">
            <span className="route-arrow">
              <Icon name="spark" />
            </span>
            <strong>Coordinator</strong>
            <span className="muted small">{decision.reason}</span>
          </div>
          <div className="route-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => onSend({ kind: 'coordinator' })} data-testid="route-send">
              {decision.reason.startsWith('save') ? 'Save to memory' : 'Ask coordinator'}
            </button>
            <span className="muted small">or send to</span>
            {chips(
              entry,
              tasks.map((t) => t.taskId),
            )}
          </div>
        </>
      ) : null}
      {decision.kind === 'create' ? (
        <>
          <div className="route-line">
            <span className="route-arrow">+</span>
            <strong>New task:</strong> <span>{decision.proposedTitle}</span>
          </div>
          <div className="route-actions">
            <select className="input select" value={newProvider} onChange={(e) => setNewProvider(e.target.value as AgentProvider)}>
              {(['claude', 'codex', 'mock'] as const).map((p) => (
                <option key={p} value={p} disabled={!snapshot.capabilities.find((c) => c.provider === p)?.available}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
            <select className="input select" value={newProject} onChange={(e) => setNewProject(e.target.value)}>
              <option value="">Choose project…</option>
              {snapshot.projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              disabled={busy || !newProject}
              onClick={() => onSend({ kind: 'create', projectId: newProject, provider: newProvider, title: decision.proposedTitle.slice(0, 200) })}
            >
              Create &amp; send
            </button>
            {chips(
              entry,
              tasks.map((t) => t.taskId),
            )}
          </div>
        </>
      ) : null}
      {entry.error ? <div className="error-text">{entry.error}</div> : null}
    </div>
  );
}
