import { Fragment, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SideSlot } from '../side-slot';
import { accountKey } from '../../shared/types';
import type { AttentionItem, MemoryRecord, PermissionMode, Task, TranscriptItem, WorkspaceSnapshot, BtwEntry } from '../../shared/types';
import { PERMISSION_MODES } from './Settings';
import { call, errorText } from '../api';
import { AttentionView } from './AttentionView';
import { foldsTurn, OPEN_TURNS, groupTranscript, PlanChecklist, PreviewContext, splitTurns, ToolCallRow, ToolGroup, turnSummary } from './Content';
import { FilePreviewPanel } from './FilePreview';
import { AgentName, Alias, displayName, Icon, isMainAgent, Kbd, PROVIDER_LABEL, ProviderTag, StatusDot, systemText, warningText } from './bits';
import { Markdown } from './Markdown';
import { ModelPicker } from './ModelPicker';
import { AgentMemoryPanel, MemoryChip, RememberButton, RememberDialog } from './SessionMemory';
import { menuAt, useContextMenu } from './ContextMenu';
import { agentMenuItems, EditableAgentName, type AgentField } from './AgentMenu';
import { RetryNotice } from './Retry';
import { UsageChips } from './SessionUsage';
import { FindBar } from './FindBar';
import { ConfirmDialog, ForkDialog } from './Dialogs';
import { RemoteControlButton } from './RemoteControl';
import { BtwPanel } from './Btw';
import { SidePanel } from './SidePanel';
import { SessionMap, SessionMiniMap } from './SessionMap';
import { MainLanes, MainLanesMini } from './MainLanes';
import { mainLanes } from '../../shared/main-lanes';
import { chapters } from '../../shared/chapters';
import { sessionMap, type MapGrouping } from '../../shared/session-map';
import { turnChanges } from '../turn-changes';
import { resolvePosix } from '../../shared/preview';
import { t, language } from '../i18n';
import { OpenInApp } from './OpenInApp';
import { AttachButton, AttachmentStrip, MessageImages, useAttachments } from './Attachments';
import { dropMentions, MentionHighlight, MentionMenu, useMentions } from './Mentions';
import { savedPreview, savePreview, type PreviewState } from '../preview-store';
import { useDraft } from '../drafts';

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
  // Main agent: the request the user unfolded in "waiting on you"; what they write is likely about it.
  const [aboutId, setAboutId] = useState<string | null>(null);
  useEffect(() => setAboutId(null), [task.taskId]);
  // Opened: start its session in the background so the first message does not wait for it.
  // The main process leaves the agent's place, status and flags as they were.
  useEffect(() => {
    void call('task:warm', { taskId: task.taskId }).catch(() => {});
  }, [task.taskId]);
  const aboutItem = aboutId ? snapshot.attention.find((a) => a.id === aboutId && a.state === 'open') : undefined;
  const aboutTask = aboutItem ? snapshot.tasks.find((x) => x.taskId === aboutItem.taskId) : undefined;
  const about = aboutItem && aboutTask ? { id: aboutItem.id, alias: aboutTask.alias, headline: aboutItem.headline } : undefined;
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
    setShowMap(false);
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
  // The session map: its turns as tasks (a model's grouping, cached; structure until then), beside the
  // conversation when the window leaves room, else in the side column.
  const threadRef = useRef<HTMLDivElement>(null);
  const turnCount = useMemo(() => transcript.filter((i) => i.role === 'user').length, [transcript]);
  const [grouping, setGrouping] = useState<MapGrouping | null>(null);
  const settled = task.status !== 'running' && task.status !== 'starting';
  useEffect(() => setGrouping(null), [task.taskId]);
  useEffect(() => {
    if (turnCount < 2 || !settled) return;
    let live = true;
    void call('session:map', { taskId: task.taskId })
      .then((g) => live && setGrouping(g))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [task.taskId, turnCount, settled]);
  const forks = useMemo(() => snapshot.tasks.filter((x) => x.forkedFrom?.taskId === task.taskId), [snapshot.tasks, task.taskId]);
  const mapTasks = useMemo(() => (turnCount >= 2 ? sessionMap(transcript, forks, grouping) : []), [transcript, forks, grouping, turnCount]);
  // The header's line: what the agent is on, the last task of its map (as drawn here, else as cached for
  // the sidebar). Never its latest message, and nothing until a map exists.
  const workTitle = (grouping ? mapTasks.at(-1)?.title : undefined) ?? snapshot.workTitles?.[task.taskId];
  // The main agent's map: lanes, one per agent it handed work to (instead of one trunk of tasks).
  const main = isMainAgent(task);
  // By chapter: the map draws the current one; earlier chapters fold to a line each.
  const parts = useMemo(() => (main ? chapters(transcript) : []), [main, transcript]);
  const current = parts.at(-1)?.items ?? [];
  const lanes = useMemo(() => (main ? mainLanes(current, snapshot.tasks, snapshot.projects) : null), [main, current, snapshot.tasks, snapshot.projects]);
  // Beside the conversation the room is narrow: fewer columns, and names only on hand-offs.
  const lanesBeside = useMemo(() => (main ? mainLanes(current, snapshot.tasks, snapshot.projects, 4) : null), [main, current, snapshot.tasks, snapshot.projects]);
  const earlier = useMemo(
    () => parts.slice(0, -1).map((c) => ({ key: c.items[0]?.id ?? String(c.start), at: c.at || c.items[0]?.createdAt || '', items: c.items })),
    [parts],
  );
  const hasMap = main ? !!lanes?.lanes.length || earlier.length > 0 : mapTasks.length > 0;
  // Where each lane ends: how that agent is doing now.
  const outcomes = useMemo(() => Object.fromEntries(snapshot.tasks.map((x) => [x.taskId, { status: x.status, summary: x.summary }])), [snapshot.tasks]);
  // Forked from another agent: where this trunk came in.
  const mapOrigin = useMemo(() => {
    const from = task.forkedFrom;
    if (!from) return undefined;
    const parent = snapshot.tasks.find((x) => x.taskId === from.taskId);
    return { taskId: from.taskId, alias: parent?.alias ?? from.alias, name: parent?.name ?? from.alias };
  }, [task.forkedFrom, snapshot.tasks]);
  const [showMap, setShowMap] = useState(false);
  /** The conversation pane's width (px), and the task whose turns are in view. */
  const [threadW, setThreadW] = useState(0);
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  useEffect(() => {
    const thread = threadRef.current;
    const scroller = thread?.querySelector<HTMLElement>('.transcript');
    const inner = thread?.querySelector<HTMLElement>('.transcript-inner');
    if (!thread || !scroller || !inner) return;
    const measure = () => setThreadW(scroller.clientWidth);
    const track = () => {
      // Right after a jump from the map, its choice stands (the jump's own scrolling does not overrule it).
      if (Date.now() - jumpedAt.current < 900) return;
      // The last turn starting above 40% of the view is the one being read.
      const top = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.4;
      let turn: string | null = null;
      for (const el of scroller.querySelectorAll<HTMLElement>('.msg.user[data-item-id]')) {
        if (el.getBoundingClientRect().top <= top) turn = el.dataset.itemId ?? null;
        else break;
      }
      // At the end of the conversation, the latest task is the one in view (however short it is).
      const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
      const owner = atEnd ? mapTasks.at(-1) : (mapTasks.find((x) => turn && x.turnIds.includes(turn)) ?? mapTasks[0]);
      setCurrentTask(owner?.startItemId ?? null);
    };
    measure();
    track();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    scroller.addEventListener('scroll', track, { passive: true });
    return () => {
      ro.disconnect();
      scroller.removeEventListener('scroll', track);
    };
    // Width changes (a preview opening, covering) reach the ResizeObserver.
  }, [mapTasks]);
  const jumpedAt = useRef(0);
  const jumpTo = (turnId: string) => {
    // The task jumped to is the one being read, whether or not the conversation can scroll to it.
    jumpedAt.current = Date.now();
    setCurrentTask(mapTasks.find((x) => x.turnIds.includes(turnId))?.startItemId ?? null);
    const el = threadRef.current?.querySelector<HTMLElement>(`.msg.user[data-item-id="${turnId}"]`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  /**
   * Beside the conversation when the pane can give the map its room and still keep a readable column
   * (centred in what is left); else its outline at the edge, opening the full map in the side column.
   */
  const MAP_ROOM = 250;
  // Opened in the side column by the user, it stays there (dragging the column narrower does not move it
  // beside the conversation under the pointer); closed, it comes back beside when there is room.
  const mapBeside = hasMap && !showMap && threadW - MAP_ROOM - 32 >= 720;
  // No room for it: its outline (no words) in a strip the column gives up on its right, unless even that
  // would leave too narrow a column; then nothing (nothing floats over the messages).
  const MINI_ROOM = 48;
  const miniFits = !mapBeside && hasMap && threadW - MINI_ROOM - 32 >= 520;
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
  // The side column's width as its share of the room, so it grows and shrinks with the window like the
  // conversation does; dragged by the user, kept for next time. A width kept by an earlier version becomes
  // its share of the first room measured.
  const [previewShare, setPreviewShare] = useState<number | null>(() => Number(localStorage.getItem('amw.previewShare')) || (localStorage.getItem('amw.previewWidth') ? null : PREVIEW_SHARE));
  useEffect(() => {
    if (previewShare === null && bodyW > 0) setPreviewShare(Number(localStorage.getItem('amw.previewWidth')) / bodyW || PREVIEW_SHARE);
  }, [bodyW, previewShare]);
  // Maximized: the preview takes the whole conversation area until restored (Esc) or closed.
  // Maximized: the side panel (any kind) takes the whole conversation area until restored (Esc) or closed.
  const [previewMax, setPreviewMax] = useState(false);
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
    if (!bodyW) return;
    setPreviewShare(w / bodyW);
    localStorage.setItem('amw.previewShare', (w / bodyW).toFixed(4));
  };
  useEffect(() => setPreviewState(restored(task.taskId)), [task.taskId]);
  // Too narrow for both (the conversation keeps 400px, a side panel 300px): the panel covers it.
  const narrow = bodyW > 0 && bodyW < PREVIEW_MIN + CONVERSATION_MIN;
  // Which panel the side column shows: one at a time, the preview first.
  const sideKind: 'preview' | 'map' | 'btw' | 'memory' | null = preview ? 'preview' : showMap && hasMap ? 'map' : showBtw && btw.length ? 'btw' : showMemory ? 'memory' : null;
  useEffect(() => {
    setPreviewMax(false);
  }, [sideKind]);
  // Every panel alike: beside the conversation when both fit, else (or maximized) in its place.
  const covering = !!sideKind && (previewMax || narrow);
  // The room the map takes right of the conversation: all of it beside, a strip for the outline, or none
  // while the full map is open in the side column.
  const mapRoom = mapBeside ? MAP_ROOM : miniFits && !(showMap && !preview) ? MINI_ROOM : 0;
  const shownWidth = Math.min(Math.max(previewShare !== null && bodyW ? previewShare * bodyW : PREVIEW_WIDTH, PREVIEW_MIN), previewMaxWidth(bodyW));
  const [forking, setForking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Conversations on this computer can be forked once saved, when their provider supports it.
  const canFork = !isMainAgent(task) && !task.host && !!snapshot.capabilities.find((c) => c.provider === task.provider)?.fork && !!session?.nativeSessionId;
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e) => setError(errorText(e)));
  };
  // "Open in default app" only for files on this computer.
  const openExternal = task.host ? undefined : (path: string) => run(() => call('file:open', { taskId: task.taskId, path }));

  // A file previewed while it has changes in the latest turn can show them (File / Changes).
  const previewDiffs = preview ? changes.files.find((f) => f.path === preview.path || resolvePosix(task.cwd, f.path) === resolvePosix(task.cwd, preview.path))?.diffs : undefined;
  /** The frame every side panel shares: one width, maximize (unless it already covers), close. */
  const frame = (onClose: () => void) => ({ width: shownWidth, maximized: covering, onToggleMax: narrow ? undefined : () => setPreviewMax(!previewMax), onClose });
  /** In the conversation's place, acting on the conversation closes the panel first, so it is seen. */
  const thenConversation = (fn: () => void) => {
    if (!covering) return fn();
    setShowMap(false);
    setShowBtw(false);
    setTimeout(fn, 50);
  };
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
  const sidePanel =
    sideKind === 'preview' ? (
      previewPanel
    ) : sideKind === 'map' ? (
      <SidePanel title={main ? t('Agents') : t('Task index')} label={main ? t('Agents') : t('Task index')} testId="session-map-panel" frame={frame(() => setShowMap(false))}>
        {lanes ? (
          <MainLanes earlier={earlier} tasks={snapshot.tasks} projects={snapshot.projects} lanes={lanes.lanes} rows={lanes.rows} outcomes={outcomes} onJump={(id) => thenConversation(() => jumpTo(id))} onOpenAgent={(id) => onOpen?.(id)} />
        ) : (
          <SessionMap tasks={mapTasks} current={currentTask} onJump={(id) => thenConversation(() => jumpTo(id))} onOpenAgent={(id) => onOpen?.(id)} origin={mapOrigin} />
        )}
      </SidePanel>
    ) : sideKind === 'btw' ? (
      <BtwPanel
        task={task}
        entries={btw}
        frame={frame(() => setShowBtw(false))}
        onClear={() => {
          setBtw([]);
          setShowBtw(false);
          void call('btw:clear', { taskId: task.taskId }).catch(() => {});
        }}
        onBring={(text) => thenConversation(() => setInject((cur) => ({ text, n: cur.n + 1 })))}
      />
    ) : sideKind === 'memory' ? (
      <AgentMemoryPanel snapshot={snapshot} task={task} frame={frame(() => setShowMemory(false))} />
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
              <TaskName task={task} tasks={snapshot.tasks} /> <SessionTag provider={task.provider} id={session?.nativeSessionId} mode={session?.integrationMode} /> <ModelPicker task={task} /> <StatusDot status={task.status} connected={connected} />
            </div>
            <div className="focus-meta mono">
              <MemoryChip
                snapshot={snapshot}
                task={task}
                open={showMemory && !preview && !showBtw}
                onToggle={() => {
                  const on = preview || showBtw ? true : !showMemory;
                  setShowMemory(on);
                  setShowBtw(false);
                  setPreview(null);
                }}
              />
              <UsageChips task={task} limits={snapshot.limits?.[accountKey(task)]} now={now} only={['tokens']} />
              {workTitle ? (
                <span className="truncate" title={workTitle} data-testid="focus-work">
                  {workTitle}
                </span>
              ) : null}
              <span title={task.host ? `${task.host}:${task.cwd}` : task.cwd}>
                <Icon name="folder" size={12} /> {task.host ? `${task.host}:` : ''}
                {project?.name}
              </span>
              {task.worktree ? (
                <span title={task.worktree.path}>
                  <Icon name="branch" size={12} /> {task.worktree.branch}
                </span>
              ) : null}
              {task.forkedFrom ? (
                <span>
                  <Icon name="branch" size={12} /> {t('forked from {name}', { name: task.forkedFrom.alias })}
                </span>
              ) : null}
            </div>
          </div>
          <div className="focus-actions">
            {/* In order of use: running it, opening its folder, its session, putting it away (remove last). */}
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
            {/* Sync: after going on with this session elsewhere (the terminal, a desktop or editor app), pick that up here. */}
            {!isMainAgent(task) && session?.nativeSessionId ? (
              <button
                className={`btn btn-icon${syncing ? ' busy' : ''}`}
                disabled={syncing || task.status === 'running' || task.status === 'starting' || open.some((a) => !!a.providerRequestId)}
                aria-label={t('Sync')}
                data-tip={t('Sync')}
                data-testid="sync-session"
                onClick={() => {
                  setSyncing(true);
                  run(() => call('task:sync', { taskId: task.taskId }).finally(() => setSyncing(false)));
                }}
              >
                <Icon name="refresh" />
              </button>
            ) : null}
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
            {/* Remote Control: this agent on a phone, still running here (Claude Code: the Claude app; Codex: the ChatGPT app, with a ChatGPT login). */}
            {(task.provider === 'claude' || task.provider === 'mock' || (task.provider === 'codex' && snapshot.capabilities.find((c) => c.provider === 'codex')?.remoteControl)) && !task.host && !isMainAgent(task) ? (
              <RemoteControlButton task={task} url={snapshot.remoteControl?.[task.taskId]} codex={snapshot.codexRemote?.[task.taskId]} />
            ) : null}
            {/* The main agent: start a new chapter (a fresh session, handed over what is going on now). */}
            {isMainAgent(task) ? (
              <button className="btn btn-icon" data-tip={t('New chapter')} aria-label={t('New chapter')} data-testid="new-chapter" onClick={() => run(() => call('main:newChapter', {}))}>
                <Icon name="plus" />
              </button>
            ) : null}
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
            message={
              task.worktree
                ? t('Stops the agent and removes it from the workspace. Its worktree is deleted if nothing in it is uncommitted, and then its conversation cannot be continued; otherwise the worktree is kept on disk.')
                : snapshot.capabilities.find((c) => c.provider === task.provider)?.importHistory === false
                  ? t('Stops the agent and removes it from the workspace. Its conversation stays in {provider}.', { provider: PROVIDER_LABEL[task.provider] ?? task.provider })
                  : t('Stops the agent and removes it from the workspace. Its conversation stays in {provider}: bring it back any time with Continue a session… (the history button next to + in the sidebar)', { provider: PROVIDER_LABEL[task.provider] ?? task.provider })
            }
            confirmLabel={t('Remove')}
            danger
            onConfirm={() => run(() => call('task:remove', { taskId: task.taskId }))}
            onClose={() => setRemoving(false)}
          />
        ) : null}
        {forking ? <ForkDialog snapshot={snapshot} task={task} onClose={() => setForking(false)} onForked={(id) => onOpen?.(id)} /> : null}

        <div className="focus-body" ref={bodyRef}>
          {/* Kept mounted while the preview is maximized, so the conversation keeps its place. */}
          <div className={`focus-thread${mapRoom ? ' with-map' : ''}`} hidden={covering} ref={threadRef} style={mapRoom ? { ['--map-room' as string]: `${mapRoom}px` } : undefined}>
            {/* The session map in the room right of the conversation; with no room, its outline, opening the side column. */}
            {mapBeside ? (
              <div className="session-map-beside" style={{ width: MAP_ROOM - 44 }} data-testid="session-map-beside">
                {lanes ? (
                  <MainLanes earlier={earlier} tasks={snapshot.tasks} projects={snapshot.projects} lanes={lanesBeside!.lanes} rows={lanesBeside!.rows} outcomes={outcomes} compact onJump={jumpTo} onOpenAgent={(id) => onOpen?.(id)} />
                ) : (
                  <SessionMap tasks={mapTasks} current={currentTask} onJump={jumpTo} onOpenAgent={(id) => onOpen?.(id)} origin={mapOrigin} />
                )}
              </div>
            ) : mapRoom ? (
              lanes ? (
                <MainLanesMini lanes={lanes.lanes} rows={lanes.rows} onOpen={() => { setShowMap(true); setPreview(null); setShowBtw(false); }} />
              ) : (
                <SessionMiniMap tasks={mapTasks} current={currentTask} onOpen={() => { setShowMap(true); setPreview(null); setShowBtw(false); }} />
              )
            ) : null}
            <PreviewContext.Provider value={{ preview: setPreview, openExternal }}>
              <Transcript items={transcript} main={isMainAgent(task)} task={task} snapshot={snapshot} />
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
            {/* What the agents wait on: one line right above the reply box, unfolding to answer them here. */}
            {isMainAgent(task) ? <WaitingOnYou snapshot={snapshot} now={now} onOpen={onOpen} bar onPick={setAboutId} /> : null}
            <Composer
              key={task.taskId}
              task={task}
              onBtw={isMainAgent(task) || snapshot.capabilities.find((c) => c.provider === task.provider)?.sideQuestions === false ? undefined : askBtw}
              btwCount={btw.length}
              inject={inject}
              about={about}
              onClearAbout={() => setAboutId(null)}
              // The context is this agent's (beside the box); its account's limits only when they are close
              // (they are the account's: in the sidebar).
              side={<UsageChips task={task} limits={snapshot.limits?.[accountKey(task)]} now={now} only={['context']} />}
              under={<UsageChips task={task} limits={snapshot.limits?.[accountKey(task)]} now={now} only={['limits-if-hot']} />}
            />
          </div>
          {/* Maximized or too narrow, the preview takes the conversation's place under the header;
              beside it, it is a full-height column on the right (the side slot). */}
          {covering ? sidePanel : null}
        </div>
      </section>
      {(() => {
        if (!sidePanel || covering) return null;
        const panel = (
          <>
            <PanelResizer width={shownWidth} room={bodyW} onChange={setPreviewWidth} />
            {sidePanel}
          </>
        );
        return side ? createPortal(panel, side) : panel;
      })()}
    </div>
  );
}

