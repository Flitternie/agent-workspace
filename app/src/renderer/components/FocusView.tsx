import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SideSlot } from '../side-slot';
import type { AttentionItem, MemoryRecord, PermissionMode, Task, TranscriptItem, WorkspaceSnapshot, BtwEntry } from '../../shared/types';
import { PERMISSION_MODES } from './Settings';
import { call, errorText } from '../api';
import { AttentionView } from './AttentionView';
import { groupTranscript, PlanChecklist, PreviewContext, ToolCallRow, ToolGroup } from './Content';
import { FilePreviewPanel } from './FilePreview';
import { AgentName, Alias, displayName, Icon, isMainAgent, Kbd, PROVIDER_LABEL, ProviderTag, StatusDot, systemText, warningText } from './bits';
import { Markdown } from './Markdown';
import { ModelPicker } from './ModelPicker';
import { RetryNotice } from './Retry';
import { ConfirmDialog, ForkDialog } from './Dialogs';
import { RemoteControlButton } from './RemoteControl';
import { ChangesPanel } from './Changes';
import { BtwPanel } from './Btw';
import { turnChanges } from '../turn-changes';
import { resolvePosix } from '../../shared/preview';
import { t } from '../i18n';
import { OpenInApp } from './OpenInApp';
import { savedPreview, savePreview, type PreviewState } from '../preview-store';

