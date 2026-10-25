import { useRef, useState } from 'react';
import type { AttentionItem, Project, Task, TranscriptItem } from '../../shared/types';
import { call, errorText } from '../api';
import { timeAgo } from '../state';
import { diffStat } from '../../shared/content';
import { AttentionView } from './AttentionView';
import { DiffStat, KIND_ICON, PlanChecklist } from './Content';
import { Alias, displayName, Icon, ProviderTag, StatusDot } from './bits';
import { t } from '../i18n';

/** One participant tile in the meeting-style Overview. */
export function AgentCard({
  task,
  project,
  items,
  activity,
  connected,
  flash,
  selected,
  onSelect,
  onOpen,
  now,
}: {
  task: Task;
  project?: Project;
  items: AttentionItem[];
  activity: TranscriptItem[];
  connected: boolean;
  flash: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  now: number;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const urgent = items.filter((i) => i.kind !== 'completion');
  const report = items.find((i) => i.kind === 'completion');
  const needs = urgent.some((i) => i.kind === 'approval' || i.kind === 'question');
  const highRisk = items.some((i) => i.highRisk);

  const send = async (interrupt = false) => {
    const text = draft.trim();
    if (!text || sending) return;
    setError('');
    setSending(true);
    const r = await call('task:send', { taskId: task.taskId, text, via: 'card', interrupt }).catch((e) => ({ ok: false, error: errorText(e) }));
    setSending(false);
    if (r.ok) setDraft('');
    else setError(r.error ?? t('Not delivered'));
  };

  return (
    <article
      className={`tile status-${task.status}${needs ? ' needs' : ''}${highRisk ? ' high-risk' : ''}${flash ? ' flash' : ''}${selected ? ' selected' : ''}`}
      data-testid="agent-card"
      data-alias={task.alias}
      aria-selected={selected}
      title={selected ? t('Selected — messages without a name go here. Double-click to open.') : undefined}
      // Click selects (the voice/typed default target); double-click opens. Controls inside keep their own clicks.
      onClick={(e) => !isControl(e.target) && onSelect()}
      onDoubleClick={(e) => !isControl(e.target) && onOpen()}
    >
      <header className="tile-head">
        <Alias alias={task.alias} size="md" />
        <div className="tile-ident">
          <div className="tile-name">
            <span className="truncate">{displayName(task)}</span>
            <ProviderTag provider={task.provider} />
          </div>
          <div className="tile-title truncate" title={task.title}>
            {task.title}
          </div>
        </div>
        <StatusDot status={task.status} connected={connected} />
        <button className="icon-btn" aria-label={t('Open')} title={t('Open (⌘1–9)')} onClick={onOpen}>
          <Icon name="expand" />
        </button>
      </header>
      <div className="tile-meta mono">
        <span className="truncate" title={task.cwd}>
          <Icon name="folder" size={12} /> {project?.name ?? t('unknown project')}
        </span>
        {task.worktree ? (
          <span className="truncate" title={task.worktree.path}>
            <Icon name="branch" size={12} /> {task.worktree.branch}
          </span>
        ) : null}
        <span className="tile-updated">{timeAgo(task.updatedAt, now)}</span>
      </div>

      <div className="tile-body">
        {task.sharedCwdWarning ? (
          <div className="warn-text">
            <Icon name="alert" size={12} /> {task.sharedCwdWarning}
          </div>
        ) : null}
        {urgent.map((item) => (
          <AttentionView key={item.id} item={item} task={task} compact now={now} onReply={() => input.current?.focus()} />
        ))}

        <section className={`report${report ? ' report-new' : ''}`}>
          <div className="section-label">
            {report ? t('New report · {time}', { time: timeAgo(report.createdAt, now) }) : t('Latest')}
            {report ? (
              <button className="link small" onClick={() => void call('attention:dismiss', { attentionId: report.id })}>
                {t('Mark read')}
              </button>
            ) : null}
          </div>
          <div className="report-text" data-testid="card-summary">
            {/* Placeholder summaries from the backend have translations; agent reports pass through unchanged. */}
            {(task.summary && t(task.summary)) || <span className="muted">{t('No report yet.')}</span>}
          </div>
        </section>

        {task.plan ? <PlanChecklist plan={task.plan} compact /> : null}

        {activity.length ? (
          <section>
            <div className="section-label">{t('Activity')}</div>
            <ul className="activity">
              {activity.map((a) => {
                const diffs = (a.tool?.content ?? []).flatMap((c) => (c.type === 'diff' ? [c.diff] : []));
                const stat = diffs.length ? diffStat(diffs) : undefined;
                return (
                  <li key={a.id} className={`step step-${a.role}${a.toolStatus ? ` tool-${a.toolStatus}` : ''}`}>
                    {a.tool ? (
                      <span className="step-icon">
                        <Icon name={KIND_ICON[a.tool.kind]} size={12} />
                      </span>
                    ) : (
                      <span className="step-dot" aria-hidden />
                    )}
                    <span className="step-text truncate">{stepText(a)}</span>
                    {stat ? <DiffStat added={stat.added} removed={stat.removed} /> : <span className="step-time">{timeAgo(a.createdAt, now)}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className="tile-composer">
        <textarea
          ref={input}
          className="composer-input"
          rows={1}
          value={draft}
          aria-label={t('Message {alias}', { alias: task.alias })}
          placeholder={task.status === 'running' ? t('Add to {alias}’s work… (⌘↵ stops it first)', { alias: task.alias }) : t('Message {alias}…', { alias: task.alias })}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(e.metaKey || e.ctrlKey); // ⌘Enter stops the current turn first
            }
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <button className="send-btn" aria-label={t('Send to {alias}', { alias: task.alias })} disabled={!draft.trim() || sending} onClick={() => void send()}>
          <Icon name="send" />
        </button>
      </footer>
      {error ? <div className="error-text tile-error">{error}</div> : null}
    </article>
  );
}

function isControl(target: EventTarget): boolean {
  return target instanceof Element && !!target.closest('button, a, textarea, input, select, details, summary, [role="radio"]');
}

function stepText(a: TranscriptItem): string {
  const first = a.text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  if (a.role === 'tool') {
    const state = a.toolStatus === 'awaiting_approval' ? 'needs approval' : a.toolStatus === 'declined' || a.toolStatus === 'failed' ? a.toolStatus : '';
    return `${a.tool?.title || a.toolLabel || t('Tool')}${state ? ` — ${t(state)}` : ''}`;
  }
  if (a.role === 'thought') return `${t('Thinking')}: ${first}`;
  if (a.role === 'plan') return `${t('Proposed a plan')}: ${first}`;
  if (a.role === 'user') return `${a.via === 'main' ? t('Main agent') : t('You')}${a.via === 'voice' ? ` (${t('voice')})` : ''}: ${first}`;
  return first;
}
