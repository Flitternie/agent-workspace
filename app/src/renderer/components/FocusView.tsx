import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AttentionItem, MemoryRecord, PermissionMode, Task, TranscriptItem, WorkspaceSnapshot } from '../../shared/types';
import { PERMISSION_MODES } from './Settings';
import { call, errorText } from '../api';
import { AttentionView } from './AttentionView';
import { groupTranscript, PlanChecklist, PreviewContext, ToolCallRow, ToolGroup } from './Content';
import { FilePreviewPanel } from './FilePreview';
import { Alias, displayName, Icon, isMainAgent, Kbd, PROVIDER_LABEL, ProviderTag, StatusDot, systemText } from './bits';
import { Markdown } from './Markdown';
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
  const [showMemory, setShowMemoryState] = useState(() => localStorage.getItem('amw.showMemory') === '1');
  const setShowMemory = (on: boolean) => {
    localStorage.setItem('amw.showMemory', on ? '1' : '0');
    setShowMemoryState(on);
  };
  // A file preview takes the Memory column while open; closing it brings Memory back if it was on.
  const [preview, setPreview] = useState<string | null>(null);
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
            <button
              className={`btn${showMemory && !preview ? ' btn-pressed' : ''}`}
              onClick={() => {
                if (preview) setShowMemory(true);
                else setShowMemory(!showMemory);
                setPreview(null);
              }}
              aria-pressed={showMemory && !preview}
            >
              <Icon name="note" /> {t('Memory')}
            </button>
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
            <Icon name="alert" size={12} /> {task.sharedCwdWarning}
          </div>
        ) : null}
        {error ? <div className="error-text pad">{error}</div> : null}
        {forking ? <ForkDialog snapshot={snapshot} task={task} onClose={() => setForking(false)} onForked={(id) => onOpen?.(id)} /> : null}

        <div className="focus-body">
          <div className="focus-thread">
            {isMainAgent(task) ? <WaitingOnYou snapshot={snapshot} now={now} onOpen={onOpen} /> : null}
            <PreviewContext.Provider value={{ preview: setPreview, openExternal }}>
              <Transcript items={transcript} main={isMainAgent(task)} />
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
          {preview ? (
            <FilePreviewPanel task={task} path={preview} transcript={transcript} onClose={() => setPreview(null)} onOpenExternal={openExternal && (() => openExternal(preview))} />
          ) : showMemory ? (
            <MemoryPanel snapshot={snapshot} task={task} />
          ) : null}
        </div>
      </section>
    </div>
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
                <span className="waiting-row-name">{displayName(worker)}</span>
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
              <Alias alias={worker.alias} size="sm" /> {displayName(worker)}
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
        {displayName(task)}
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
