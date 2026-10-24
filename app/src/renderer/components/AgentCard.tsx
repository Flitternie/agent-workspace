import { useState } from 'react';
import type { AttentionItem, Project, Task } from '../../shared/types';
import { call, errorText } from '../api';
import { AttentionView } from './AttentionView';
import { Alias, ProviderBadge, StatusPill } from './bits';

export function AgentCard({
  task,
  project,
  items,
  connected,
  flash,
  onOpen,
  now,
}: {
  task: Task;
  project?: Project;
  items: AttentionItem[];
  connected: boolean;
  flash: boolean;
  onOpen: () => void;
  now: number;
}) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const needs = items.some((i) => i.kind === 'approval' || i.kind === 'question');
  const highRisk = items.some((i) => i.highRisk);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setError('');
    const r = await call('task:send', { taskId: task.taskId, text, via: 'card' }).catch((e) => ({ ok: false, error: errorText(e) }));
    if (r.ok) {
      setDraft('');
      setReplying(false);
    } else setError(r.error ?? 'Not delivered');
  };

  return (
    <article
      className={`card status-${task.status}${needs ? ' needs' : ''}${highRisk ? ' high-risk' : ''}${flash ? ' flash' : ''}`}
      data-testid="agent-card"
      data-alias={task.alias}
    >
      <header className="card-head" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
        <Alias alias={task.alias} size="lg" />
        <div className="card-ident">
          <div className="card-name">
            {task.name !== task.alias ? task.name : `Agent ${task.alias}`} <ProviderBadge provider={task.provider} />
          </div>
          <div className="card-title" title={task.title}>
            {task.title}
          </div>
          <div className="card-meta">
            {project?.name ?? 'unknown project'}
            {task.worktree ? ` · ${task.worktree.branch}` : ''}
          </div>
        </div>
        <StatusPill status={task.status} connected={connected} />
      </header>

      <div className="card-summary" data-testid="card-summary">
        {task.summary}
      </div>
      {task.sharedCwdWarning ? <div className="warn-text">⚠ {task.sharedCwdWarning}</div> : null}

      <div className="card-attention">
        {items.length === 0 ? <div className="muted small">Nothing waiting on you.</div> : null}
        {items.map((item) => (
          <AttentionView key={item.id} item={item} task={task} compact now={now} onReply={() => setReplying(true)} />
        ))}
      </div>

      {replying ? (
        <div className="card-composer">
          <div className="to-label">To: Agent {task.alias}</div>
          <textarea
            className="input"
            autoFocus
            rows={2}
            value={draft}
            placeholder={`Reply to ${task.alias}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
              if (e.key === 'Escape') setReplying(false);
            }}
          />
          {error ? <div className="error-text">{error}</div> : null}
        </div>
      ) : null}

      <footer className="card-foot">
        <button className="btn btn-strong" onClick={onOpen}>
          Open
        </button>
        {!replying ? (
          <button className="btn" onClick={() => setReplying(true)}>
            Message
          </button>
        ) : null}
      </footer>
    </article>
  );
}