export function FocusView({ snapshot, task, transcript, now, onOpen }: { snapshot: WorkspaceSnapshot; task: Task; transcript: TranscriptItem[]; now: number; onOpen?: (taskId: string) => void }) {
  // Completion reports duplicate the last transcript message here; only show what needs a decision.
  const open = snapshot.attention.filter((a) => a.taskId === task.taskId && a.state === 'open' && a.kind !== 'completion');
  // A question the agent asked in its own words is its message right above: only the newest
  // shows here, as one line (older ones are earlier in the conversation). Native requests
  // (approvals, structured questions) and errors show in full, each.
  const asked = (a: AttentionItem) => a.kind === 'question' && !a.providerRequestId;
  const lastAsked = open.filter(asked).at(-1);
  const items = open.filter((a) => !asked(a) || a === lastAsked);
  const connected = snapshot.connectedTaskIds.includes(task.taskId);
  const session = snapshot.sessions.find((s) => s.localId === task.sessionLocalId);
  const project = snapshot.projects.find((p) => p.projectId === task.projectId);
  // Closed by default; once opened it stays open for every agent.
  const [showMemory, setShowMemoryState] = useState(() => localStorage.getItem('amw.showMemory') === '1');
  const setShowMemory = (on: boolean) => {
    localStorage.setItem('amw.showMemory', on ? '1' : '0');
    setShowMemoryState(on);
  };
  // The files the agent changed in its latest turn; their list shares the side column (closing a
  // file previewed from it brings the list back). Follow: each file it changes opens as it changes.
  const changes = useMemo(() => turnChanges(transcript), [transcript]);
  // Side questions ("btw"): asked from the reply box, read in the side column (which they open).
  const [showBtw, setShowBtw] = useState(false);
  const [btw, setBtw] = useState<BtwEntry[]>([]);
  const [inject, setInject] = useState({ text: '', n: 0 });
  useEffect(() => {
    let live = true;
    setBtw([]);
    void call('btw:list', { taskId: task.taskId })
      .then((list) => live && setBtw(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [task.taskId]);
  const askBtw = (question: string) => {
    setShowBtw(true);
    setPreview(null);
    if (!question) return;
    const taskId = task.taskId;
    // Shown at once, answered when the agent answers; the main conversation is not touched.
    setBtw((list) => [...list, { id: `pending-${Date.now()}`, question, askedAt: new Date().toISOString() }]);
    void call('btw:ask', { taskId, question })
      .catch(() => undefined)
      .then(() => call('btw:list', { taskId }))
      .then((list) => taskId === task.taskId && setBtw(list))
      .catch(() => {});
  };
  const [showChanges, setShowChangesState] = useState(() => localStorage.getItem('amw.showChanges') === '1');
  const setShowChanges = (on: boolean) => {
    localStorage.setItem('amw.showChanges', on ? '1' : '0');
    setShowChangesState(on);
  };
  const [follow, setFollowState] = useState(() => localStorage.getItem('amw.follow') === '1');
  const setFollow = (on: boolean) => {
    localStorage.setItem('amw.follow', on ? '1' : '0');
    setFollowState(on);
  };
  // A file preview takes the Memory column while open; closing it brings Memory back if it was on.
  // Kept per agent: back on this agent, its file is shown again. `nonce` marks each request, so
  // asking for the file already shown jumps to the line and flashes instead of reloading it.
  const [preview, setPreviewState] = useState<ShownPreview | null>(() => restored(task.taskId));
  const setPreview = (path: string | null, opts: { line?: number; diff?: boolean } = {}) =>
    setPreviewState((cur) => {
      if (!path) {
        savePreview(task.taskId, null);
        return null;
      }
      savePreview(task.taskId, { path, ...(opts.line ? { line: opts.line } : {}), ...(opts.diff ? { diff: true } : {}) });
      return { path, line: opts.line, diff: opts.diff, nonce: (cur?.nonce ?? 0) + 1, again: cur?.path === path };
    });
  // The side panels go in the stage's full-height right column; the stage's width is the room the
  // conversation and the preview share, and decides the preview's width and whether it covers.
  const side = useContext(SideSlot);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyW, setBodyW] = useState(0);
  useEffect(() => {
    const el = side?.parentElement ?? bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBodyW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [side]);
  // The preview column's width: dragged by the user, kept for next time.
  const [previewWidth, setPreviewWidthState] = useState(() => Number(localStorage.getItem('amw.previewWidth')) || PREVIEW_WIDTH);
  // Maximized: the preview takes the whole conversation area until restored (Esc) or closed.
  const [previewMax, setPreviewMax] = useState(false);
  useEffect(() => {
    if (!preview) setPreviewMax(false);
  }, [preview]);
  useEffect(() => {
    if (!previewMax) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPreviewMax(false);
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [previewMax]);
  const setPreviewWidth = (w: number) => {
    setPreviewWidthState(w);
    localStorage.setItem('amw.previewWidth', String(Math.round(w)));
  };
  useEffect(() => setPreviewState(restored(task.taskId)), [task.taskId]);
  // Too narrow for both (the conversation keeps 400px, the preview 300px): the preview covers it.
  const narrow = bodyW > 0 && bodyW < PREVIEW_MIN + CONVERSATION_MIN;
  const covering = !!preview && (previewMax || narrow);
  const shownWidth = Math.min(Math.max(previewWidth, PREVIEW_MIN), previewMaxWidth(bodyW));
  const [forking, setForking] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Claude Code conversations on this Mac (and the demo's mock agents) can be forked once saved.
  const canFork = !isMainAgent(task) && !task.host && (task.provider === 'claude' || task.provider === 'mock') && !!session?.nativeSessionId;
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e) => setError(errorText(e)));
  };
  // "Open in default app" only for files on this Mac.
  const openExternal = task.host ? undefined : (path: string) => run(() => call('file:open', { taskId: task.taskId, path }));

  // Follow: a change the agent makes after this view opened shows in the preview, as its diff.
  const seenChange = useRef<string | null>(null);
  const latest = changes.which === 'current' ? changes.files.at(-1) : undefined;
  useEffect(() => {
    seenChange.current = null;
  }, [task.taskId]);
  useEffect(() => {
    const id = latest?.lastItemId ?? '';
    if (seenChange.current === null) {
      seenChange.current = id;
      return;
    }
    if (!follow || !latest || id === seenChange.current) return;
    seenChange.current = id;
    setPreview(latest.path, { line: latest.line, diff: true });
  }, [latest?.lastItemId, follow]);
  const previewDiffs = preview ? changes.files.find((f) => f.path === preview.path || resolvePosix(task.cwd, f.path) === resolvePosix(task.cwd, preview.path))?.diffs : undefined;
  const previewPanel = preview ? (
    <FilePreviewPanel
                task={task}
                path={preview.path}
                line={preview.line}
                nonce={preview.nonce}
                again={preview.again}
                transcript={transcript}
                width={shownWidth}
                maximized={covering}
                onToggleMax={narrow ? undefined : () => setPreviewMax(!previewMax)}
                onClose={() => setPreview(null)}
                onOpenExternal={openExternal && (() => openExternal(preview.path))}
                diffs={previewDiffs}
                showDiff={!!preview.diff && !!previewDiffs?.length}
                onToggleDiff={(on) => {
                  savePreview(task.taskId, { path: preview.path, ...(preview.line ? { line: preview.line } : {}), ...(on ? { diff: true } : {}) });
                  setPreviewState((cur) => (cur ? { ...cur, diff: on } : cur));
                }}
              />
  ) : null;
  return (
    <div className="focus">
      <section className="focus-main">
        <header className="focus-head drag">
          {isMainAgent(task) ? (
            <span className="alias alias-lg main-mark" aria-hidden>
              <Icon name="spark" size={18} />
            </span>
          ) : (
            <Alias alias={task.alias} size="lg" />
          )}
          <div className="focus-ident">
            <div className="focus-name">
              <TaskName task={task} /> <ProviderTag provider={task.provider} /> <ModelPicker task={task} /> <StatusDot status={task.status} connected={connected} />
            </div>
            <div className="focus-meta mono">
              <span className="truncate" title={task.title}>
                {task.title}
              </span>
              <span title={task.host ? `${task.host}:${task.cwd}` : task.cwd}>
                <Icon name="folder" size={12} /> {task.host ? `${task.host}:` : ''}
                {project?.name}
              </span>
              {task.worktree ? (
                <span title={task.worktree.path}>
                  <Icon name="branch" size={12} /> {task.worktree.branch}
                </span>
              ) : null}
              {session?.nativeSessionId ? (
                <span title={session.nativeSessionId}>
                  {session.integrationMode} · {session.nativeSessionId.slice(0, 8)}
                </span>
              ) : null}
              {task.forkedFrom ? (
                <span>
                  <Icon name="branch" size={12} /> {t('forked from {name}', { name: task.forkedFrom.alias })}
                </span>
              ) : null}
              {task.injectedMemoryIds?.length ? <span>{t('{n} memory note(s) loaded', { n: task.injectedMemoryIds.length })}</span> : null}
            </div>
          </div>
          <div className="focus-actions">
            {/* Permissions: a menu with its mode's name; in a narrow agent column the same menu behind a shield icon. */}
            {isMainAgent(task) ? null : (
              <span className="perm" data-tip={t('Permissions')}>
                <span className="perm-icon btn btn-icon" aria-hidden>
                  <Icon name="shield" />
                </span>
                <select
                  className="input select perm-select"
                  value={task.permissionMode ?? snapshot.settings.permissionMode ?? 'auto'}
                  aria-label={t('Permissions')}
                  data-testid="task-permission"
                  onChange={(e) => run(() => call('task:setPermissionMode', { taskId: task.taskId, mode: e.target.value as PermissionMode }))}
                >
                  {PERMISSION_MODES.map((m) => (
                    <option key={m.id} value={m.id} title={t(m.detail)}>
                      {t(m.label)}
                    </option>
                  ))}
                </select>
              </span>
            )}
            {task.status === 'running' && connected ? (
              <button className="btn btn-icon" data-tip={t('Interrupt')} aria-label={t('Interrupt')} onClick={() => run(() => call('task:interrupt', { taskId: task.taskId }))}>
                <Icon name="pause" />
              </button>
            ) : null}
            {!connected ? (
              <button
                className="btn btn-icon"
                onClick={() => run(() => call('task:resume', { taskId: task.taskId }))}
                aria-label={session?.nativeSessionId ? t('Resume session') : t('Start session')}
                data-tip={session?.nativeSessionId ? t('Resume') : t('Start')}
              >
                <Icon name="play" />
              </button>
            ) : (
              <button className="btn btn-icon" data-tip={t('Stop')} aria-label={t('Stop')} onClick={() => run(() => call('task:stop', { taskId: task.taskId }))}>
                <Icon name="power" />
              </button>
            )}
            {/* The agent's folder (its worktree) in the user's own editor, Git app, terminal or Finder. */}
            {!task.host ? <OpenInApp taskId={task.taskId} iconOnly /> : null}
            {/* Claude Code's Remote Control: this agent in the Claude app on a phone, still running here. */}
            {(task.provider === 'claude' || task.provider === 'mock') && !task.host && !isMainAgent(task) ? <RemoteControlButton task={task} url={snapshot.remoteControl?.[task.taskId]} /> : null}
            {canFork ? (
              <button
                className="btn btn-icon"
                aria-label={t('Fork')}
                data-testid="fork-task"
                disabled={task.status === 'running' || task.status === 'starting'}
                onClick={() => setForking(true)}
                data-tip={task.status === 'running' || task.status === 'starting' ? t('Fork after this turn') : t('Fork')}
              >
                <Icon name="branch" />
              </button>
            ) : null}
            {/* The files changed in the latest turn (a count while there are some). */}
            <button
              className={`btn btn-icon btn-badged${showChanges && !preview && !showBtw ? ' btn-pressed' : ''}`}
              data-tip={t('Changes')}
              aria-label={t('Changed this turn')}
              aria-pressed={showChanges && !preview && !showBtw}
              data-testid="show-changes"
              onClick={() => {
                const on = preview || showBtw ? true : !showChanges;
                setShowChanges(on);
                setShowBtw(false);
                if (on) setShowMemory(false);
                setPreview(null);
              }}
            >
              <Icon name="diff" />
              {changes.which === 'current' && changes.files.length ? <span className="badge" data-testid="changes-count">{changes.files.length}</span> : null}
            </button>
            <button
              className={`btn btn-icon${showMemory && !preview && !showChanges && !showBtw ? ' btn-pressed' : ''}`}
              data-tip={t('Memory')}
              aria-label={t('Memory')}
              onClick={() => {
                const on = preview || showChanges || showBtw ? true : !showMemory;
                setShowMemory(on);
                setShowBtw(false);
                if (on) setShowChanges(false);
                setPreview(null);
              }}
              aria-pressed={showMemory && !preview && !showChanges && !showBtw}
            >
              <Icon name="note" />
            </button>
            {/* Set aside: out of the Overview, folded into its team's idle row, until it works, asks or is messaged. */}
            {isMainAgent(task) ? null : (
              <button
                className={`btn btn-icon${task.setAside ? ' btn-pressed' : ''}`}
                aria-pressed={!!task.setAside}
                aria-label={task.setAside ? t('Set aside (click to bring back)') : t('Set aside')}
                data-tip={task.setAside ? t('Bring back') : t('Set aside')}
                data-testid="set-aside"
                onClick={() => run(() => call('task:setAside', { taskId: task.taskId, on: !task.setAside }))}
              >
                <Icon name="moon" />
              </button>
            )}
            {isMainAgent(task) ? null : (
            <button
              className="btn btn-icon"
              data-testid="remove-task"
              aria-label={t('Remove')}
              data-tip={t('Remove')}
              onClick={() => {
                setRemoving(true);
              }}
            >
              <Icon name="trash" />
            </button>
            )}
          </div>
        </header>
        {task.sharedCwdWarning ? (
          <div className="warn-text pad">
            <Icon name="alert" size={12} /> {warningText(task.sharedCwdWarning)}
          </div>
        ) : null}
        {error ? <div className="error-text pad">{error}</div> : null}
        {removing ? (
          <ConfirmDialog
            title={t('Remove {name}?', { name: displayName(task) })}
            message={t('Stop the agent and remove it from the workspace. A worktree with uncommitted changes is kept on disk.')}
            confirmLabel={t('Remove')}
            danger
            onConfirm={() => run(() => call('task:remove', { taskId: task.taskId }))}
            onClose={() => setRemoving(false)}
          />
        ) : null}
        {forking ? <ForkDialog snapshot={snapshot} task={task} onClose={() => setForking(false)} onForked={(id) => onOpen?.(id)} /> : null}

        <div className="focus-body" ref={bodyRef}>
          {/* Kept mounted while the preview is maximized, so the conversation keeps its place. */}
          <div className="focus-thread" hidden={covering}>
            {isMainAgent(task) ? <WaitingOnYou snapshot={snapshot} now={now} onOpen={onOpen} /> : null}
            <PreviewContext.Provider value={{ preview: setPreview, openExternal }}>
              <Transcript items={transcript} main={isMainAgent(task)} />
            </PreviewContext.Provider>
            {/* Requests wait at the end of the conversation, where the agent asked, above the reply box. */}
            {items.length || task.retry ? (
              <div className="focus-attention" data-testid="focus-attention">
                {task.retry ? <RetryNotice retry={task.retry} /> : null}
                {items.map((i) => (
                  <AttentionView key={i.id} item={i} task={task} now={now} compact shown={asked(i)} />
                ))}
              </div>
            ) : null}
            {task.plan ? (
              <div className="pinned-plan">
                <PlanChecklist plan={task.plan} />
              </div>
            ) : null}
            <Composer task={task} onBtw={isMainAgent(task) ? undefined : askBtw} btwCount={btw.length} inject={inject} />
          </div>
          {/* Maximized or too narrow, the preview takes the conversation's place under the header;
              beside it, it is a full-height column on the right (the side slot). */}
          {preview && covering ? previewPanel : null}
        </div>
      </section>
      {(() => {
        const panel = preview && !covering ? (
          <>
            <PanelResizer width={shownWidth} room={bodyW} onChange={setPreviewWidth} />
            {previewPanel}
          </>
        ) : !preview && showBtw && btw.length ? (
          <BtwPanel
            task={task}
            entries={btw}
            onClose={() => setShowBtw(false)}
            onClear={() => {
              setBtw([]);
              setShowBtw(false);
              void call('btw:clear', { taskId: task.taskId }).catch(() => {});
            }}
            onBring={(text) => setInject((cur) => ({ text, n: cur.n + 1 }))}
          />
        ) : !preview && showChanges ? (
          <ChangesPanel task={task} changes={changes} follow={follow} onFollow={setFollow} onOpen={(path, line) => setPreview(path, { line, diff: true })} />
        ) : !preview && showMemory ? (
          <MemoryPanel snapshot={snapshot} task={task} />
        ) : null;
        if (!panel) return null;
        return side ? createPortal(panel, side) : panel;
      })()}
    </div>
  );
}

const PREVIEW_WIDTH = 460;
/** The preview never narrower than this; the conversation keeps at least CONVERSATION_MIN. */
const PREVIEW_MIN = 300;
const CONVERSATION_MIN = 400;
/** Widest the preview may be beside the conversation: 70% of the room, leaving the conversation its minimum. */
const previewMaxWidth = (room: number) => (room ? Math.max(PREVIEW_MIN, Math.min(room * 0.7, room - CONVERSATION_MIN)) : Infinity);

interface ShownPreview extends PreviewState {
  nonce: number;
  /** Asked for while already shown: jump and flash rather than reload. */
  again: boolean;
}

function restored(taskId: string): ShownPreview | null {
  const saved = savedPreview(taskId);
  return saved ? { ...saved, nonce: 1, again: false } : null;
}

/** The bar between the conversation and the preview: drag to resize, double-click for the default width. */
function PanelResizer({ width, room, onChange }: { width: number; room: number; onChange: (w: number) => void }) {
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize the preview')}
      title={t('Drag to resize; double-click to reset')}
      data-testid="panel-resizer"
      onDoubleClick={() => onChange(PREVIEW_WIDTH)}
      onPointerDown={(e) => {
        const bar = e.currentTarget;
        const startX = e.clientX;
        const startW = width;
        bar.setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
        const move = (ev: PointerEvent) => {
          // Room for the conversation stays; the preview never gets too narrow to read.
          onChange(Math.min(previewMaxWidth(room), Math.max(PREVIEW_MIN, startW + (startX - ev.clientX))));
        };
        const up = () => {
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          bar.removeEventListener('pointercancel', up);
          document.body.classList.remove('resizing');
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
      }}
    />
  );
}

/**
 * In the main agent's view: everything the agents are waiting on, answerable right
 * here (same buttons as on their cards), or by telling the main agent.
 */
export function WaitingOnYou({ snapshot, now, onOpen, compact, limit }: { snapshot: WorkspaceSnapshot; now: number; onOpen?: (taskId: string) => void; compact?: boolean; limit?: number }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const open = snapshot.attention.filter((a) => a.state === 'open' && a.kind !== 'completion' && snapshot.tasks.some((t) => t.taskId === a.taskId));
  if (!open.length) return null;
  // With several waiting, one line each (expand one to answer) so the list stays short.
  const rows = open.length > 2;
  return (
    <div className={`waiting${compact ? ' compact' : ''}`} data-testid="waiting-on-you">
      <div className="section-label">{t('Waiting on you · {n}', { n: open.length })}</div>
      {open.slice(0, limit ?? open.length).map((a) => {
        const worker = snapshot.tasks.find((x) => x.taskId === a.taskId)!;
        if (rows && expanded !== a.id)
          return (
            <div key={a.id} className={`waiting-row kind-${a.kind}`} data-testid="waiting-row">
              <button className="waiting-row-main" onClick={() => setExpanded(a.id)} title={t('Show the request')}>
                <Alias alias={worker.alias} size="sm" />
                <span className="waiting-row-name">
                  <AgentName task={worker} />
                </span>
                <span className="waiting-row-text">{a.headline}</span>
              </button>
              {onOpen ? (
                <button className="link small" onClick={() => onOpen(worker.taskId)}>
                  {t('Open')}
                </button>
              ) : null}
            </div>
          );
        return (
          <div key={a.id} className="waiting-item">
            <div className="waiting-from">
              <Alias alias={worker.alias} size="sm" /> <AgentName task={worker} />
              {onOpen ? (
                <button className="link small" onClick={() => onOpen(worker.taskId)}>
                  {t('Open')}
                </button>
              ) : null}
              {rows ? (
                <button className="link small" onClick={() => setExpanded(null)}>
                  {t('Show less')}
                </button>
              ) : null}
            </div>
            <AttentionView item={a} task={worker} compact now={now} />
          </div>
        );
      })}
      {limit && open.length > limit ? <div className="muted small">{t('+{n} more', { n: open.length - limit })}</div> : null}
    </div>
  );
}

function TaskName({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(task.name);
  useEffect(() => setName(task.name), [task.name]);
  if (!editing)
    return (
      <span className="task-name" onDoubleClick={() => setEditing(true)} title={t('Double-click to rename')}>
        <AgentName task={task} />
      </span>
    );
  return (
    <input
      className="input inline"
      autoFocus
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && name.trim()) {
          void call('task:rename', { taskId: task.taskId, name: name.trim() });
          setEditing(false);
        }
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

function Transcript({ items, main }: { items: TranscriptItem[]; main?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  // Also when the size changes (the preview opens or is resized, the window, images loading):
  // a conversation that was at its end stays at its end.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const keep = () => stick.current && (el.scrollTop = el.scrollHeight);
    const ro = new ResizeObserver(keep);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      className="transcript"
      ref={ref}
      data-testid="transcript"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      <div className="transcript-inner">
        {items.length === 0 ? <div className="muted pad">{t('No messages yet. Type below to give this agent its first instruction.')}</div> : null}
        {groupNotices(groupTranscript(items.filter((i) => i.tool?.name !== 'ToolSearch'), main), main).map((entry) => {
          if (Array.isArray(entry)) return <ToolGroup key={entry[0].id} items={entry} main={main} />;
          if ('notices' in entry) return <NoticeGroup key={entry.notices[0].id} notices={entry.notices} />;
          const item = entry;
          if (item.role === 'tool') return <ToolCallRow key={item.id} item={item} />;
          if (item.role === 'thought')
            return (
              <details key={item.id} className="msg thought">
                <summary>
                  <Icon name="bulb" size={13} /> {t('Thinking')}{item.streaming ? '…' : ''}
                </summary>
                <Markdown text={item.text} />
              </details>
            );
          if (item.role === 'plan')
            return (
              <div key={item.id} className="msg plan-proposal" data-testid="plan-proposal">
                <div className="section-label">
                  <Icon name="list" size={12} /> {t('Proposed plan')}
                </div>
                <Markdown text={item.text} />
              </div>
            );
          return (
            <div key={item.id} className={`msg ${item.role}`} data-role={item.role}>
              {item.role === 'user' ? <div className="msg-via">
                  {item.via === 'main' ? t('Main agent') : t('You')}
                  {item.via === 'voice' ? ` · ${t('voice')}` : item.via === 'card' ? ` · ${t('from tile')}` : item.via === 'main' ? ` · ${t('on your behalf')}` : ''}
                  {item.delivery === 'steer' ? <span className="delivery-tag">{t('added mid-turn')}</span> : null}
                  {item.delivery === 'interrupt' ? <span className="delivery-tag interrupt">{t('stopped the turn')}</span> : null}
                </div> : null}
              {item.role === 'system' ? <div className="msg-system">{systemText(item.text)}</div> : <Markdown text={item.text} streaming={item.streaming} />}
              {item.streaming ? <span className="cursor" aria-hidden /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A worker's "waiting on you" / "request is settled" note in the main agent's conversation. */
const NOTICE_RE = /^(.+?)(?: is waiting on you \((?:permission|question)\): |'s request is settled: )/;

/**
 * In the main agent's conversation, consecutive worker notes fold into one line: with
 * many agents waiting they would otherwise fill the conversation, repeating the list above.
 */
function groupNotices(entries: Array<TranscriptItem | TranscriptItem[]>, main?: boolean): Array<TranscriptItem | TranscriptItem[] | { notices: TranscriptItem[] }> {
  if (!main) return entries;
  const out: Array<TranscriptItem | TranscriptItem[] | { notices: TranscriptItem[] }> = [];
  let run: TranscriptItem[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ notices: run });
    else out.push(...run);
    run = [];
  };
  for (const e of entries) {
    if (!Array.isArray(e) && e.role === 'system' && NOTICE_RE.test(e.text)) run.push(e);
    else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

function NoticeGroup({ notices }: { notices: TranscriptItem[] }) {
  const waiting = notices.filter((n) => / is waiting on you \(/.test(n.text)).length;
  const settled = notices.length - waiting;
  const names = [...new Set(notices.map((n) => NOTICE_RE.exec(n.text)?.[1] ?? ''))].filter(Boolean);
  const parts = [waiting ? t('{n} requests from agents', { n: waiting }) : '', settled ? t('{n} settled', { n: settled }) : ''].filter(Boolean).join(' · ');
  return (
    <details className="msg notices" data-testid="notice-group">
      <summary className="msg-system">
        <Icon name="chevron" size={10} />
        {parts} — {names.slice(0, 4).join(', ')}
        {names.length > 4 ? ` +${names.length - 4}` : ''}
      </summary>
      {notices.map((n) => (
        <div key={n.id} className="msg-system">
          {systemText(n.text)}
        </div>
      ))}
    </details>
  );
}

function Composer({ task, onBtw, btwCount = 0, inject }: { task: Task; onBtw?: (question: string) => void; btwCount?: number; inject?: { text: string; n: number } }) {
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  /** The bubble pressed with nothing typed and nothing asked yet: say how, in the box, for a moment. */
  const [btwHint, setBtwHint] = useState(false);
  // Text handed back from elsewhere (a side answer brought into the conversation): into the box to edit.
  useEffect(() => {
    if (inject?.text) setDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${inject.text}` : inject.text));
  }, [inject?.n]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  // While the agent works, Enter adds to what it is doing (read at its next step);
  // ⌘Enter stops the current turn and starts over with this message.
  const working = task.status === 'running' || task.status === 'starting';
  // `!command` runs a command in the agent's folder, as in the CLIs.
  const shell = draft.trimStart().startsWith('!') && !isMainAgent(task);
  const suggestion = !draft && task.suggestion ? task.suggestion : '';
  /**
   * A side question ("btw"): the same box, another way to send (⌥↵, the bubble button, or a message
   * starting /btw). It goes to the side column, never into the conversation, and interrupts nothing.
   * The button with nothing typed just opens the side questions.
   */
  const btw = () => {
    if (!onBtw) return;
    const text = draft.trim().replace(/^\/btw\b\s*/i, '');
    // Nothing to ask and nothing asked before: no empty side column, a hint in the box instead.
    if (!text && !btwCount) {
      setBtwHint(true);
      box.current?.focus();
      setTimeout(() => setBtwHint(false), 3000);
      return;
    }
    onBtw(text);
    if (text) setDraft('');
  };
  const send = async (interrupt = false) => {
    const text = draft.trim();
    if (!text || sending) return;
    if (onBtw && /^\/btw\b/i.test(text)) return btw();
    setSending(true);
    setError('');
    try {
      const command = text.slice(1).trim();
      if (shell && !command) return;
      // A command can run for a while (its row shows it running): the box is free at once, and
      // gets the command back if it could not run.
      if (shell) setDraft('');
      const r = shell ? await call('task:shell', { taskId: task.taskId, command }) : await call('task:send', { taskId: task.taskId, text, via: 'text', interrupt });
      if (r.ok) {
        if (!shell) setDraft('');
      } else {
        if (shell) setDraft((d) => d || text);
        setError(r.error ?? t('Not delivered'));
      }
    } catch (e) {
      if (shell) setDraft((d) => d || text);
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="composer">
      <div className={`composer-box${shell ? ' shell-mode' : ''}${suggestion ? ' has-suggestion' : ''}`}>
        <textarea
          ref={box}
          className="composer-input"
          rows={3}
          // A new agent with nothing asked yet: ready for its first message.
          autoFocus={!task.title.trim()}
          value={draft}
          placeholder={btwHint ? t('Type a side question, then ⌥↵') : suggestion || t('Message {alias}…', { alias: isMainAgent(task) ? t('Main agent') : task.alias })}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="composer-input"
          data-suggestion={suggestion || undefined}
          onKeyDown={(e) => {
            // → or Tab takes the suggested reply into the box (edit it, or Enter to send).
            if (suggestion && (e.key === 'ArrowRight' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey) {
              e.preventDefault();
              setDraft(suggestion);
              return;
            }
            if (e.key === 'Enter' && e.altKey && !e.nativeEvent.isComposing && onBtw) {
              e.preventDefault();
              if (draft.trim()) btw();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(e.metaKey || e.ctrlKey);
            }
          }}
        />
        <div className="composer-foot">
          <span className="to-label" data-testid="composer-target">
            {shell ? (
              <>
                {t('Command')} · {task.host ?? t('this Mac')}
                <span className="muted">
                  {' '}
                  — {task.provider === 'codex' ? t('runs in {dir} through Codex, which sees the output', { dir: task.cwd }) : t('runs in {dir}; {alias} sees the output with your next message', { dir: task.cwd, alias: task.alias })}
                </span>
              </>
            ) : (
              <>
                {t('To: {alias}', { alias: isMainAgent(task) ? t('Main agent') : task.alias })} · {PROVIDER_LABEL[task.provider]}
                <span className="muted"> — {t('typed text goes only to this agent')}</span>
              </>
            )}
          </span>
          <span className="hint" data-testid="composer-hint">
            {suggestion ? (
              <>
                <Kbd>→</Kbd> {t('use suggestion')} ·{' '}
              </>
            ) : null}
            {shell ? (
              <>
                <Kbd>↵</Kbd> {t('run')}
              </>
            ) : working ? (
              <>
                <Kbd>↵</Kbd> {t('add to current work')} · <Kbd>⌘↵</Kbd> {t('stop and send')}
              </>
            ) : (
              <>
                <Kbd>↵</Kbd> {t('send')} · <Kbd>⇧↵</Kbd> {t('new line')}
              </>
            )}
            {onBtw && !shell ? (
              <>
                {' '}
                · <Kbd>⌥↵</Kbd> {t('side question')}
              </>
            ) : null}
          </span>
          {working && !shell ? (
            <button className="btn btn-sm" disabled={!draft.trim() || sending} onClick={() => void send(true)} title={t('Stop the current turn and start over with this message')} data-testid="send-interrupt">
              {t('Stop & send')}
            </button>
          ) : null}
          {onBtw && !shell ? (
            <button className="btw-btn" aria-label={t('Side question')} data-tip={t('Side question (⌥↵): not part of the conversation, interrupts nothing')} onClick={btw} data-testid="btw-send">
              <Icon name="btw" />
            </button>
          ) : null}
          <button className="send-btn" aria-label={t('Send')} disabled={!draft.trim() || sending} onClick={() => void send()}>
            <Icon name="send" />
          </button>
        </div>
      </div>
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}

function MemoryPanel({ snapshot, task }: { snapshot: WorkspaceSnapshot; task: Task }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const project = snapshot.projects.find((p) => p.projectId === task.projectId);
  const mem = snapshot.memory;
  const groups: Array<{ title: string; records: MemoryRecord[]; hint: string }> = [
    { title: t('This task'), records: mem.filter((m) => m.scope === 'task' && m.scopeId === task.taskId), hint: t('Private to {alias}.', { alias: task.alias }) },
    { title: `${t('Project')} · ${project?.name ?? ''}`, records: mem.filter((m) => m.scope === 'project' && m.scopeId === task.projectId), hint: t('Approved notes load into new sessions here.') },
    { title: t('Global'), records: mem.filter((m) => m.scope === 'global'), hint: t('Approved notes load into every new session.') },
  ];
  const run = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e) => setError(errorText(e)));
  };
  return (
    <aside className="memory" aria-label={t('Scoped memory')} data-testid="memory-panel">
      <div className="panel-title">{t('Memory')}</div>
      <p className="muted small">{t('App-owned notes. They never rewrite a running session.')}</p>
      <div className="memory-add">
        <textarea className="input" rows={2} placeholder={t('Add a note for this task…')} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button
          className="btn"
          disabled={!draft.trim()}
          onClick={() =>
            run(async () => {
              await call('memory:add', { scope: 'task', scopeId: task.taskId, body: draft.trim(), originTaskId: task.taskId, approvedForReuse: false });
              setDraft('');
            })
          }
        >
          {t('Add note')}
        </button>
      </div>
      {error ? <div className="error-text">{error}</div> : null}
      {groups.map((g) => (
        <div key={g.title} className="memory-group">
          <div className="section-label" title={g.hint}>
            {g.title}
            <span className="count-muted">{g.records.length}</span>
          </div>
          {g.records.length === 0 ? <div className="muted small">{g.hint}</div> : null}
          {g.records.map((m) => (
            <div key={m.id} className="memory-record" data-testid="memory-record" data-scope={m.scope}>
              <div className="memory-body">{m.body}</div>
              <div className="memory-meta">
                {m.source}
                {m.originTaskId ? ` · ${t('from {alias}', { alias: snapshot.tasks.find((x) => x.taskId === m.originTaskId)?.alias ?? t('removed task') })}` : ''}
                {task.injectedMemoryIds?.includes(m.id) ? ` · ${t('loaded in this session')}` : ''}
              </div>
              <div className="memory-actions">
                {m.scope !== 'task' ? (
                  <label className="small check">
                    <input type="checkbox" checked={m.approvedForReuse} onChange={(e) => run(() => call('memory:update', { id: m.id, approvedForReuse: e.target.checked }))} /> {t('approved for reuse')}
                  </label>
                ) : null}
                {m.scope === 'task' ? (
                  <button className="link" onClick={() => run(() => call('memory:promote', { id: m.id, scope: 'project' }))}>
                    {t('Share with project')}
                  </button>
                ) : null}
                {m.scope !== 'global' ? (
                  <button className="link" onClick={() => run(() => call('memory:promote', { id: m.id, scope: 'global' }))}>
                    {t('Save as global')}
                  </button>
                ) : null}
                <button className="link danger" onClick={() => run(() => call('memory:delete', { id: m.id }))}>
                  {t('Delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}
