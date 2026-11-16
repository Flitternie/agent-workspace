import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AttentionItem, MemoryRecord, PermissionMode, Task, TranscriptItem, WorkspaceSnapshot } from '../../shared/types';
import { PERMISSION_MODES } from './Settings';
import { memorySourceText } from './MemorySettings';
import { call, errorText } from '../api';
import { AttentionView } from './AttentionView';
import { groupTranscript, PlanChecklist, PreviewContext, ToolCallRow, ToolGroup } from './Content';
import { FilePreviewPanel } from './FilePreview';
import { AgentName, Alias, displayName, Icon, isMainAgent, Kbd, PROVIDER_LABEL, ProviderTag, StatusDot, systemText, warningText } from './bits';
import { Markdown } from './Markdown';
import { AgentMemoryPanel, MemoryChip, RememberButton, RememberDialog, RememberMenu } from './SessionMemory';
import { RetryNotice } from './Retry';
import { ForkDialog } from './Dialogs';
import { t } from '../i18n';

export function FocusView({ snapshot, task, transcript, now, onOpen }: { snapshot: WorkspaceSnapshot; task: Task; transcript: TranscriptItem[]; now: number; onOpen?: (taskId: string) => void }) {
  // Completion reports duplicate the last transcript message here; only show what needs a decision.
  const items = snapshot.attention.filter((a) => a.taskId === task.taskId && a.state === 'open' && a.kind !== 'completion');
  const connected = snapshot.connectedTaskIds.includes(task.taskId);
  const session = snapshot.sessions.find((s) => s.localId === task.sessionLocalId);
  const project = snapshot.projects.find((p) => p.projectId === task.projectId);
  // Closed by default; once opened it stays open for every agent.
  // A file preview takes the Memory column while open; closing it brings Memory back if it was on.
  const [preview, setPreview] = useState<string | null>(null);
  // The side column shows one thing: a file preview (it wins when opened) or this agent's memory.
  const [memoryOpen, setMemoryOpen] = useState(false);
  const side: 'file' | 'memory' | null = preview ? 'file' : memoryOpen ? 'memory' : null;
  // Its frame, the same for whatever it shows: width dragged by the user (kept for next
  // time), and maximized over the conversation until restored (Esc) or closed.
  const [sideWidth, setSideWidthState] = useState(() => Number(localStorage.getItem('amw.previewWidth')) || PREVIEW_WIDTH);
  const setSideWidth = (w: number) => {
    setSideWidthState(w);
    localStorage.setItem('amw.previewWidth', String(Math.round(w)));
  };
  const [sideMax, setSideMax] = useState(false);
  useEffect(() => {
    if (!side) setSideMax(false);
  }, [side]);
  useEffect(() => {
    if (!sideMax) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setSideMax(false);
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [sideMax]);
  const closeSide = () => (side === 'file' ? setPreview(null) : setMemoryOpen(false));
  const frame = { width: sideWidth, maximized: sideMax, onToggleMax: () => setSideMax(!sideMax), onClose: closeSide };
  useEffect(() => setPreview(null), [task.taskId]);
  const [forking, setForking] = useState(false);
  // Claude Code conversations on this Mac (and the demo's mock agents) can be forked once saved.
  const canFork = !isMainAgent(task) && !task.host && (task.provider === 'claude' || task.provider === 'mock') && !!session?.nativeSessionId;
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e) => setError(errorText(e)));
  };
  // "Open in default app" only for files on this Mac.
  const openExternal = task.host ? undefined : (path: string) => run(() => call('file:open', { taskId: task.taskId, path }));

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
              <TaskName task={task} /> <ProviderTag provider={task.provider} /> <StatusDot status={task.status} connected={connected} />
            </div>
            <div className="focus-meta mono">
              <MemoryChip snapshot={snapshot} task={task} open={side === 'memory'} onToggle={() => (setMemoryOpen(side !== 'memory'), setPreview(null))} />
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
            </div>
          </div>
          <div className="focus-actions">
            {isMainAgent(task) ? null : (
            <select
              className="input select perm-select"
              value={task.permissionMode ?? snapshot.settings.permissionMode ?? 'auto'}
              title={t('Permissions')}
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
            )}
            {task.status === 'running' && connected ? (
              <button className="btn" onClick={() => run(() => call('task:interrupt', { taskId: task.taskId }))}>
                <Icon name="pause" /> {t('Interrupt')}
              </button>
            ) : null}
            {!connected ? (
              <button className="btn" onClick={() => run(() => call('task:resume', { taskId: task.taskId }))} title={t('Re-enter the provider-persisted conversation. This does not attach to a process running elsewhere.')}>
                <Icon name="play" /> {session?.nativeSessionId ? t('Resume session') : t('Start session')}
              </button>
            ) : (
              <button className="btn" onClick={() => run(() => call('task:stop', { taskId: task.taskId }))}>
                <Icon name="power" /> {t('Stop')}
              </button>
            )}
            {canFork ? (
              <button
                className="btn"
                data-testid="fork-task"
                disabled={task.status === 'running' || task.status === 'starting'}
                onClick={() => setForking(true)}
                title={
                  task.status === 'running' || task.status === 'starting'
                    ? t('Fork once this turn ends.')
                    : t('Start a new agent from a copy of this conversation, now or from an earlier prompt.')
                }
              >
                <Icon name="branch" /> {t('Fork')}
              </button>
            ) : null}
            {isMainAgent(task) ? null : (
            <button
              className="btn"
              data-testid="remove-task"
              title={t('Stop the agent and remove it from the workspace. A worktree with uncommitted changes is kept on disk.')}
              onClick={() => {
                if (window.confirm(t('Remove {name}? A worktree with uncommitted changes is kept on disk.', { name: displayName(task) }))) run(() => call('task:remove', { taskId: task.taskId }));
              }}
            >
              {t('Remove')}
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
        {forking ? <ForkDialog snapshot={snapshot} task={task} onClose={() => setForking(false)} onForked={(id) => onOpen?.(id)} /> : null}

        <div className="focus-body">
          {/* Kept mounted while the preview is maximized, so the conversation keeps its place. */}
          <div className="focus-thread" hidden={!!side && sideMax}>
            {isMainAgent(task) ? <WaitingOnYou snapshot={snapshot} now={now} onOpen={onOpen} /> : null}
            <PreviewContext.Provider value={{ preview: setPreview, openExternal }}>
              <Transcript items={transcript} main={isMainAgent(task)} task={task} snapshot={snapshot} />
            </PreviewContext.Provider>
            {/* Requests wait at the end of the conversation, where the agent asked, above the reply box. */}
            {items.length || task.retry ? (
              <div className="focus-attention" data-testid="focus-attention">
                {task.retry ? <RetryNotice retry={task.retry} /> : null}
                {items.map((i) => (
                  <AttentionView key={i.id} item={i} task={task} now={now} compact shown={i.kind !== 'approval' && saidLast(transcript, i)} />
                ))}
              </div>
            ) : null}
            {task.plan ? (
              <div className="pinned-plan">
                <PlanChecklist plan={task.plan} />
              </div>
            ) : null}
            <Composer task={task} />
          </div>
          {/* One side column, one frame (width, maximize, close): a file preview, or this agent's memory. */}
          {side ? (
            <>
              {sideMax ? null : <PanelResizer width={sideWidth} onChange={setSideWidth} />}
              {side === 'file' ? (
                <FilePreviewPanel task={task} path={preview!} transcript={transcript} frame={frame} onOpenExternal={openExternal && (() => openExternal(preview!))} />
              ) : (
                <AgentMemoryPanel snapshot={snapshot} task={task} frame={frame} />
              )}
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

const PREVIEW_WIDTH = 460;

/** The bar between the conversation and the preview: drag to resize, double-click for the default width. */
function PanelResizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
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
        const body = bar.parentElement!.getBoundingClientRect();
        const startX = e.clientX;
        const startW = width;
        bar.setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
        const move = (ev: PointerEvent) => {
          // Room for the conversation stays; the preview never gets too narrow to read.
          const max = Math.max(320, body.width - 380);
          onChange(Math.min(max, Math.max(280, startW + (startX - ev.clientX))));
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

/** Whether the agent's latest message already says what this request says. */
function saidLast(transcript: TranscriptItem[], a: AttentionItem): boolean {
  const said = transcript.findLast((i) => i.role === 'assistant')?.text.replace(/\s+/g, ' ') ?? '';
  const asked = (a.details || a.headline).replace(/\s+/g, ' ').trim();
  return !!asked && said.includes(asked);
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

function Transcript({ items, main, task, snapshot }: { items: TranscriptItem[]; main?: boolean; task: Task; snapshot: WorkspaceSnapshot }) {
  const ref = useRef<HTMLDivElement>(null);
  // "Keep as memory" on one of the user's messages: the dialog, and the right-click menu that opens it.
  const [remember, setRemember] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; itemId: string } | null>(null);
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
            <div
              key={item.id}
              className={`msg ${item.role}`}
              data-role={item.role}
              onContextMenu={
                item.role === 'user' && item.via !== 'main'
                  ? (e) => {
                      // Selected text keeps the system menu (copy); otherwise ours.
                      if (window.getSelection()?.toString()) return;
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, itemId: item.id });
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
              {item.role === 'system' ? <div className="msg-system">{systemText(item.text)}</div> : <Markdown text={item.text} streaming={item.streaming} />}
              {item.streaming ? <span className="cursor" aria-hidden /> : null}
            </div>
          );
        })}
      </div>
      {menu ? <RememberMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} onRemember={() => (setRemember(menu.itemId), setMenu(null))} /> : null}
      {remember ? <RememberDialog task={task} itemId={remember} snapshot={snapshot} onClose={() => setRemember(null)} /> : null}
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

function Composer({ task }: { task: Task }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  // While the agent works, Enter adds to what it is doing (read at its next step);
  // ⌘Enter stops the current turn and starts over with this message.
  const working = task.status === 'running' || task.status === 'starting';
  // `!command` runs a command in the agent's folder, as in the CLIs.
  const shell = draft.trimStart().startsWith('!') && !isMainAgent(task);
  const suggestion = !draft && task.suggestion ? task.suggestion : '';
  const send = async (interrupt = false) => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      const command = text.slice(1).trim();
      if (shell && !command) return;
      const r = shell ? await call('task:shell', { taskId: task.taskId, command }) : await call('task:send', { taskId: task.taskId, text, via: 'text', interrupt });
      if (r.ok) setDraft('');
      else setError(r.error ?? t('Not delivered'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="composer">
      <div className={`composer-box${shell ? ' shell-mode' : ''}${suggestion ? ' has-suggestion' : ''}`}>
        <textarea
          className="composer-input"
          rows={3}
          value={draft}
          placeholder={suggestion || t('Message {alias}…', { alias: isMainAgent(task) ? t('Main agent') : task.alias })}
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
          </span>
          {working && !shell ? (
            <button className="btn btn-sm" disabled={!draft.trim() || sending} onClick={() => void send(true)} title={t('Stop the current turn and start over with this message')} data-testid="send-interrupt">
              {t('Stop & send')}
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

