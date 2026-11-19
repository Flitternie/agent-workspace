import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { AgentProvider, RouteDecision, Task, TranscriptItem, WorkspaceSnapshot } from '../../shared/types';
import { Markdown } from './Markdown';
import { groupTranscript, mainActions } from './Content';
import { WaitingOnYou } from './FocusView';
import { call, errorText } from '../api';
import { timeAgo, useTick } from '../state';
import { holdMs, joinSpeech, stopIntent } from '../voice/compose';
import { ContinuousListener, isLikelyNoise } from '../voice/listener';
import { defaultShortcut, matches, PressGesture, recording, released, shortcutLabel, type PressAction } from '../voice/shortcut';
import { AgentName, Alias, displayName, Icon, Kbd, labelOf, PROVIDER_LABEL, systemText } from './bits';
import { t as tr } from '../i18n';

type MicState = 'off' | 'starting' | 'listening' | 'speaking' | 'denied' | 'unavailable';
type EntryPhase = 'listening' | 'transcribing' | 'routing' | 'review' | 'sending' | 'sent' | 'dismissed' | 'error';
type Target = Parameters<typeof call<'route:dispatch'>>[1]['target'];

interface Entry {
  id: number;
  source: 'voice' | 'typed';
  /** Shown in the open agent's own box instead of a caption (said on its page, to it). */
  inBox?: boolean;
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
  /** The mic was closed (muted, or push to talk let go): send as soon as it is transcribed. */
  closed?: boolean;
  /** What the segment still being spoken says so far (shown live; replaced when it ends). */
  partial?: string;
}

const DEFAULT_PAUSE_MS = 2500;

let nextId = 1;

/**
 * Meeting-style control bar. By default the microphone is open from launch (like
 * joining a call) until the user mutes it; with push to talk (Settings › Voice) it
 * opens only while the shortcut is held, or between two presses. Each spoken utterance is transcribed, routed and
 * listed as a live caption; routing uses the focused task as context only and
 * never changes what the user is looking at.
 */
