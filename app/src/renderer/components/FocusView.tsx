import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MemoryRecord, Task, TranscriptItem, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { AttentionView } from './AttentionView';
import { Alias, displayName, Icon, Kbd, Markdown, PROVIDER_LABEL, ProviderTag, StatusDot } from './bits';

export function FocusView({ snapshot, task, transcript, now }: { snapshot: WorkspaceSnapshot; task: Task; transcript: TranscriptItem[]; now: number }) {
  // Completion reports duplicate the last transcript message here; only show what needs a decision.
  const items = snapshot.attention.filter((a) => a.taskId === task.taskId && a.state === 'open' && a.kind !== 'completion');
  const connected = snapshot.connectedTaskIds.includes(task.taskId);
  const session = snapshot.sessions.find((s) => s.localId === task.sessionLocalId);
  const project = snapshot.projects.find((p) => p.projectId === task.projectId);
  const [showMemory, setShowMemory] = useState(true);
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e) => setError(errorText(e)));
  };

  return (
    <div className="focus">
      <section className="focus-main">
        <header className="focus-head drag">
          <Alias alias={task.alias} size="lg" />
          <div className="focus-ident">
            <div className="focus-name">
              <TaskName task={task} /> <ProviderTag provider={task.provider} /> <StatusDot status={task.status} connected={connected} />
            </div>
            <div className="focus-meta mono">
              <span className="truncate" title={task.title}>
                {task.title}
              </span>
              <span title={task.cwd}>
                <Icon name="folder" size={12} /> {project?.name}
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
              {task.injectedMemoryIds?.length ? <span>{task.injectedMemoryIds.length} memory note(s) loaded</span> : null}
            </div>
          </div>
          <div className="focus-actions">
            {task.status === 'running' && connected ? (
              <button className="btn" onClick={() => run(() => call('task:interrupt', { taskId: task.taskId }))}>
                <Icon name="pause" /> Interrupt
              </button>
            ) : null}
            {!connected ? (
              <button className="btn" onClick={() => run(() => call('task:resume', { taskId: task.taskId }))} title="Re-enter the provider-persisted conversation. This does not attach to a process running elsewhere.">
                <Icon name="play" /> {session?.nativeSessionId ? 'Resume session' : 'Start session'}
              </button>
            ) : (
              <button className="btn" onClick={() => run(() => call('task:stop', { taskId: task.taskId }))}>
                <Icon name="power" /> Stop
              </button>
            )}
            <button className={`btn${showMemory ? ' btn-pressed' : ''}`} onClick={() => setShowMemory(!showMemory)} aria-pressed={showMemory}>
              <Icon name="note" /> Memory
            </button>
          </div>
        </header>
        {task.sharedCwdWarning ? (
          <div className="warn-text pad">
            <Icon name="alert" size={12} /> {task.sharedCwdWarning}
          </div>
        ) : null}
        {error ? <div className="error-text pad">{error}</div> : null}

        <div className="focus-body">
          <div className="focus-thread">
            {items.length ? (
              <div className="focus-attention" data-testid="focus-attention">
                {items.map((i) => (
                  <AttentionView key={i.id} item={i} task={task} now={now} />
                ))}
              </div>
            ) : null}
            <Transcript items={transcript} />
            <Composer task={task} />
          </div>
          {showMemory ? <MemoryPanel snapshot={snapshot} task={task} /> : null}
        </div>
      </section>
    </div>
  );
}