/** The side column's default share of the room it and the conversation split (about 460px in a laptop window). */
const PREVIEW_SHARE = 0.4;
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
  // A drag in progress ends with the bar too: if the panel goes while dragging, the pointer is not left as a resize cursor.
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize the side column')}
      title={t('Drag to resize; double-click to reset')}
      data-testid="panel-resizer"
      onDoubleClick={() => onChange(room ? room * PREVIEW_SHARE : PREVIEW_WIDTH)}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        document.body.classList.add('resizing');
        // On the window, so a fast drag that outruns the thin bar (or outlives it) still ends.
        const move = (ev: PointerEvent) => {
          // Room for the conversation stays; the preview never gets too narrow to read.
          onChange(Math.min(previewMaxWidth(room), Math.max(PREVIEW_MIN, startW + (startX - ev.clientX))));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          document.body.classList.remove('resizing');
          stop.current = null;
        };
        stop.current = up;
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      }}
    />
  );
}

/**
 * Everything the agents are waiting on, answerable right here (same buttons as on their cards),
 * or by telling the main agent. In the main agent's view (`bar`): one line above the reply box,
 * "N waiting", that unfolds into the list; nothing at all when nothing waits.
 */
export function WaitingOnYou({
  snapshot,
  now,
  onOpen,
  compact,
  limit,
  bar,
  onPick,
}: {
  snapshot: WorkspaceSnapshot;
  now: number;
  onOpen?: (taskId: string) => void;
  compact?: boolean;
  limit?: number;
  bar?: boolean;
  /** The row the user unfolded themselves (not one opened by itself), or null. */
  onPick?: (attentionId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState(false);
  // The bar's open row: undefined = automatic (the only one, when there is one), null = none.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const open = snapshot.attention.filter((a) => a.state === 'open' && a.kind !== 'completion' && snapshot.tasks.some((t) => t.taskId === a.taskId));
  // Folds again once everything is answered, so the next request arrives as one line.
  useEffect(() => {
    if (!open.length) setUnfolded(false);
    setPicked((p) => (p && !open.some((a) => a.id === p) ? undefined : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.length]);
  if (!open.length) return null;
  // With several waiting, one line each (expand one to answer) so the list stays short.
  const rows = open.length > 2;
  const list = open.slice(0, limit ?? open.length).map((a) => {
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
      <div key={a.id} className="waiting-item" data-testid="waiting-item">
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
  });
  const more = limit && open.length > limit ? <div className="muted small">{t('+{n} more', { n: open.length - limit })}</div> : null;
  if (bar) {
    // Who is waiting, once each, for the folded line.
    const who = [...new Map(open.map((a) => [a.taskId, snapshot.tasks.find((x) => x.taskId === a.taskId)!])).values()];
    return (
      <div className={`waiting waiting-bar${unfolded ? ' open' : ''}`} data-testid="waiting-on-you">
        <div className="waiting-bar-box">
          <button
            className="waiting-bar-head"
            aria-expanded={unfolded}
            onClick={() => {
              // Folded, nothing is unfolded any more: messages are no longer taken as about a request.
              if (unfolded) {
                setPicked(undefined);
                onPick?.(null);
              }
              setUnfolded(!unfolded);
            }}
            data-testid="waiting-bar-toggle"
          >
            <span className="waiting-bar-dot" aria-hidden />
            <span className="waiting-bar-count">{t('{n} waiting on you', { n: open.length })}</span>
            <span className="waiting-bar-who" aria-hidden>
              {who.slice(0, 3).map((w) => (
                <Alias key={w.taskId} alias={w.alias} size="sm" />
              ))}
            </span>
            {!unfolded ? <span className="waiting-bar-peek">{open[0].headline}</span> : <span className="waiting-bar-peek" />}
            <span className="waiting-bar-chevron" aria-hidden>
              <Icon name="chevron" size={12} />
            </span>
          </button>
          {unfolded ? (
            <div className="waiting-bar-list" data-testid="waiting-bar-list">
              {open.map((a) => {
                const worker = snapshot.tasks.find((x) => x.taskId === a.taskId)!;
                // One at a time; a lone request opens by itself.
                const isOpen = picked === undefined ? open.length === 1 : picked === a.id;
                const toggle = () => {
                  setPicked(isOpen ? null : a.id);
                  onPick?.(isOpen ? null : a.id);
                };
                return <WaitingBarRow key={a.id} item={a} task={worker} now={now} open={isOpen} onToggle={toggle} onOpen={onOpen} />;
              })}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className={`waiting${compact ? ' compact' : ''}`} data-testid="waiting-on-you">
      <div className="section-label">{t('Waiting on you · {n}', { n: open.length })}</div>
      {list}
      {more}
    </div>
  );
}

/** Short kind tags for the bar's rows. */
const KIND_TAG: Record<AttentionItem['kind'], string> = { approval: 'Permission', question: 'Question', error: 'Error', review: 'Review', completion: 'Report' };

/** The decisions a permission request can take right on its row: allow (once, if offered) and deny. */
function quickOptions(item: AttentionItem): NonNullable<AttentionItem['options']> {
  if (item.kind !== 'approval' || !item.providerRequestId) return [];
  const opts = item.options ?? [];
  const rejects = (o: (typeof opts)[number]) => (o.kind ? o.kind.startsWith('reject') : /deny|decline|reject/.test(o.id));
  const allow = opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => !rejects(o) && o.kind !== 'allow_always') ?? opts.find((o) => !rejects(o));
  const deny = opts.find(rejects);
  return [allow, deny].filter((o): o is (typeof opts)[number] => !!o);
}

/**
 * One request in the bar: who, what kind, what; a permission is allowed or denied right here, anything
 * else unfolds below the row (flat, not a card inside the bar) to answer or dismiss it.
 */
function WaitingBarRow({ item, task, now, open, onToggle, onOpen }: { item: AttentionItem; task: Task; now: number; open: boolean; onToggle: () => void; onOpen?: (taskId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const quick = quickOptions(item);
  const respond = async (decision: string) => {
    setBusy(true);
    setError('');
    try {
      await call('attention:respond', { attentionId: item.id, decision });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const rejects = (o: (typeof quick)[number]) => (o.kind ? o.kind.startsWith('reject') : /deny|decline|reject/.test(o.id));
  return (
    <div className={`wb-row kind-${item.kind}${open ? ' open' : ''}${item.highRisk ? ' high-risk' : ''}`} data-testid="waiting-row" data-kind={item.kind}>
      <div className="wb-line">
        <button className="wb-main" onClick={onToggle} aria-expanded={open} title={open ? t('Show less') : t('Show the request')}>
          <Alias alias={task.alias} size="sm" />
          <span className="wb-name">
            <AgentName task={task} />
          </span>
          <span className="wb-kind">{t(KIND_TAG[item.kind])}</span>
          {item.highRisk ? <span className="wb-risk">{t('high risk')}</span> : null}
          <span className="wb-text">{item.headline}</span>
        </button>
        {quick.map((o) => (
          <button key={o.id} className={`btn btn-sm${rejects(o) ? '' : ' btn-primary'}`} disabled={busy} title={o.description} onClick={() => respond(o.id)}>
            {t(o.label)}
          </button>
        ))}
        {!quick.length && item.kind === 'question' && item.providerRequestId && !open ? (
          <button className="btn btn-sm btn-primary" onClick={onToggle}>
            {t('Answer')}
          </button>
        ) : null}
        <button className="wb-chevron" onClick={onToggle} aria-label={open ? t('Show less') : t('Show the request')} tabIndex={-1}>
          <Icon name="chevron" size={12} />
        </button>
      </div>
      {error ? <div className="error-text wb-error">{error}</div> : null}
      {open ? (
        <div className="wb-detail" data-testid="waiting-detail">
          {/* Unfolded is asking to read it: all of it, no "Show more" (the list scrolls when it is long). */}
          <AttentionView item={item} task={task} now={now} flat skipOptions={quick.map((o) => o.id)} />
          {onOpen ? (
            <button className="link small wb-open" onClick={() => onOpen(task.taskId)}>
              {t('Open {name}', { name: displayName(task) })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The agent's label and name in its header: double-click renames the label; right-click offers both. */
function TaskName({ task, tasks }: { task: Task; tasks: Task[] }) {
  const [editing, setEditing] = useState<AgentField | null>(null);
  const menu = useContextMenu();
  if (isMainAgent(task))
    return (
      <span className="task-name">
        <AgentName task={task} />
      </span>
    );
  return (
    <span
      className={`task-name${editing ? ' editing' : ''}`}
      data-testid="focus-title"
      onDoubleClick={() => editing || setEditing('name')}
      onContextMenu={(e) => editing || menu.open(menuAt(e, agentMenuItems(task, { onRename: setEditing })))}
      title={editing ? undefined : t('Double-click to rename')}
    >
      <EditableAgentName task={task} tasks={tasks} editing={editing} onDone={() => setEditing(null)} />
      {menu.element}
    </span>
  );
}

// Memoized: resizing the window (or the side column) re-renders the view on every frame; the
// conversation itself only when what it shows changes.
const Transcript = memo(function Transcript({ items, main, task, snapshot }: { items: TranscriptItem[]; main?: boolean; task: Task; snapshot: WorkspaceSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  // "Keep as memory" on one of the user's messages: the dialog, and the right-click menu that opens it.
  const [remember, setRemember] = useState<string | null>(null);
  // Right-click on a message: Copy, and on what the user said themselves, Keep as memory.
  const menu = useContextMenu();
  const stick = useRef(true);
  // ⌘F: find in this conversation (folded turns included).
  const inner = useRef<HTMLDivElement>(null);
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f' || e.shiftKey || e.altKey) return;
      e.preventDefault();
      setFinding(true);
      window.dispatchEvent(new CustomEvent('amw:find-again'));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Another agent opened in this same view: it starts at its end (where the reader was in the last one,
  // scrolled up or not, says nothing about this one).
  useLayoutEffect(() => {
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task.taskId]);
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
  const shown = items.filter((i) => i.tool?.name !== 'ToolSearch');
  const order = new Map(shown.map((x, n) => [x.id, n]));
  const turns = splitTurns(shown);
  const renderEntry = (entry: TranscriptItem | TranscriptItem[] | { notices: TranscriptItem[] }) => {
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
          if (item.role === 'system' && item.chapter)
            return (
              <div key={item.id} className="chapter-divider" data-testid="chapter-divider">
                <span>
                  {t('A new chapter')} · {new Date(item.createdAt).toLocaleString(language() === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {item.chapter.reason === 'idle' ? ` · ${t('after a long pause')}` : item.chapter.reason === 'long' ? ` · ${t('after a long stretch')}` : ''}
                </span>
              </div>
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
            <div
              key={item.id}
              className={`msg ${item.role}`}
              data-role={item.role}
              data-item-id={item.id}
              onContextMenu={
                item.role === 'user' || item.role === 'assistant'
                  ? (e) => {
                      // Copy takes the text selected in this message, else the whole message.
                      const sel = window.getSelection();
                      const picked = sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode) ? sel.toString() : '';
                      const text = picked || item.text;
                      menu.open(
                        menuAt(
                          e,
                          [
                            item.role === 'user' && item.via !== 'main' && { id: 'remember', label: t('Keep as memory…'), icon: 'remember' as const, onSelect: () => setRemember(item.id) },
                            !!text.trim() && { id: 'copy', label: picked ? t('Copy selection') : t('Copy'), icon: 'copy' as const, onSelect: () => void navigator.clipboard.writeText(text).catch(() => {}) },
                          ],
                          'message-menu',
                        ),
                      );
                    }
                  : undefined
              }
            >
              {item.role === 'user' ? <div className="msg-via">
                  {item.via === 'main' ? t('Main agent') : t('You')}
                  {item.via === 'voice' ? ` · ${t('voice')}` : item.via === 'card' ? ` · ${t('from tile')}` : item.via === 'main' ? ` · ${t('on your behalf')}` : ''}
                  {item.delivery === 'steer' ? <span className="delivery-tag">{t('added mid-turn')}</span> : null}
                  {item.delivery === 'interrupt' ? <span className="delivery-tag interrupt">{t('stopped the turn')}</span> : null}
                  {/* What the user said themselves can become memory (not what the main agent relayed). */}
                  {item.via !== 'main' ? <RememberButton onClick={() => setRemember(item.id)} /> : null}
                </div> : null}
              {item.role === 'user' && item.images?.length ? <MessageImages images={item.images} /> : null}
              {item.role === 'user' && !item.text.trim() && item.images?.length ? null : item.role === 'system' && item.memoryUpdate?.length ? (
                <details className="msg-system memory-sent" data-testid="memory-sent">
                  <summary>
                    <Icon name="spark" size={11} /> {t('Memory sent with this message: {n}', { n: item.memoryUpdate.length })}
                  </summary>
                  <ul>
                    {item.memoryUpdate.map((b, i) => (
                      <li key={i} className={b.startsWith('✕ ') ? 'gone' : ''}>
                        {b.startsWith('✕ ') ? `${t('No longer applies')}: ${b.slice(2)}` : b}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : item.role === 'system' ? (
                <div className="msg-system">{systemText(item.text)}</div>
              ) : (
                <Markdown text={item.text} streaming={item.streaming} mentions={item.role === 'user'} />
              )}
              {item.streaming ? <span className="cursor" aria-hidden /> : null}
            </div>
          );
          };
  return (
    <>
    {finding ? <FindBar scope={inner} version={items} onClose={() => setFinding(false)} onJump={() => (stick.current = false)} /> : null}
    <div
      className="transcript"
      ref={ref}
      data-testid="transcript"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
    >
      <div className="transcript-inner" ref={inner}>
        {items.length === 0 ? <div className="muted pad">{t('No messages yet.')}</div> : null}
        {turns.map((turn, i) => {
          const entries = (list: TranscriptItem[]) => groupNotices(groupTranscript(list, main), main).map(renderEntry);
          if (!foldsTurn(turn, i, turns.length, snapshot.settings.openTurns ?? OPEN_TURNS)) return <Fragment key={turn.user?.id ?? `t${i}`}>{entries([...(turn.user ? [turn.user] : []), ...turn.steps, ...(turn.final ? [turn.final] : [])].sort((x, y) => order.get(x.id)! - order.get(y.id)!))}</Fragment>;
          // An earlier turn: the message, what the agent did folded into one line, and its answer.
          return (
            <Fragment key={turn.user?.id ?? `t${i}`}>
              {turn.user ? renderEntry(turn.user) : null}
              <details className="turn-fold" data-testid="turn-fold">
                <summary>
                  <Icon name="chevron" size={11} />
                  <span>{turnSummary(turn)}</span>
                  {turn.steps.some((x) => x.toolStatus === 'failed') ? <span className="turn-fold-failed" aria-hidden /> : null}
                </summary>
                <div className="turn-steps">{entries(turn.steps)}</div>
              </details>
              {turn.final ? renderEntry(turn.final) : null}
            </Fragment>
          );
        })}
      </div>
      {menu.element}
      {remember ? <RememberDialog task={task} itemId={remember} snapshot={snapshot} onClose={() => setRemember(null)} /> : null}
    </div>
    </>
  );
});

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

function Composer({
  task,
  onBtw,
  btwCount = 0,
  inject,
  about,
  onClearAbout,
  side,
  under,
}: {
  task: Task;
  /** Beside the box, outside it on the right, level with its bottom (the context used). */
  side?: ReactNode;
  /** Shown under the box, on the right (the account's limits, when close). */
  under?: ReactNode;
  onBtw?: (question: string) => void;
  btwCount?: number;
  inject?: { text: string; n: number };
  /** The request the message is likely about (unfolded above): sent along as a hint, shown here. */
  about?: { id: string; alias: string; headline: string };
  onClearAbout?: () => void;
}) {
  // The unsent message is the agent's, not the box's: it is still there after the Overview or another
  // agent, and the agent's Overview tile shows the same text.
  const [draft, setDraft] = useDraft(task.taskId);
  const box = useRef<HTMLTextAreaElement>(null);
  // Back to a message left half-written: ready to go on where it ended.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !el.value) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  /** The bubble pressed with nothing typed and nothing asked yet: say how, in the box, for a moment. */
  const [btwHint, setBtwHint] = useState(false);
  // Text handed back from elsewhere (a side answer brought into the conversation): into the box to edit.
  // Only text handed back while this box is shown: the box is made anew for each agent, and an
  // answer brought into one agent's conversation earlier must not land in the next agent's box.
  const injected = useRef(inject?.n ?? 0);
  useEffect(() => {
    if (!inject?.text || inject.n === injected.current) return;
    injected.current = inject.n;
    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${inject.text}` : inject.text));
  }, [inject?.n]);
  // What is being said on this page shows here as it is transcribed (the voice bar has no box of
  // its own on an agent's page). `base` is what was typed before; the spoken part follows it.
  const [voice, setVoiceState] = useState<string | null>(null);
  const voiceRef = useRef<string | null>(null);
  const setVoice = (v: string | null) => {
    voiceRef.current = v;
    setVoiceState(v);
  };
  const base = useRef('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const join = (a: string, b: string) => (a.trim() && b ? `${a.trimEnd()} ${b}` : a || b);
    const onDraft = (ev: Event) => {
      const { taskId, text, phase } = (ev as CustomEvent<{ taskId: string; text: string; phase: 'listening' | 'keep' | 'drop' }>).detail;
      if (taskId !== task.taskId) return;
      // A new spoken draft starts after whatever is in the box now.
      if (voiceRef.current === null) base.current = draftRef.current;
      if (phase === 'listening') {
        setVoice(text);
        setDraft(join(base.current, text));
        return;
      }
      // Kept: it is part of the message now, to check and send. Dropped: back to what was typed.
      setVoice(null);
      setDraft(phase === 'keep' ? join(base.current, text) : base.current);
      if (phase === 'keep') box.current?.focus();
    };
    window.addEventListener('amw:voice-draft', onDraft);
    return () => window.removeEventListener('amw:voice-draft', onDraft);
  }, [task.taskId]);
  /** Typing into, or sending, a box that holds a spoken draft takes it over: it is not sent again. */
  const takeVoice = () => {
    if (voiceRef.current === null) return;
    setVoice(null);
    window.dispatchEvent(new CustomEvent('amw:voice-taken', { detail: { taskId: task.taskId } }));
  };
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  // Images pasted, dropped or picked go with the next message (the main agent passes them on when the work is about them).
  // @ lists the files in the agent's folder (the main agent has none: only @~/ and @/ browse there).
  const mention = useMentions(task.taskId, box, draft, setDraft, { browseOnly: isMainAgent(task) });
  // Other files dropped here are mentioned with @, as if picked from the list.
  const attach = useAttachments(async (files) => {
    const text = await dropMentions(task.taskId, files);
    if (text) mention.insert(text);
    box.current?.focus();
  }, task.taskId);
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
    const images = shell ? [] : attach.refs;
    if ((!text && !images.length) || sending || attach.busy) return;
    takeVoice();
    if (onBtw && /^\/btw\b/i.test(text)) return btw();
    setSending(true);
    setError('');
    try {
      const command = text.slice(1).trim();
      if (shell && !command) return;
      // A command can run for a while (its row shows it running): the box is free at once, and
      // gets the command back if it could not run.
      if (shell) setDraft('');
      const r = shell
        ? await call('task:shell', { taskId: task.taskId, command })
        : await call('task:send', { taskId: task.taskId, text, via: 'text', interrupt, ...(images.length ? { images } : {}), ...(about ? { about: about.id } : {}) });
      if (r.ok) {
        if (!shell) {
          setDraft('');
          attach.clear();
        }
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
      {about ? (
        <div className="composer-about" data-testid="composer-about">
          <span className="composer-about-label">{t('About {name}’s request', { name: about.alias })}</span>
          <span className="composer-about-text">{about.headline}</span>
          <button className="composer-about-clear" onClick={onClearAbout} aria-label={t('Not about this request')} title={t('Not about this request')} data-testid="composer-about-clear">
            <Icon name="x" size={11} />
          </button>
        </div>
      ) : null}
      <MentionMenu m={mention} />
      <div
        className={`composer-box${shell ? ' shell-mode' : ''}${suggestion ? ' has-suggestion' : ''}${voice !== null ? ' voice-live' : ''}${attach.dragging ? ' dropping' : ''}`}
        data-voice={voice !== null || undefined}
        {...attach.dropProps}
      >
        <AttachmentStrip items={attach.items} busy={attach.busy} onRemove={attach.remove} />
        <div className="composer-field">
        <MentionHighlight text={draft} box={box} />
        <textarea
          ref={box}
          className="composer-input"
          rows={3}
          // A new agent with nothing asked yet: ready for its first message.
          autoFocus={!task.title.trim()}
          value={draft}
          placeholder={btwHint ? t('Type a side question, then ⌥↵') : suggestion || t('Message {alias}…', { alias: isMainAgent(task) ? t('Main agent') : task.alias })}
          onChange={(e) => {
            takeVoice();
            setDraft(e.target.value);
          }}
          data-testid="composer-input"
          data-suggestion={suggestion || undefined}
          onPaste={attach.onPaste}
          onSelect={mention.update}
          onKeyDown={(e) => {
            if (mention.onKeyDown(e) || mention.onBackspace(e)) return;
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
        </div>
        <div className="composer-foot">
          {/* The mic, on an agent's page: here, like the buttons on the right (VoiceDock renders into it). */}
          <span id="composer-voice" className="composer-voice" />
          {!shell ? <AttachButton onFiles={(files) => void attach.add(files)} /> : null}
          <span className="to-label" data-testid="composer-target">
            {shell ? (
              <>
                {t('Command')} · {task.host ?? t('Local')}
                <span className="muted">
                  {' '}
                  — {task.provider === 'codex' ? t('runs in {dir} through Codex, which sees the output', { dir: task.cwd }) : t('runs in {dir}; {alias} sees the output with your next message', { dir: task.cwd, alias: task.alias })}
                </span>
              </>
            ) : (
              <>
                {t('To: {alias}', { alias: isMainAgent(task) ? t('Main agent') : task.alias })} · {PROVIDER_LABEL[task.provider]}
              </>
            )}
          </span>
          <span className="hint" data-testid="composer-hint">
            {suggestion ? (
              <>
                <Kbd>→</Kbd> {t('use suggestion')}{shell || working ? ' · ' : ''}
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
            ) : null}
          </span>
          {working && !shell ? (
            <button className="btn btn-sm" disabled={(!draft.trim() && !attach.items.length) || sending || attach.busy} onClick={() => void send(true)} title={t('Stop the current turn and start over with this message')} data-testid="send-interrupt">
              {t('Stop & send')}
            </button>
          ) : null}
          {onBtw && !shell ? (
            <button className="btw-btn" aria-label={t('Side question')} data-tip={t('Side question (⌥↵): not part of the conversation, interrupts nothing')} onClick={btw} data-testid="btw-send">
              <Icon name="btw" />
            </button>
          ) : null}
          <button className="send-btn" aria-label={t('Send')} disabled={(!draft.trim() && !(attach.items.length && !shell)) || sending || attach.busy} onClick={() => void send()}>
            <Icon name="send" />
          </button>
        </div>
        {side ? <div className="composer-side">{side}</div> : null}
      </div>
      {under ? <div className="composer-under">{under}</div> : null}
      {error || attach.error ? <div className="error-text">{error || attach.error}</div> : null}
    </div>
  );
}

/** The provider's tag; it carries the native session id (in its tooltip; a click copies it). */
function SessionTag({ provider, id, mode }: { provider: Task['provider']; id?: string; mode?: string }) {
  const [copied, setCopied] = useState(false);
  if (!id) return <ProviderTag provider={provider} />;
  return (
    <button
      className="session-tag"
      data-testid="session-tag"
      title={`${copied ? t('Copied') : t('Session {id} · click to copy', { id })}${mode === 'resumed' ? ` · ${t('resumed')}` : ''}`}
      onClick={() => {
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <ProviderTag provider={provider} />
    </button>
  );
}
