import { useState } from 'react';
import type { AttentionItem, Task } from '../../shared/types';
import { call, errorText } from '../api';
import { timeAgo } from '../state';
import { Icon, KIND_LABEL, PROVIDER_LABEL } from './bits';
import { Markdown } from './Markdown';
import { ToolContentView } from './Content';
import { t } from '../i18n';

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
  const label = item.kind === 'approval' ? t('{name} asks permission', { name: PROVIDER_LABEL[task.provider] }) : t(KIND_LABEL[item.kind]);
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
          {item.highRisk ? <span className="risk-tag">{t('high risk')}</span> : null}
        </span>
        <span className="attention-time">{openState ? timeAgo(item.createdAt, now) : `${t(item.state)} ${item.resolvedAt ? timeAgo(item.resolvedAt, now) : ''}`}</span>
      </div>
      <div className="attention-headline">{item.headline}</div>
      {item.preview?.length ? <ToolContentView content={item.preview} compact={compact && !expanded} /> : null}
      {details ? (
        <div className={`attention-details${compact && !expanded ? ' clamp' : ''}`}>
          {item.kind === 'approval' ? <pre>{details}</pre> : <Markdown text={details} />}
        </div>
      ) : null}
      {(details || item.preview?.length) && compact ? (
        <button className="link small" onClick={() => setExpanded(!expanded)}>
          {expanded ? t('Show less') : t('Show more')}
        </button>
      ) : null}
      {!openState && item.resolution ? <div className="attention-resolution">{item.resolution}</div> : null}

      {openState && native && item.kind === 'approval' ? (
        <div className="attention-actions">
          {(item.options ?? []).map((o) => (
            <button
              key={o.id}
              className={(o.kind ? o.kind.startsWith('reject') : /deny|decline/.test(o.id)) ? 'btn' : o.kind === 'allow_always' ? 'btn' : 'btn btn-primary'}
              disabled={busy}
              title={o.description}
              onClick={() => act(() => call('attention:respond', { attentionId: item.id, decision: o.id }))}
            >
              {/* Option labels come from our adapters, so they have translations. */}
              {t(o.label)}
            </button>
          ))}
          <span className="hint">{t('Answered natively in {name}', { name: PROVIDER_LABEL[task.provider] })}</span>
        </div>
      ) : null}

      {openState && native && item.kind === 'question' ? (
        <div className="attention-questions">
          {(item.questions ?? []).map((q) => (
            <div key={q.id} className="question">
              {q.header ? <div className="question-header">{q.header}</div> : null}
              {(item.questions ?? []).length > 1 ? <div>{q.question}</div> : null}
              <div className="question-options">
                {q.options.map((o) => {
                  const picked = (answers[q.id] ?? '').split(', ').filter(Boolean);
                  const on = picked.includes(o.label);
                  return (
                    <button
                      key={o.id}
                      className={`chip${on ? ' chip-selected' : ''}`}
                      title={o.description}
                      aria-pressed={on}
                      onClick={() =>
                        setAnswers({
                          ...answers,
                          [q.id]: q.multiSelect ? (on ? picked.filter((l) => l !== o.label) : [...picked, o.label]).join(', ') : o.label,
                        })
                      }
                    >
                      {q.multiSelect ? <span className="check-box">{on ? '✓' : ''}</span> : null}
                      {o.label}
                    </button>
                  );
                })}
              </div>
              {q.options.some((o) => o.description) ? (
                <ul className="option-notes">
                  {q.options
                    .filter((o) => o.description)
                    .map((o) => (
                      <li key={o.id}>
                        <strong>{o.label}</strong> — {o.description}
                      </li>
                    ))}
                </ul>
              ) : null}
              {q.multiSelect ? <div className="hint">{t('Pick one or more.')}</div> : null}
              {q.allowOther === false && q.options.length ? null : (
              <input
                className="input"
                type={q.isSecret ? 'password' : 'text'}
                placeholder={q.options.length ? t('Or type your own answer') : t('Your answer')}
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              />
              )}
            </div>
          ))}
          <div className="attention-actions">
            <button
              className="btn btn-primary"
              disabled={busy || (item.questions ?? []).some((q) => !answers[q.id]?.trim())}
              onClick={() => act(() => call('attention:respond', { attentionId: item.id, decision: 'answer', answers }))}
            >
              {t('Send answer')}
            </button>
            <button className="btn" disabled={busy} onClick={() => act(() => call('attention:respond', { attentionId: item.id, decision: 'deny' }))}>
              {t('Decline')}
            </button>
          </div>
        </div>
      ) : null}

      {openState && !native ? (
        <div className="attention-actions">
          {onReply && item.kind !== 'error' ? (
            <button className="btn btn-primary" onClick={onReply}>
              {t('Reply to {alias}', { alias: task.alias })}
            </button>
          ) : null}
          <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => call('attention:dismiss', { attentionId: item.id }))}>
            {t('Dismiss')}
          </button>
        </div>
      ) : null}
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}