function TaskName({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(task.name);
  useEffect(() => setName(task.name), [task.name]);
  if (!editing)
    return (
      <span className="task-name" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
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

function Transcript({ items }: { items: TranscriptItem[] }) {
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
        {items.length === 0 ? <div className="muted pad">No messages yet. Type below to give this agent its first instruction.</div> : null}
        {items.map((item) =>
          item.role === 'tool' ? (
            <details key={item.id} className={`msg tool tool-${item.toolStatus ?? 'completed'}`}>
              <summary>
                <span className="tool-status">{toolIcon(item.toolStatus)}</span>
                <span className="tool-label">{item.toolLabel ?? 'Tool'}</span>
              </summary>
              {item.text ? <pre>{item.text}</pre> : null}
            </details>
          ) : (
            <div key={item.id} className={`msg ${item.role}`} data-role={item.role}>
              {item.role === 'user' ? <div className="msg-via">You{item.via === 'voice' ? ' · voice' : item.via === 'card' ? ' · from tile' : ''}</div> : null}
              {item.role === 'system' ? <div className="msg-system">{item.text}</div> : <Markdown text={item.text} />}
              {item.streaming ? <span className="cursor" aria-hidden /> : null}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function toolIcon(s?: TranscriptItem['toolStatus']): string {
  return s === 'running' ? '…' : s === 'failed' ? '✕' : s === 'declined' ? '⊘' : s === 'interrupted' ? '◼' : '✓';
}

function Composer({ task }: { task: Task }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      const r = await call('task:send', { taskId: task.taskId, text, via: 'text' });
      if (r.ok) setDraft('');
      else setError(r.error ?? 'Not delivered');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          className="composer-input"
          rows={3}
          value={draft}
          placeholder={`Message Agent ${task.alias}…`}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="composer-input"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-foot">
          <span className="to-label" data-testid="composer-target">
            To: Agent {task.alias} · {PROVIDER_LABEL[task.provider]}
            <span className="muted"> — typed text goes only to this agent</span>
          </span>
          <span className="hint">
            <Kbd>↵</Kbd> send · <Kbd>⇧↵</Kbd> new line
          </span>
          <button className="send-btn" aria-label="Send" disabled={!draft.trim() || sending} onClick={() => void send()}>
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
    { title: `This task`, records: mem.filter((m) => m.scope === 'task' && m.scopeId === task.taskId), hint: 'Private to Agent ' + task.alias },
    { title: `Project · ${project?.name ?? ''}`, records: mem.filter((m) => m.scope === 'project' && m.scopeId === task.projectId), hint: 'Approved notes load into new sessions here' },
    { title: 'Global', records: mem.filter((m) => m.scope === 'global'), hint: 'Approved notes load into every new session' },
  ];
  const run = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e) => setError(errorText(e)));
  };
  return (
    <aside className="memory" aria-label="Scoped memory" data-testid="memory-panel">
      <div className="panel-title">Memory</div>
      <p className="muted small">App-owned notes. They never rewrite a running session.</p>
      <div className="memory-add">
        <textarea className="input" rows={2} placeholder="Add a note for this task…" value={draft} onChange={(e) => setDraft(e.target.value)} />
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
          Add note
        </button>
      </div>
      {error ? <div className="error-text">{error}</div> : null}
      {groups.map((g) => (
        <div key={g.title} className="memory-group">
          <div className="section-label" title={g.hint}>
            {g.title}
            <span className="count-muted">{g.records.length}</span>
          </div>
          {g.records.length === 0 ? <div className="muted small">{g.hint}.</div> : null}
          {g.records.map((m) => (
            <div key={m.id} className="memory-record" data-testid="memory-record" data-scope={m.scope}>
              <div className="memory-body">{m.body}</div>
              <div className="memory-meta">
                {m.source}
                {m.originTaskId ? ` · from ${snapshot.tasks.find((t) => t.taskId === m.originTaskId)?.alias ?? 'removed task'}` : ''}
                {task.injectedMemoryIds?.includes(m.id) ? ' · loaded in this session' : ''}
              </div>
              <div className="memory-actions">
                {m.scope !== 'task' ? (
                  <label className="small check">
                    <input type="checkbox" checked={m.approvedForReuse} onChange={(e) => run(() => call('memory:update', { id: m.id, approvedForReuse: e.target.checked }))} /> approved for reuse
                  </label>
                ) : null}
                {m.scope === 'task' ? (
                  <button className="link" onClick={() => run(() => call('memory:promote', { id: m.id, scope: 'project' }))}>
                    Share with project
                  </button>
                ) : null}
                {m.scope !== 'global' ? (
                  <button className="link" onClick={() => run(() => call('memory:promote', { id: m.id, scope: 'global' }))}>
                    Save as global
                  </button>
                ) : null}
                <button className="link danger" onClick={() => run(() => call('memory:delete', { id: m.id }))}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}
