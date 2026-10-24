import { useState } from 'react';
import type { AttentionItem, Task } from '../../shared/types';
import { call, errorText } from '../api';
import { timeAgo } from '../state';
import { Icon, KIND_LABEL, Markdown, PROVIDER_LABEL } from './bits';

/**
 * One durable attention item. Native approvals/questions are answered only with
 * the provider-offered decisions (bound to the native request id); heuristic
 * questions are answered by replying to the agent.
 */
export function AttentionView({
  item,
  task,
  compact,
  onReply,
  now,
}: {
  item: AttentionItem;
  task: Task;
  compact?: boolean;
  onReply?: () => void;
  now: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const native = !!item.providerRequestId;
  const openState = item.state === 'open';

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const details = item.details && item.details !== item.headline ? item.details : '';
  const label = item.kind === 'approval' ? `${PROVIDER_LABEL[task.provider]} asks permission` : KIND_LABEL[item.kind];
  return (
    <div
      className={`attention kind-${item.kind} state-${item.state}${item.highRisk ? ' high-risk' : ''}`}
      data-testid="attention-item"
      data-attention-kind={item.kind}
    >
      <div className="attention-head">
        <span className="attention-kind">
          <Icon name={item.kind === 'approval' || item.kind === 'error' ? 'alert' : 'reply'} size={12} />
          {label}
          {item.highRisk ? <span className="risk-tag">high risk</span> : null}
        </span>
        <span className="attention-time">{openState ? timeAgo(item.createdAt, now) : `${item.state} ${item.resolvedAt ? timeAgo(item.resolvedAt, now) : ''}`}</span>
      </div>
      <div className="attention-headline">{item.headline}</div>
      {details ? (
        <div className={`attention-details${compact && !expanded ? ' clamp' : ''}`}>
          {item.kind === 'approval' ? <pre>{details}</pre> : <Markdown text={details} />}
        </div>
      ) : null}
      {details && compact ? (
        <button className="link small" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
      {!openState && item.resolution ? <div className="attention-resolution">{item.resolution}</div> : null}

      {openState && native && item.kind === 'approval' ? (
        <div className="attention-actions">
          {(item.options ?? []).map((o) => (
            <button
              key={o.id}
              className={/deny|decline/.test(o.id) ? 'btn' : 'btn btn-primary'}
              disabled={busy}
              title={o.description}
              onClick={() => act(() => call('attention:respond', { attentionId: item.id, decision: o.id }))}
            >
              {o.label}
            </button>
          ))}
          <span className="hint">Answered natively in {PROVIDER_LABEL[task.provider]}</span>
        </div>
      ) : null}

      {openState && native && item.kind === 'question' ? (
        <div className="attention-questions">
          {(item.questions ?? []).map((q) => (
            <div key={q.id} className="question">
              {q.header ? <div className="question-header">{q.header}</div> : null}
              {(item.questions ?? []).length > 1 ? <div>{q.question}</div> : null}
              <div className="question-options">
                {q.options.map((o) => (
                  <button key={o.id} className={`chip${answers[q.id] === o.label ? ' chip-selected' : ''}`} title={o.description} onClick={() => setAnswers({ ...answers, [q.id]: o.label })}>
                    {o.label}
                  </button>
                ))}
              </div>
              <input
                className="input"
                type={q.isSecret ? 'password' : 'text'}
                placeholder={q.options.length ? 'Or type your own answer' : 'Your answer'}
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              />
            </div>
          ))}
          <div className="attention-actions">
            <button
              className="btn btn-primary"
              disabled={busy || (item.questions ?? []).some((q) => !answers[q.id]?.trim())}
              onClick={() => act(() => call('attention:respond', { attentionId: item.id, decision: 'answer', answers }))}
            >
              Send answer
            </button>
            <button className="btn" disabled={busy} onClick={() => act(() => call('attention:respond', { attentionId: item.id, decision: 'deny' }))}>
              Decline
            </button>
          </div>
        </div>
      ) : null}

      {openState && !native ? (
        <div className="attention-actions">
          {onReply && item.kind !== 'error' ? (
            <button className="btn btn-primary" onClick={onReply}>
              Reply to {task.alias}
            </button>
          ) : null}
          <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => call('attention:dismiss', { attentionId: item.id }))}>
            Dismiss
          </button>
        </div>
      ) : null}
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}