export function VoiceDock({
  snapshot,
  focusedTaskId,
  composeTo,
  onDispatched,
  onView,
  mainTranscript,
  onSettings,
}: {
  snapshot: WorkspaceSnapshot;
  focusedTaskId: string | null;
  /** The agent whose page is open: what is said goes into its own box, not a separate one. */
  composeTo?: string | null;
  onDispatched: (taskId: string | undefined) => void;
  onView: (taskId: string) => void;
  /** The main agent's conversation, for the reply panel above the bar. */
  mainTranscript: TranscriptItem[];
  /** Opens Settings (where a speech model is chosen). */
  onSettings?: () => void;
}) {
  const [mic, setMic] = useState<MicState>('off');
  const now = useTick(2000);
  const [level, setLevel] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [text, setTextState] = useState('');
  const setText = (v: string) => {
    textRef.current = v;
    setTextState(v);
  };
  const [showLog, setShowLog] = useState(false);
  const [showMain, setShowMain] = useState(false);
  const [newProvider, setNewProvider] = useState<AgentProvider>('claude');
  const [newProject, setNewProject] = useState('');
  const listener = useRef<ContinuousListener | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const focusRef = useRef(focusedTaskId);
  focusRef.current = focusedTaskId;
  const composeRef = useRef(composeTo ?? null);
  composeRef.current = composeTo ?? null;
  /** Voice drafts already settled in the agent's box (kept there, sent, or taken over by the user). */
  const kept = useRef(new Set<number>());
  const [voiceSlot, setVoiceSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = composeTo ? document.getElementById('composer-voice') : null;
    if (el !== voiceSlot) setVoiceSlot(el);
  });
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const tasks = snapshot.tasks;
  // The main agent counts as an agent here (names, captions), though it is not one of `tasks`.
  const taskById = (id?: string) => tasks.find((t) => t.taskId === id) ?? (snapshot.main?.taskId === id ? snapshot.main : undefined);
  const stt = snapshot.voice.sttAvailable;
  const mode = snapshot.settings.micMode ?? 'open';
  // The listener keeps the callbacks it was made with, so they read the mode from here.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const shortcut = snapshot.settings.micShortcut ?? defaultShortcut();
  const keys = shortcutLabel(shortcut);
  /** The mic is on or turning on (it can be let go before it is ready). */
  const wantMic = useRef(false);
  /** Push to talk is being held right now (for the label). */
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState('');

  const patch = useCallback((id: number, p: Partial<Entry>) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...p } : e))), []);

  /** What is being said on an agent's page, shown in its own box (the Composer listens). */
  const voiceToBox = (taskId: string, text: string, phase: 'listening' | 'keep' | 'drop') =>
    window.dispatchEvent(new CustomEvent('amw:voice-draft', { detail: { taskId, text, phase } }));
  // On the Overview the bar's own box shows it, after whatever was typed there.
  const textRef = useRef('');
  const dockVoice = useRef<{ base: string } | null>(null);
  const toBox = (text: string, phase: 'listening' | 'keep' | 'drop') => {
    const box = composeRef.current;
    if (box) return voiceToBox(box, text, phase);
    const join = (a: string, b: string) => (a.trim() && b ? `${a.trimEnd()} ${b}` : a || b);
    if (!dockVoice.current) {
      if (phase !== 'listening') return;
      dockVoice.current = { base: textRef.current };
    }
    const base = dockVoice.current.base;
    if (phase === 'listening') return setText(join(base, text));
    dockVoice.current = null;
    setText(phase === 'keep' ? join(base, text) : base);
    if (phase === 'keep') requestAnimationFrame(() => (document.querySelector('[data-testid="dock-input"]') as HTMLTextAreaElement | null)?.focus());
  };

  const dispatch = useCallback(
    async (entry: Pick<Entry, 'id' | 'text' | 'interrupt'> & { source?: Entry['source'] }, target: Target) => {
      patch(entry.id, { phase: 'sending', error: undefined });
      try {
        const r = await call('route:dispatch', { utterance: entry.text, target, focusedTaskId: focusRef.current, interrupt: entry.interrupt, typed: entry.source === 'typed' });
        if (!r.ok) throw new Error(r.error ?? tr('Not delivered'));
        const s = snapRef.current;
        const t = r.taskId ? (s.tasks.find((x) => x.taskId === r.taskId) ?? (s.main?.taskId === r.taskId ? s.main : undefined)) : undefined;
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
        return true;
      } catch (e) {
        patch(entry.id, { phase: 'review', error: errorText(e) });
        return false;
      }
    },
    [onDispatched, patch],
  );

  const route = useCallback(
    async (entry: Entry) => {
      patch(entry.id, { phase: 'routing' });
      // Push to talk (any mode but "always on"): what was said waits in the box, to check and
      // send with Enter. Always on (a meeting): it goes once the pause ends, as before.
      const manual = entry.source === 'voice' && modeRef.current !== 'open';
      if (entry.inBox && !composeRef.current) {
        if (kept.current.has(entry.id)) return;
        if (manual) {
          kept.current.add(entry.id);
          toBox(entry.text, 'keep');
          setEntries((list) => list.filter((x) => x.id !== entry.id));
          return;
        }
        toBox('', 'drop');
        entry.inBox = false;
        patch(entry.id, { inBox: false, phase: 'routing' });
      }
      try {
        // With a main agent, a message that does not go to the selected/open agent goes to
        // the main agent, which decides what to do. Only an agent named outright is sent
        // to directly (instant, no tokens); a sensitive command to it still asks first.
        const main = snapRef.current.main;
        const ctx = focusRef.current;
        if (main && (!ctx || ctx === main.taskId)) {
          if (ctx !== main.taskId) {
            const named = await call('route:decide', { utterance: entry.text, focusedTaskId: null, namedOnly: true });
            if (named.kind === 'existing') {
              patch(entry.id, { decision: named, phase: 'review' });
              const confirm = manual || named.confidence !== 'high' || (entry.source === 'voice' && snapRef.current.settings.alwaysConfirmVoice);
              if (confirm) setActiveId(entry.id);
              else await dispatch(entry, { kind: 'existing', taskId: named.taskId });
              return;
            }
          }
          // On the main agent's own page, what is said goes into its box like any agent's.
          if (entry.inBox && composeRef.current === main.taskId) {
            if (kept.current.has(entry.id)) return;
            kept.current.add(entry.id);
            if (manual || snapRef.current.settings.alwaysConfirmVoice) {
              voiceToBox(main.taskId, entry.text, 'keep');
              setEntries((list) => list.filter((x) => x.id !== entry.id));
              return;
            }
            voiceToBox(main.taskId, '', 'drop');
          } else setShowMain(true);
          await dispatch(entry, { kind: 'existing', taskId: main.taskId });
          return;
        }
        const d = await call('route:decide', { utterance: entry.text, focusedTaskId: focusRef.current });
        // Said on an agent's page, to it: into its box. Sent at once unless voice sends are
        // confirmed or it is a sensitive command; then it waits in the box to be checked.
        const box = composeRef.current;
        if (kept.current.has(entry.id)) return;
        if (entry.inBox && box && d.kind === 'existing' && d.taskId === box) {
          kept.current.add(entry.id);
          if (manual || snapRef.current.settings.alwaysConfirmVoice || d.confidence !== 'high') {
            voiceToBox(box, entry.text, 'keep');
            setEntries((list) => list.filter((x) => x.id !== entry.id));
            return;
          }
          voiceToBox(box, entry.text, 'listening');
          const sent = await dispatch(entry, { kind: 'existing', taskId: box });
          voiceToBox(box, sent ? '' : entry.text, sent ? 'drop' : 'keep');
          return;
        }
        // For someone else (named, a new task, the coordinator): out of the box, into a caption.
        if (entry.inBox) {
          if (box) voiceToBox(box, '', 'drop');
          entry.inBox = false;
          patch(entry.id, { inBox: false });
        }
        patch(entry.id, { decision: d, phase: 'review' });
        if (d.kind === 'create') {
          setNewProvider(d.provider ?? 'claude');
          setNewProject(d.projectId ?? snapRef.current.projects[0]?.projectId ?? '');
        }
        // The agent in view or selected on the Overview is who you are talking to: a message
        // that names nobody else goes to it directly. A sensitive command still asks first.
        const toContext = d.kind === 'existing' && d.context === true && d.taskId === focusRef.current && !/sensitive command/.test(d.reason);
        const auto =
          !manual &&
          (entry.source === 'voice' || toContext) &&
          (!snapRef.current.settings.alwaysConfirmVoice || entry.source === 'typed') &&
          ((d.kind === 'existing' && (d.confidence === 'high' || toContext)) || (d.kind === 'coordinator' && d.reason === 'workspace status question'));
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
  const liveText = (d: Draft) => joinSpeech(draftText(d), d.partial ?? '');

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
      queue.current = queue.current.then(async () => void (await dispatch(entry, { kind: 'existing', taskId: d.stoppedTaskId! })));
      return;
    }
    // "Stop, …" without a known agent yet: route the rest, and stop whoever gets it.
    const entry: Entry = { id: d.id, source: 'voice', text: stop && rest ? rest : said, phase: 'routing', at: d.at, interrupt: stop || undefined, inBox: true };
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
    // Muted, or push to talk let go: that was the whole message.
    if (d.closed) {
      commitDraft();
      return;
    }
    // Push to talk: everything said until the mic closes is one message.
    if (modeRef.current !== 'open' && wantMic.current) {
      patch(d.id, { text: said, phase: 'listening', holdUntil: undefined });
      return;
    }
    const head = said.trim().toLowerCase();
    const addressed = snapRef.current.tasks.some((t) => head.startsWith(t.alias.toLowerCase()) || head.startsWith(labelOf(t).toLowerCase()));
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
        addEntry({ id: d.id, source: 'voice', text: '', phase: 'listening', at: d.at, inBox: true });
      }
      const current = d;
      partialGen.current++;
      current.partial = undefined;
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
          patch(current.id, { text: liveText(current) });
          checkStop(current);
          scheduleCommit();
        });
    },
    [checkStop, patch, scheduleCommit],
  );

  // While talking: the speech so far is transcribed (one at a time, the latest wins) and shown
  // after what is already in. Only with an on-device model: a cloud model would bill every pass.
  const partialGen = useRef(0);
  const partialBusy = useRef(false);
  const partialNext = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const onPartial = useCallback(
    (wav: Uint8Array<ArrayBuffer>) => {
      if (!(snapRef.current.settings.sttModel ?? '').startsWith('local:')) return;
      if (partialBusy.current) {
        partialNext.current = wav;
        return;
      }
      let d = draft.current;
      if (!d) {
        d = { id: nextId++, at: new Date().toISOString(), parts: [] };
        draft.current = d;
        addEntry({ id: d.id, source: 'voice', text: '', phase: 'listening', at: d.at, inBox: true });
      }
      const current = d;
      const gen = partialGen.current;
      partialBusy.current = true;
      call('voice:transcribe', { audio: wav, mimeType: 'audio/wav' })
        .then(({ text: heard }) => {
          // Still the same segment, still this draft: show it.
          if (draft.current !== current || partialGen.current !== gen || !heard || isLikelyNoise(heard)) return;
          current.partial = heard;
          patch(current.id, { text: liveText(current) });
        })
        .catch(() => {})
        .finally(() => {
          partialBusy.current = false;
          const next = partialNext.current;
          partialNext.current = null;
          if (next && partialGen.current === gen) onPartialRef.current?.(next);
        });
    },
    [patch],
  );
  const onPartialRef = useRef(onPartial);
  onPartialRef.current = onPartial;

  const onSilence = useCallback(() => {
    speaking.current = false;
    setMic('listening');
    scheduleCommit();
  }, [scheduleCommit]);

  const startMic = useCallback(async () => {
    if (!stt) return;
    wantMic.current = true;
    setMic('starting');
    try {
      const granted = await call('voice:ensureMic', {});
      if (!wantMic.current) return;
      if (!granted) {
        wantMic.current = false;
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
          onPartial: (wav) => onPartialRef.current(wav),
        });
      listener.current = l;
      await l.start();
      // Let go while the microphone was still opening.
      if (!wantMic.current) {
        l.stop();
        return;
      }
      setMic('listening');
    } catch {
      wantMic.current = false;
      setMic('denied');
    }
  }, [onSpeechStart, onSilence, onUtterance, stt]);

  /** Muting, or letting go of push to talk, means "I'm done talking": what was said is sent once transcribed. */
  const stopMic = useCallback(() => {
    wantMic.current = false;
    // Speech still in progress is kept, not cut off.
    listener.current?.stop(true);
    speaking.current = false;
    setMic('off');
    setLevel(0);
    if (draft.current) {
      draft.current.closed = true;
      scheduleCommit();
    }
  }, [scheduleCommit]);

  const live = mic === 'listening' || mic === 'speaking';
  const toggleMic = useCallback(() => (wantMic.current ? stopMic() : void startMic()), [startMic, stopMic]);

  // Join the "meeting" with the mic open, like a call (not with push to talk).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !snapshot.voice.autoListen || mode !== 'open') return;
    autoStarted.current = true;
    void startMic();
  }, [mode, snapshot.voice.autoListen, startMic]);
  useEffect(() => () => listener.current?.stop(), []);

  // The microphone shortcut: mute / unmute, or push to talk (see voice/shortcut.ts).
  const gesture = useRef(new PressGesture());
  const flash = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const act = (a: PressAction) => {
      if (a === 'start') void startMic();
      else if (a === 'stop') stopMic();
      else if (a === 'cancel') {
        stopMic();
        clearTimeout(flash.current);
        setHint(tr('Hold {keys} while you talk', { keys: shortcutLabel(shortcut) }));
        flash.current = setTimeout(() => setHint(''), 2500);
      }
    };
    const up = () => {
      setHolding(false);
      act(gesture.current.up(mode));
    };
    const onDown = (e: KeyboardEvent) => {
      if (recording.active || !stt || !matches(shortcut, e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const a = gesture.current.down(mode, wantMic.current);
      setHolding(a === 'start' && (mode === 'hold' || mode === 'both'));
      act(a);
    };
    const onUp = (e: KeyboardEvent) => {
      if (!gesture.current.pressed || !released(shortcut, e)) return;
      e.preventDefault();
      up();
    };
    // Keys let go in another app never reach us.
    const onBlur = () => gesture.current.pressed && up();
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [mode, shortcut, startMic, stopMic, stt]);
  useEffect(() => () => gesture.current.reset(), [mode, shortcut]);

  const submitTyped = (interrupt = false) => {
    if (dockVoice.current) takeOver();
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
    // `!command`: runs in the open agent's folder, never routed.
    if (u.startsWith('!')) {
      const target = focusedTaskId ? taskById(focusedTaskId) : undefined;
      if (!target || target.taskId === snapshot.main?.taskId) patch(entry.id, { phase: 'error', error: tr('Open an agent to run a command in its folder.') });
      else
        void call('task:shell', { taskId: target.taskId, command: u.slice(1).trim() })
          .then((r) => patch(entry.id, r.ok ? { phase: 'sent', outcome: tr('Ran in {alias}’s folder', { alias: displayName(target) }), taskId: target.taskId } : { phase: 'error', error: r.error }))
          .catch((e) => patch(entry.id, { phase: 'error', error: errorText(e) }));
      return;
    }
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

  // On an agent's page, what is being said shows in its box as it is transcribed. Once the
  // draft is decided ('keep' / 'drop' above) or gone (nothing heard, cancelled), the box lets go.
  const boxLive = entries.find((e) => e.inBox && (e.phase === 'listening' || e.phase === 'transcribing' || e.phase === 'routing'));
  const boxShown = useRef<{ id: number; text: string } | null>(null);
  useEffect(() => {
    const was = boxShown.current;
    if (boxLive) {
      if (was?.id !== boxLive.id || was.text !== boxLive.text) toBox(boxLive.text, 'listening');
      boxShown.current = { id: boxLive.id, text: boxLive.text };
    } else if (was) {
      boxShown.current = null;
      // Decided already (kept in the box, or sent): nothing to undo. Otherwise it went away: let go.
      const e = entries.find((x) => x.id === was.id);
      if ((!e || e.phase === 'dismissed' || e.phase === 'error') && !kept.current.has(was.id)) toBox('', 'drop');
    }
  });
  // The user took it over in the box (typed into it, or sent it): this draft is not sent again.
  const takeOver = () => {
    const d = draft.current;
    if (d) {
      clearTimeout(d.timer);
      draft.current = null;
      kept.current.add(d.id);
      setEntries((list) => list.filter((x) => x.id !== d.id));
    }
    setEntries((list) => list.filter((x) => !(x.inBox && x.phase === 'routing' && (kept.current.add(x.id), true))));
    dockVoice.current = null;
  };
  useEffect(() => {
    const taken = (ev: Event) => {
      if ((ev as CustomEvent<{ taskId: string }>).detail.taskId !== composeRef.current) return;
      const d = draft.current;
      if (d) {
        clearTimeout(d.timer);
        draft.current = null;
        kept.current.add(d.id);
        setEntries((list) => list.filter((x) => x.id !== d.id));
      }
      // One already being routed is let go too.
      setEntries((list) => list.filter((x) => !(x.inBox && x.phase === 'routing' && (kept.current.add(x.id), true))));
    };
    window.addEventListener('amw:voice-taken', taken);
    return () => window.removeEventListener('amw:voice-taken', taken);
  }, []);
  const active = entries.find((e) => e.id === activeId && (e.phase === 'review' || e.phase === 'sending'));
  // Captions fade out like subtitles; unresolved ones stay until handled.
  const lastOut = [...entries].reverse().find((e) => !e.inBox && (e.phase === 'sent' || e.phase === 'error' || e.phase === 'routing' || e.phase === 'sending'));
  const note =
    lastOut?.phase === 'error'
      ? { kind: 'error', text: lastOut.error ?? tr('Not delivered') }
      : lastOut?.phase === 'sent' && now - Date.parse(lastOut.at) < 6000 && lastOut.outcome
        ? { kind: 'ok', text: lastOut.outcome }
        : lastOut?.phase === 'routing' || lastOut?.phase === 'sending'
          ? { kind: 'busy', text: lastOut.phase === 'routing' ? tr('Finding the agent…') : tr('Sending…') }
          : null;
  const recent = entries
    .filter((e) => !(e.inBox && e.phase !== 'error'))
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
            <Alias alias={t.alias} size="sm" /> <AgentName task={t} />
          </button>
        ))}
    </div>
  );

  const micLabel = hint
    ? hint
    : mic === 'speaking'
      ? tr('Hearing you…')
      : mic === 'listening'
        ? mode === 'open'
          ? tr('Listening')
          : holding
            ? tr('Let go to stop')
            : tr('Press {keys} again to stop', { keys })
        : mic === 'starting'
          ? tr('Turning on the microphone…')
          : mic === 'denied'
            ? tr('Microphone blocked — allow it in System Settings › Privacy › Microphone')
            : !stt
              ? ''
              : mode === 'hold'
                ? tr('Hold {keys} to talk', { keys })
                : mode === 'toggle'
                  ? tr('Press {keys} to talk', { keys })
                  : mode === 'both'
                    ? tr('Press or hold {keys} to talk', { keys })
                    : tr('Muted');
  const micTitle = !stt
    ? tr('Set up voice')
    : mode === 'open'
      ? `${live ? tr('Mute') : tr('Unmute')} (${keys})`
      : `${live ? tr('Stop') : tr('Talk')} (${keys})`;

  // The mic button: in the bar on the Overview; on an agent's page, beside its own box.
  const micButton = (
        <button
          className={`mic mic-${mic}`}
          disabled={!stt && !onSettings}
          onClick={!stt ? onSettings : toggleMic}
          aria-pressed={live}
          aria-label={mode !== 'open' ? (live ? tr('Stop') : tr('Talk')) : live ? tr('Mute microphone') : tr('Unmute microphone')}
          title={micTitle}
          data-testid="mic-button"
          style={{ ['--level' as string]: live ? level.toFixed(2) : '0' }}
        >
          <Icon name="mic" size={18} />
          {!live ? <span className="mic-slash" aria-hidden /> : null}
        </button>
  );
  // On an agent's page there is no bar: the mic and the notes (sent elsewhere, choose a target)
  // move beside and above the agent's box (its slot, #composer-voice).
  if (composeTo) {
    return voiceSlot
      ? createPortal(
          <div className="voice-inline" data-testid="voice-dock">
      {/* The reply panel is for when the main agent's own conversation is not on screen. */}
      {!composeTo && snapshot.main && showMain && focusedTaskId !== snapshot.main.taskId ? (
        <div className="popover main-reply" data-testid="main-reply">
          <div className="popover-head">
            <span>
              <Icon name="spark" /> {tr('Main agent')}
              <span className="muted small"> · {PROVIDER_LABEL[snapshot.main.provider]}</span>
            </span>
            <span className="row">
              <button className="link small" onClick={() => onView(snapshot.main!.taskId)}>
                {tr('Open conversation')}
              </button>
              <button className="icon-btn" aria-label={tr('Hide')} onClick={() => setShowMain(false)}>
                <Icon name="x" />
              </button>
            </span>
          </div>
          {groupTranscript(
            mainTranscript.filter((i) => i.role === 'user' || i.role === 'assistant' || (i.role === 'system' && /( is waiting on you |'s request is settled: )/.test(i.text)) || (i.role === 'tool' && i.tool?.name !== 'ToolSearch')),
            true,
          )
            .slice(-6)
            .map((i) =>
              Array.isArray(i) ? (
                <div key={i[0].id} className="main-step">
                  <Icon name="tool" size={11} /> {mainActions(i)}
                </div>
              ) : (
                <div key={i.id} className={`main-msg ${i.role}`}>
                  {i.role === 'user' ? <span className="muted">{tr('You')}: </span> : null}
                  {i.role === 'system' ? <Icon name="alert" size={11} /> : null}
                  {i.role === 'assistant' ? <Markdown text={i.text} streaming={i.streaming} /> : i.role === 'system' ? systemText(i.text) : i.text}
                </div>
              ),
            )}
          {snapshot.main.status === 'running' || snapshot.main.status === 'starting' ? <div className="muted small">{tr('Working…')}</div> : null}
          <WaitingOnYou snapshot={snapshot} now={now} onOpen={onView} compact limit={2} />
        </div>
      ) : null}
      {!composeTo && !snapshot.main && showLog && snapshot.coordinator.length ? (
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

      {active ? (
        <div className="captions" aria-live="polite">
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

            {micButton}
            {mic === 'denied' || hint ? <div className="voice-inline-note error">{micLabel}</div> : note ? <div className={`voice-inline-note ${note.kind}`} data-testid="voice-note">{note.text}</div> : null}
          </div>,
          voiceSlot,
        )
      : null;
  }
  return (
    <div className="dock" data-testid="voice-dock">
      {/* The reply panel is for when the main agent's own conversation is not on screen. */}
      {!composeTo && snapshot.main && showMain && focusedTaskId !== snapshot.main.taskId ? (
        <div className="popover main-reply" data-testid="main-reply">
          <div className="popover-head">
            <span>
              <Icon name="spark" /> {tr('Main agent')}
              <span className="muted small"> · {PROVIDER_LABEL[snapshot.main.provider]}</span>
            </span>
            <span className="row">
              <button className="link small" onClick={() => onView(snapshot.main!.taskId)}>
                {tr('Open conversation')}
              </button>
              <button className="icon-btn" aria-label={tr('Hide')} onClick={() => setShowMain(false)}>
                <Icon name="x" />
              </button>
            </span>
          </div>
          {groupTranscript(
            mainTranscript.filter((i) => i.role === 'user' || i.role === 'assistant' || (i.role === 'system' && /( is waiting on you |'s request is settled: )/.test(i.text)) || (i.role === 'tool' && i.tool?.name !== 'ToolSearch')),
            true,
          )
            .slice(-6)
            .map((i) =>
              Array.isArray(i) ? (
                <div key={i[0].id} className="main-step">
                  <Icon name="tool" size={11} /> {mainActions(i)}
                </div>
              ) : (
                <div key={i.id} className={`main-msg ${i.role}`}>
                  {i.role === 'user' ? <span className="muted">{tr('You')}: </span> : null}
                  {i.role === 'system' ? <Icon name="alert" size={11} /> : null}
                  {i.role === 'assistant' ? <Markdown text={i.text} streaming={i.streaming} /> : i.role === 'system' ? systemText(i.text) : i.text}
                </div>
              ),
            )}
          {snapshot.main.status === 'running' || snapshot.main.status === 'starting' ? <div className="muted small">{tr('Working…')}</div> : null}
          <WaitingOnYou snapshot={snapshot} now={now} onOpen={onView} compact limit={2} />
        </div>
      ) : null}
      {!composeTo && !snapshot.main && showLog && snapshot.coordinator.length ? (
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

      {active ? (
        <div className="captions" aria-live="polite">
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
        {micButton}
        <div className="mic-state">
          {micLabel ? (
            <div className={`mic-label state-${mic}`} data-testid="mic-label">
              {live ? <span className="live-dot" aria-hidden /> : null}
              <span className="mic-label-text">{micLabel}</span>
            </div>
          ) : null}
          {live ? (
            <div className="meter" aria-hidden>
              {[0.08, 0.18, 0.3, 0.45, 0.62].map((t) => (
                <span key={t} className={level > t ? 'on' : ''} />
              ))}
            </div>
          ) : null}
        </div>
        <div className="dock-input">
          {note ? <span className={`dock-note ${note.kind}`} data-testid="voice-note">{note.text}</span> : null}
          <textarea
            className="input"
            rows={1}
            value={text}
            data-testid="dock-input"
            placeholder={
              focusedTaskId
                ? tr('Talking to {alias} — name another agent to switch', { alias: (() => { const x = taskById(focusedTaskId); return x ? displayName(x) : ''; })() })
                : snapshot.main
                  ? tr('Talk to the main agent — or name an agent: “Charlie, hold the migration”')
                  : tr('Type to any agent — “Charlie, hold the migration”')
            }
            onChange={(e) => {
              if (dockVoice.current) takeOver();
              setText(e.target.value);
            }}
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
        </div>
        {snapshot.main ? (
          <button className={`btn dock-side${showMain ? ' btn-pressed' : ''}`} onClick={() => setShowMain(!showMain)} title={tr('Main agent')} data-testid="main-toggle">
            <Icon name="spark" /> <span className="btn-text">{tr('Main agent')}</span>
          </button>
        ) : (
          <button className={`btn dock-side${showLog ? ' btn-pressed' : ''}`} onClick={() => setShowLog(!showLog)} title={tr('Coordinator')} disabled={!snapshot.coordinator.length}>
            <Icon name="spark" /> <span className="btn-text">{tr('Coordinator')}</span>
          </button>
        )}
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
              <AgentName task={target} />
            </strong>
            <span className="muted small">
              {tr(`${decision.confidence} confidence`)} · {decision.reason}
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
