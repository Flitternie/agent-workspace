import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AttentionItem, MemoryRecord, Task, TranscriptItem, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { AttentionView } from './AttentionView';
import { Alias, Markdown, PROVIDER_LABEL, ProviderBadge, StatusPill } from './bits';

export function FocusView({
  snapshot,
  task,
  transcript,
  onSelect,
  onBack,
  now,
}: {
  snapshot: WorkspaceSnapshot;
  task: Task;
  transcript: TranscriptItem[];
  onSelect: (taskId: string) => void;
  onBack: () => void;
  now: number;
}) {
  const open = (taskId: string) => snapshot.attention.filter((a) => a.taskId === taskId && a.state === 'open');
  // Completion reports duplicate the last transcript message here; only show what needs a decision.
  const items = open(task.taskId).filter((a) => a.kind !== 'completion');
  const connected = snapshot.connectedTaskIds.includes(task.taskId);
  const session = snapshot.sessions.find((s) => s.localId === task.sessionLocalId);
  const project = snapshot.projects.find((p) => p.projectId === task.projectId);
  const [error, setError] = useState('');
  const run = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e) => setError(errorText(e)));
  };

  return (
    <div className="focus">
      <nav className="rail" aria-label="Other agents">
        <button className="btn rail-back" onClick={onBack}>
          ← Overview
        </button>
        {snapshot.tasks.map((t) => {
          const pending = open(t.taskId).filter((a) => a.kind !== 'completion');
          return (
            <button
              key={t.taskId}
              className={`rail-item status-${t.status}${t.taskId === task.taskId ? ' active' : ''}${pending.length ? ' needs' : ''}`}
              onClick={() => onSelect(t.taskId)}
              data-testid="rail-item"
              data-alias={t.alias}
            >
              <Alias alias={t.alias} size="sm" />
              <span className="rail-text">
                <span className="rail-name">{t.name !== t.alias ? t.name : t.title}</span>
                <span className="rail-sub">{pending.length ? `${pending.length} waiting: ${pending[0].headline}` : t.summary}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <section className="focus-main">
        <header className="focus-head">
          <Alias alias={task.alias} size="lg" />
          <div className="focus-ident">
            <div className="focus-name">
              <TaskName task={task} /> <ProviderBadge provider={task.provider} /> <StatusPill status={task.status} connected={connected} />
            </div>
            <div className="focus-title">{task.title}</div>
            <div className="focus-meta">
              {project?.name} · <span title={task.cwd}>{task.worktree ? `worktree ${task.worktree.branch}` : task.cwd}</span>
              {session?.nativeSessionId ? (
                <>
                  {' '}
                  · {session.integrationMode} session <code>{session.nativeSessionId.slice(0, 13)}…</code>
                </>
              ) : null}
              {task.injectedMemoryIds?.length ? ` · ${task.injectedMemoryIds.length} memory note(s) loaded` : ''}
            </div>
            {task.sharedCwdWarning ? <div className="warn-text">⚠ {task.sharedCwdWarning}</div> : null}
          </div>
          <div className="focus-actions">
            {task.status === 'running' && connected ? (
              <button className="btn" onClick={() => run(() => call('task:interrupt', { taskId: task.taskId }))}>
                Interrupt
              </button>
            ) : null}
            {!connected ? (
              <button className="btn" onClick={() => run(() => call('task:resume', { taskId: task.taskId }))} title="Re-enter the provider-persisted conversation. This does not attach to a process running elsewhere.">
                {session?.nativeSessionId ? 'Resume session' : 'Start session'}
              </button>
            ) : (
              <button className="btn" onClick={() => run(() => call('task:stop', { taskId: task.taskId }))}>
                Stop
              </button>
            )}
          </div>
        </header>
        {error ? <div className="error-text pad">{error}</div> : null}

        {items.length ? (
          <div className="focus-attention" data-testid="focus-attention">
            {items.map((i) => (
              <AttentionView key={i.id} item={i} task={task} now={now} />
            ))}
          </div>
        ) : null}

        <Transcript items={transcript} />
        <Composer task={task} />
      </section>

      <MemoryPanel snapshot={snapshot} task={task} />
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
        {task.name !== task.alias ? task.name : `Agent ${task.alias}`}
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
      {items.length === 0 ? <div className="muted pad">No messages yet. Type below to give this agent its first instruction.</div> : null}
      {items.map((item) =>
        item.role === 'tool' ? (
          <details key={item.id} className={`msg tool tool-${item.toolStatus ?? 'completed'}`}>
            <summary>
              <span className="tool-status">{toolIcon(item.toolStatus)}</span> {item.toolLabel ?? 'Tool'}
            </summary>
            {item.text ? <pre>{item.text}</pre> : null}
          </details>
        ) : (
          <div key={item.id} className={`msg ${item.role}`} data-role={item.role}>
            {item.role === 'user' ? <div className="msg-via">You{item.via === 'voice' ? ' · voice' : item.via === 'card' ? ' · from card' : ''}</div> : null}
            {item.role === 'system' ? <div className="msg-system">{item.text}</div> : <Markdown text={item.text} />}
            {item.streaming ? <span className="cursor" aria-hidden /> : null}
          </div>
        ),
      )}
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
      <div className="to-label" data-testid="composer-target">
        To: Agent {task.alias} · {PROVIDER_LABEL[task.provider]} <span className="muted">(typed text goes only to this agent)</span>
      </div>
      <div className="composer-row">
        <textarea
          className="input"
          rows={3}
          value={draft}
          placeholder={`Message Agent ${task.alias}…  (Enter to send, Shift+Enter for a new line)`}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="composer-input"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-strong" disabled={!draft.trim() || sending} onClick={() => void send()}>
          Send
        </button>
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
    { title: `Task notes · Agent ${task.alias}`, records: mem.filter((m) => m.scope === 'task' && m.scopeId === task.taskId), hint: 'Private to this task.' },
    { title: `Project · ${project?.name ?? ''}`, records: mem.filter((m) => m.scope === 'project' && m.scopeId === task.projectId), hint: 'Approved notes load into new sessions in this project.' },
    { title: 'Global preferences', records: mem.filter((m) => m.scope === 'global'), hint: 'Approved notes load into every new session.' },
  ];
  const run = (fn: () => Promise<unknown>) => {
    setError('');
    fn().catch((e) => setError(errorText(e)));
  };
  return (
    <aside className="memory" aria-label="Scoped memory" data-testid="memory-panel">
      <h3>Memory</h3>
      <p className="muted small">App-owned notes. The provider keeps its own session history; nothing here rewrites a running session.</p>
      <div className="memory-add">
        <textarea className="input" rows={2} placeholder="Add a task note…" value={draft} onChange={(e) => setDraft(e.target.value)} />
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
          <div className="memory-group-title">{g.title}</div>
          <div className="muted small">{g.hint}</div>
          {g.records.length === 0 ? <div className="muted small">—</div> : null}
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
                  <label className="small">
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

export type { AttentionItem };
