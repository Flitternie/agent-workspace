import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentProvider, RouteDecision, Task, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { Alias, PROVIDER_LABEL } from './bits';

type Phase = 'idle' | 'recording' | 'transcribing' | 'routing' | 'review' | 'sending';
type Source = 'voice' | 'typed';

/**
 * Global voice / coordinator input. Routing uses the focused task as context only;
 * dispatching never changes what the user is looking at.
 */
export function VoiceDock({
  snapshot,
  focusedTaskId,
  onDispatched,
}: {
  snapshot: WorkspaceSnapshot;
  focusedTaskId: string | null;
  onDispatched: (taskId: string | undefined, message: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [source, setSource] = useState<Source>('typed');
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [routedFor, setRoutedFor] = useState('');
  const [error, setError] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [newProvider, setNewProvider] = useState<AgentProvider>('claude');
  const [newProject, setNewProject] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const tasks = snapshot.tasks;
  const taskById = (id: string) => tasks.find((t) => t.taskId === id);
  const stt = snapshot.voice.sttAvailable;

  const reset = () => {
    setDecision(null);
    setRoutedFor('');
    setPhase('idle');
  };

  const dispatch = useCallback(
    async (utterance: string, target: Parameters<typeof call<'route:dispatch'>>[1]['target']) => {
      setPhase('sending');
      setError('');
      try {
        const r = await call('route:dispatch', { utterance, target, focusedTaskId });
        if (!r.ok) throw new Error(r.error ?? 'Not delivered');
        const t = r.taskId ? taskById(r.taskId) : undefined;
        const message =
          target.kind === 'coordinator'
            ? 'Coordinator answered'
            : target.kind === 'create'
              ? `Started a new task${t ? ` (Agent ${t.alias})` : ''}`
              : `Sent to Agent ${t?.alias ?? '?'}${t && t.name !== t.alias ? ` (${t.name})` : ''}`;
        onDispatched(target.kind === 'coordinator' ? undefined : r.taskId, message);
        if (target.kind === 'coordinator') setShowLog(true);
        setText('');
        reset();
      } catch (e) {
        setError(errorText(e));
        setPhase('review');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusedTaskId, onDispatched, tasks],
  );

  const route = useCallback(
    async (utterance: string, from: Source) => {
      const u = utterance.trim();
      if (!u) return;
      setPhase('routing');
      setError('');
      try {
        const d = await call('route:decide', { utterance: u, focusedTaskId });
        setDecision(d);
        setRoutedFor(u);
        if (d.kind === 'create') {
          setNewProvider(d.provider ?? 'claude');
          setNewProject(d.projectId ?? snapshot.projects[0]?.projectId ?? '');
        }
        const auto =
          from === 'voice' &&
          !snapshot.settings.alwaysConfirmVoice &&
          ((d.kind === 'existing' && d.confidence === 'high') || (d.kind === 'coordinator' && d.reason === 'workspace status question'));
        if (auto) await dispatch(u, d.kind === 'existing' ? { kind: 'existing', taskId: d.taskId } : { kind: 'coordinator' });
        else setPhase('review');
      } catch (e) {
        setError(errorText(e));
        setPhase('idle');
      }
    },
    [dispatch, focusedTaskId, snapshot.projects, snapshot.settings.alwaysConfirmVoice],
  );

  const startRecording = useCallback(async () => {
    if (!stt || phase === 'recording') return;
    setError('');
    try {
      await call('voice:ensureMic', {});
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
        if (blob.size < 2000) {
          setPhase('idle');
          setError('Recording too short.');
          return;
        }
        setPhase('transcribing');
        try {
          const { text: heard } = await call('voice:transcribe', { audio: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type });
          if (!heard) throw new Error('Nothing recognised.');
          setText(heard);
          setSource('voice');
          await route(heard, 'voice');
        } catch (e) {
          setError(errorText(e));
          setPhase('idle');
        }
      };
      recorder.current = rec;
      rec.start();
      setDecision(null);
      setPhase('recording');
    } catch (e) {
      setError(`Microphone unavailable: ${errorText(e)}`);
      setPhase('idle');
    }
  }, [phase, route, stt]);

  const stopRecording = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
  }, []);

  // Push-to-talk: hold Option/Alt + Space anywhere in the app.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.altKey && !e.repeat) {
        e.preventDefault();
        void startRecording();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === 'Alt') stopRecording();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [startRecording, stopRecording]);

  const stale = decision && routedFor !== text.trim();
  const busy = phase === 'transcribing' || phase === 'routing' || phase === 'sending';

  const targetChips = (ids: string[]) => (
    <div className="chips">
      {ids
        .map(taskById)
        .filter((t): t is Task => !!t)
        .map((t) => (
          <button key={t.taskId} className="btn chip" disabled={busy} onClick={() => void dispatch(text.trim(), { kind: 'existing', taskId: t.taskId })} data-testid="route-choice" data-alias={t.alias}>
            <Alias alias={t.alias} size="sm" /> {t.name !== t.alias ? t.name : t.title}
          </button>
        ))}
    </div>
  );

  return (
    <div className="dock" data-testid="voice-dock">
      {showLog && snapshot.coordinator.length ? (
        <div className="coord-log" data-testid="coordinator-log">
          <div className="coord-log-head">
            <span>Coordinator</span>
            <button className="link" onClick={() => setShowLog(false)}>
              Hide
            </button>
          </div>
          {snapshot.coordinator.slice(-6).map((c) => (
            <div key={c.id} className={`coord-entry ${c.role}`}>
              {c.role === 'user' ? '› ' : ''}
              {c.text}
            </div>
          ))}
        </div>
      ) : null}

      {decision && !stale && phase !== 'idle' ? (
        <div className={`route route-${decision.kind}`} data-testid="route-preview" data-route-kind={decision.kind}>
          {decision.kind === 'existing' ? (
            <>
              <div className="route-line">
                <span className="route-arrow">→</span>
                <Alias alias={taskById(decision.taskId)?.alias ?? '?'} size="sm" />
                <strong>
                  Agent {taskById(decision.taskId)?.alias} {taskById(decision.taskId)?.name !== taskById(decision.taskId)?.alias ? `· ${taskById(decision.taskId)?.name}` : ''}
                </strong>
                <span className="muted">
                  {decision.confidence} · {decision.reason}
                  {decision.taskId !== focusedTaskId && focusedTaskId ? ' · your view stays where it is' : ''}
                </span>
              </div>
              <div className="route-actions">
                <button className="btn btn-strong" disabled={busy} onClick={() => void dispatch(text.trim(), { kind: 'existing', taskId: decision.taskId })} data-testid="route-send">
                  Send to {taskById(decision.taskId)?.alias}
                </button>
                <span className="muted small">or pick another:</span>
                {targetChips(tasks.filter((t) => t.taskId !== decision.taskId).map((t) => t.taskId))}
              </div>
            </>
          ) : null}
          {decision.kind === 'clarify' ? (
            <>
              <div className="route-line">
                <span className="route-arrow">?</span>
                <strong>{decision.question}</strong>
                <span className="muted">Nothing has been sent.</span>
              </div>
              {targetChips(decision.candidateTaskIds)}
            </>
          ) : null}
          {decision.kind === 'coordinator' ? (
            <>
              <div className="route-line">
                <span className="route-arrow">→</span>
                <strong>Coordinator</strong>
                <span className="muted">{decision.reason}</span>
              </div>
              <div className="route-actions">
                <button className="btn btn-strong" disabled={busy} onClick={() => void dispatch(text.trim(), { kind: 'coordinator' })} data-testid="route-send">
                  {decision.reason.startsWith('save') ? 'Save to memory' : 'Ask coordinator'}
                </button>
                {targetChips(tasks.map((t) => t.taskId))}
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
                <select className="input" value={newProvider} onChange={(e) => setNewProvider(e.target.value as AgentProvider)}>
                  {(['claude', 'codex', 'mock'] as const).map((p) => (
                    <option key={p} value={p} disabled={!snapshot.capabilities.find((c) => c.provider === p)?.available}>
                      {PROVIDER_LABEL[p]}
                    </option>
                  ))}
                </select>
                <select className="input" value={newProject} onChange={(e) => setNewProject(e.target.value)}>
                  <option value="">Choose project…</option>
                  {snapshot.projects.map((p) => (
                    <option key={p.projectId} value={p.projectId}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-strong"
                  disabled={busy || !newProject}
                  onClick={() => void dispatch(text.trim(), { kind: 'create', projectId: newProject, provider: newProvider, title: decision.proposedTitle.slice(0, 200) })}
                >
                  Create &amp; send
                </button>
                {targetChips(tasks.map((t) => t.taskId))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="dock-row">
        <button
          className={`mic${phase === 'recording' ? ' recording' : ''}`}
          disabled={!stt || busy}
          title={stt ? 'Click to talk (or hold ⌥ Space)' : 'Speech-to-text is not configured; typed input still works'}
          onClick={() => (phase === 'recording' ? stopRecording() : void startRecording())}
          data-testid="mic-button"
        >
          {phase === 'recording' ? '■' : '🎙'}
        </button>
        <div className="dock-input">
          {phase === 'recording' ? <div className="privacy">● Microphone on — release ⌥ Space or click ■ to stop</div> : null}
          <textarea
            className="input"
            rows={1}
            value={text}
            data-testid="dock-input"
            placeholder={
              focusedTaskId
                ? `Speak or type to any agent — "this" means Agent ${taskById(focusedTaskId)?.alias}. Enter to preview the target.`
                : 'Speak or type to any agent ("Agent C, hold the migration") — Enter to preview the target.'
            }
            onChange={(e) => {
              setText(e.target.value);
              setSource('typed');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (decision && !stale && decision.kind === 'existing') void dispatch(text.trim(), { kind: 'existing', taskId: decision.taskId });
                else if (decision && !stale && decision.kind === 'coordinator') void dispatch(text.trim(), { kind: 'coordinator' });
                else void route(text, source === 'voice' && !stale ? 'voice' : 'typed');
              }
              if (e.key === 'Escape') reset();
            }}
          />
        </div>
        <div className="dock-status">
          {phase === 'transcribing' ? 'Transcribing…' : phase === 'routing' ? 'Finding the right agent…' : phase === 'sending' ? 'Sending…' : ''}
          {!stt ? <span className="muted small">Voice off (no STT key)</span> : null}
        </div>
        <button className="btn" onClick={() => setShowLog(!showLog)} disabled={!snapshot.coordinator.length}>
          Coordinator
        </button>
      </div>
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}
