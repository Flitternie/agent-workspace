import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { AgentProvider, RouteDecision, Task, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { timeAgo, useTick } from '../state';
import { holdMs, joinSpeech, stopIntent } from '../voice/compose';
import { ContinuousListener, isLikelyNoise } from '../voice/listener';
import { Alias, displayName, Icon, Kbd, PROVIDER_LABEL } from './bits';
import { t as tr } from '../i18n';

type MicState = 'off' | 'starting' | 'listening' | 'speaking' | 'denied' | 'unavailable';
type EntryPhase = 'listening' | 'transcribing' | 'routing' | 'review' | 'sending' | 'sent' | 'dismissed' | 'error';
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
  /** While still listening: when the message will be sent unless the speaker goes on, and how long that wait is. */
  holdUntil?: number;
  holdFor?: number;
  /** Stop the agent's current turn and start over with this message (⌘Enter, or a spoken "stop…"). */
  interrupt?: boolean;
}

/** A spoken message still being assembled from speech segments. */
interface Draft {
  id: number;
  at: string;
  /** Transcripts by segment, in the order spoken (null while transcribing). */
  parts: Array<string | null>;
  failed?: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Set once the first segment is in: did it start with "stop / 停 / wait"? */
  stopChecked?: boolean;
  /** The agent halted by that stop word; the rest of the message goes to it. */
  stoppedTaskId?: string;
}

const DEFAULT_PAUSE_MS = 2500;

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
    async (entry: Pick<Entry, 'id' | 'text' | 'interrupt'>, target: Target) => {
      patch(entry.id, { phase: 'sending', error: undefined });
      try {
        const r = await call('route:dispatch', { utterance: entry.text, target, focusedTaskId: focusRef.current, interrupt: entry.interrupt });
        if (!r.ok) throw new Error(r.error ?? tr('Not delivered'));
        const t = r.taskId ? snapRef.current.tasks.find((x) => x.taskId === r.taskId) : undefined;
        const name = t ? displayName(t) : '?';
        // A busy agent gets the message without stopping (steer) unless it was told to stop.
        const outcome =
          target.kind === 'coordinator'
            ? tr('Coordinator answered')
            : target.kind === 'create'
              ? tr('Started a new task') + (t ? ` (${name})` : '')
              : r.delivery === 'steer'
                ? tr('Added to {alias}’s current work · read at the next step', { alias: name })
                : r.delivery === 'interrupt'
                  ? tr('Stopped {alias} and sent', { alias: name })
                  : tr('Sent to {alias}', { alias: name });
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

  // A pause inside a long sentence must not send half of it. Each speech segment
  // is transcribed as soon as it ends, but segments keep joining one message
  // until the speaker has been quiet for the hold time; only then is it routed.
  const draft = useRef<Draft | null>(null);
  const speaking = useRef(false);
  const draftText = (d: Draft) => d.parts.reduce<string>((acc, p) => joinSpeech(acc, p ?? ''), '');

  const commitDraft = useCallback(() => {
    const d = draft.current;
    if (!d) return;
    clearTimeout(d.timer);
    draft.current = null;
    const said = draftText(d);
    if (!said) {
      if (d.failed) patch(d.id, { phase: 'error', error: d.failed, holdUntil: undefined });
      else setEntries((list) => list.filter((x) => x.id !== d.id));
      return;
    }
    const { stop, rest } = stopIntent(said);
    if (stop && d.stoppedTaskId) {
      // Already halted when the stop word was heard; what followed is its new instruction.
      const t = snapRef.current.tasks.find((x) => x.taskId === d.stoppedTaskId);
      if (!rest) {
        patch(d.id, { text: said, phase: 'sent', outcome: tr('Stopped {alias}', { alias: t ? displayName(t) : '?' }), taskId: d.stoppedTaskId, holdUntil: undefined });
        return;
      }
      const entry: Entry = { id: d.id, source: 'voice', text: rest, phase: 'sending', at: d.at };
      patch(d.id, { text: said, holdUntil: undefined });
      queue.current = queue.current.then(() => dispatch(entry, { kind: 'existing', taskId: d.stoppedTaskId! }));
      return;
    }
    // "Stop, …" without a known agent yet: route the rest, and stop whoever gets it.
    const entry: Entry = { id: d.id, source: 'voice', text: stop && rest ? rest : said, phase: 'routing', at: d.at, interrupt: stop || undefined };
    patch(d.id, { text: said, phase: 'routing', holdUntil: undefined });
    // Route in the order things were said.
    queue.current = queue.current.then(() => route(entry));
  }, [dispatch, patch, route]);

  /**
   * A message that starts with "stop / 停 / wait" halts its agent as soon as the
   * first segment is transcribed, without waiting for the pause; the rest of the
   * message keeps assembling and is sent to that agent when the speaker is done.
   */
  const checkStop = useCallback(
    (d: Draft) => {
      if (d.stopChecked || d.parts[0] === null || d.parts[0] === undefined) return;
      d.stopChecked = true;
      const said = draftText(d);
      if (!stopIntent(said).stop) return;
      const all = snapRef.current.tasks;
      const lower = said.toLowerCase();
      const named = all.filter((t) => lower.includes(t.alias.toLowerCase()));
      const running = all.filter((t) => t.status === 'running');
      const target =
        named.length === 1 ? named[0] : all.find((t) => t.taskId === focusRef.current) ?? (running.length === 1 ? running[0] : undefined);
      if (!target) return;
      d.stoppedTaskId = target.taskId;
      if (target.status !== 'running') return; // nothing to halt; the message just goes to it
      void call('task:interrupt', { taskId: target.taskId }).catch(() => {});
      patch(d.id, { outcome: tr('Stopped {alias} — say what to do instead', { alias: displayName(target) }) });
      onDispatched(target.taskId);
    },
    [onDispatched, patch],
  );

  /** Starts (or restarts) the countdown once every segment is transcribed and nobody is talking. */
  const scheduleCommit = useCallback(() => {
    const d = draft.current;
    if (!d) return;
    clearTimeout(d.timer);
    if (speaking.current || d.parts.some((p) => p === null)) {
      patch(d.id, { holdUntil: undefined });
      return;
    }
    const said = draftText(d);
    if (!said && !d.failed) {
      draft.current = null;
      setEntries((list) => list.filter((x) => x.id !== d.id));
      return;
    }
    const head = said.trim().toLowerCase();
    const addressed = snapRef.current.tasks.some((t) => head.startsWith(t.alias.toLowerCase()) || head.startsWith(displayName(t).toLowerCase()));
    const wait = holdMs(said, snapRef.current.settings.voicePauseMs ?? DEFAULT_PAUSE_MS, addressed);
    d.timer = setTimeout(commitDraft, wait);
    patch(d.id, { text: said, phase: 'listening', holdUntil: Date.now() + wait, holdFor: wait });
  }, [commitDraft, patch]);

  const onSpeechStart = useCallback(() => {
    speaking.current = true;
    setMic('speaking');
    // Still talking: hold the message.
    const d = draft.current;
    if (d) {
      clearTimeout(d.timer);
      patch(d.id, { holdUntil: undefined });
    }
  }, [patch]);

  const onUtterance = useCallback(
    (wav: Uint8Array<ArrayBuffer>) => {
      speaking.current = false;
      let d = draft.current;
      if (!d) {
        d = { id: nextId++, at: new Date().toISOString(), parts: [] };
        draft.current = d;
        addEntry({ id: d.id, source: 'voice', text: '', phase: 'listening', at: d.at });
      }
      const current = d;
      const index = current.parts.push(null) - 1;
      call('voice:transcribe', { audio: wav, mimeType: 'audio/wav' })
        .then(({ text: heard }) => {
          current.parts[index] = heard && !isLikelyNoise(heard) ? heard : '';
        })
        .catch((e) => {
          current.parts[index] = '';
          current.failed = errorText(e);
        })
        .finally(() => {
          if (draft.current !== current) return; // already sent or discarded
          patch(current.id, { text: draftText(current) });
          checkStop(current);
          scheduleCommit();
        });
    },
    [checkStop, patch, scheduleCommit],
  );

  const onSilence = useCallback(() => {
    speaking.current = false;
    setMic('listening');
    scheduleCommit();
  }, [scheduleCommit]);

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
          onSpeechStart,
          onUtterance: (wav) => {
            setMic('listening');
            onUtterance(wav);
          },
          onDiscard: onSilence,
        });
      listener.current = l;
      await l.start();
      setMic('listening');
    } catch {
      setMic('denied');
    }
  }, [onSpeechStart, onSilence, onUtterance, stt]);

  const stopMic = useCallback(() => {
    listener.current?.stop();
    speaking.current = false;
    // Muting means "I'm done talking": send what was said once it is transcribed.
    scheduleCommit();
    if (draft.current && !draft.current.parts.some((p) => p === null)) commitDraft();
    setMic('off');
    setLevel(0);
  }, [commitDraft, scheduleCommit]);

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

  const submitTyped = (interrupt = false) => {
    const u = text.trim();
    const active = entries.find((e) => e.id === activeId && e.phase === 'review');
    if (!u) {
      // Enter on an empty bar sends a spoken message now instead of waiting for the pause.
      if (draft.current && !draft.current.parts.some((p) => p === null)) {
        commitDraft();
        return;
      }
      // Otherwise it confirms the suggested target.
      if (active?.decision?.kind === 'existing') void dispatch(active, { kind: 'existing', taskId: active.decision.taskId });
      else if (active?.decision?.kind === 'coordinator') void dispatch(active, { kind: 'coordinator' });
      return;
    }
    const entry: Entry = { id: nextId++, source: 'typed', text: u, phase: 'routing', at: new Date().toISOString(), interrupt: interrupt || undefined };
    addEntry(entry);
    setText('');
    void route(entry);
  };

  const dismiss = (id: number) => {
    if (draft.current?.id === id) {
      clearTimeout(draft.current.timer);
      draft.current = null;
    }
    patch(id, { phase: 'dismissed', outcome: tr('Not sent'), holdUntil: undefined });
    setActiveId((a) => (a === id ? null : a));
  };

  const active = entries.find((e) => e.id === activeId && (e.phase === 'review' || e.phase === 'sending'));
  // Captions fade out like subtitles; unresolved ones stay until handled.
  const recent = entries
    .filter((e) => e.id !== active?.id && (e.phase === 'review' || e.phase === 'listening' || e.phase === 'transcribing' || e.phase === 'routing' || e.phase === 'sending' || now - Date.parse(e.at) < 12_000))
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
      ? tr('Hearing you…')
      : mic === 'listening'
        ? tr('Listening — just say “Alice, …”')
        : mic === 'starting'
          ? tr('Turning on the microphone…')
          : mic === 'denied'
            ? tr('Microphone blocked — allow it in System Settings › Privacy › Microphone')
            : stt
              ? tr('Muted')
              : tr('Voice off — choose a speech model in Settings; typing still works');

  return (
    <div className="dock" data-testid="voice-dock">
      {showLog && snapshot.coordinator.length ? (
        <div className="popover coord-log" data-testid="coordinator-log">
          <div className="popover-head">
            <span>
              <Icon name="spark" /> {tr('Coordinator')}
            </span>
            <button className="icon-btn" aria-label={tr('Hide coordinator')} onClick={() => setShowLog(false)}>
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
              <span className="caption-text">
                {e.phase === 'transcribing' || (e.phase === 'listening' && !e.text) ? <span className="muted">{tr('Transcribing…')}</span> : e.text}
              </span>
              <span className="caption-out">
                {e.phase === 'listening' ? (
                  <>
                    <span className="muted">{e.holdUntil ? tr('Keep talking, or press Enter to send now') : tr('Listening…')}</span>
                    <button className="link" onClick={() => dismiss(e.id)}>
                      {tr('Cancel')}
                    </button>
                  </>
                ) : null}
                {e.phase === 'routing' ? tr('Finding the agent…') : null}
                {e.phase === 'sending' ? tr('Sending…') : null}
                {e.phase === 'sent' ? (
                  <>
                    <Icon name="check" size={12} /> {e.outcome}
                    {e.taskId && e.taskId !== focusedTaskId && focusedTaskId ? (
                      <button className="link" onClick={() => onView(e.taskId!)}>
                        {tr('View')}
                      </button>
                    ) : null}
                  </>
                ) : null}
                {e.phase === 'dismissed' ? tr('Not sent') : null}
                {e.phase === 'error' ? <span className="error-text">{e.error}</span> : null}
                {e.phase === 'review' ? (
                  <button className="link" onClick={() => setActiveId(e.id)}>
                    {tr('Choose target')}
                  </button>
                ) : null}
              </span>
              <span className="caption-time">{timeAgo(e.at, now)}</span>
              {e.phase === 'listening' && e.holdUntil ? (
                // Restarts (key) each time the countdown restarts; empties as the send approaches.
                <span key={e.holdUntil} className="hold-bar" data-testid="hold-bar" style={{ animationDuration: `${e.holdFor}ms` }} aria-hidden />
              ) : null}
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
          aria-label={live ? tr('Mute microphone') : tr('Unmute microphone')}
          title={stt ? `${live ? tr('Mute') : tr('Unmute')} (⌘⇧A)` : tr('Speech-to-text is not configured')}
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
            placeholder={focusedTaskId ? tr('Type to any agent — “this” means {alias}', { alias: taskById(focusedTaskId)?.alias ?? '' }) : tr('Type to any agent — “Charlie, hold the migration”')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // ⌘Enter: stop the agent and start over with this; Enter: add it to what the agent is doing.
                submitTyped(e.metaKey || e.ctrlKey);
              }
              if (e.key === 'Escape') {
                if (draft.current) dismiss(draft.current.id);
                else if (active) dismiss(active.id);
              }
            }}
          />
          <span className="dock-hint">
            <Kbd>↵</Kbd> {tr('route')}
          </span>
        </div>
        <button className={`btn${showLog ? ' btn-pressed' : ''}`} onClick={() => setShowLog(!showLog)} disabled={!snapshot.coordinator.length}>
          <Icon name="spark" /> {tr('Coordinator')}
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
        <button className="icon-btn route-close" aria-label={tr("Don't send")} onClick={onDismiss}>
          <Icon name="x" />
        </button>
      </div>
      {decision.kind === 'existing' && target ? (
        <>
          <div className="route-line">
            <span className="route-arrow">→</span>
            <Alias alias={target.alias} size="sm" />
            <strong>
              {displayName(target)}
            </strong>
            <span className="muted small">
              {tr(`${decision.confidence} confidence`)} · {decision.reason}
              {decision.taskId !== focusedTaskId && focusedTaskId ? ` · ${tr('your view stays where it is')}` : ''}
            </span>
          </div>
          <div className="route-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => onSend({ kind: 'existing', taskId: decision.taskId })} data-testid="route-send">
              {tr('Send to {alias}', { alias: target.alias })}
            </button>
            <span className="muted small">{tr('or')}</span>
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
            <span className="muted small">{tr('Nothing has been sent.')}</span>
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
            <strong>{tr('Coordinator')}</strong>
            <span className="muted small">{decision.reason}</span>
          </div>
          <div className="route-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => onSend({ kind: 'coordinator' })} data-testid="route-send">
              {decision.reason.startsWith('save') ? tr('Save to memory') : tr('Ask coordinator')}
            </button>
            <span className="muted small">{tr('or send to')}</span>
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
            <strong>{tr('New task')}:</strong> <span>{decision.proposedTitle}</span>
          </div>
          <div className="route-actions">
            <select className="input select" value={newProvider} onChange={(e) => setNewProvider(e.target.value as AgentProvider)}>
              {(snapshot.demo ? (['claude', 'codex', 'mock'] as const) : (['claude', 'codex'] as const)).map((p) => (
                <option key={p} value={p} disabled={!snapshot.capabilities.find((c) => c.provider === p)?.available}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
            <select className="input select" value={newProject} onChange={(e) => setNewProject(e.target.value)}>
              <option value="">{tr('Choose project…')}</option>
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
              {tr('Create & send')}
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
