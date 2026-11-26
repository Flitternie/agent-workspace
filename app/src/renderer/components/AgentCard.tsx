import { useRef, useState } from 'react';
import type { AttentionItem, Project, Task, TranscriptItem } from '../../shared/types';
import { call, errorText } from '../api';
import { timeAgo } from '../state';
import { diffStat } from '../../shared/content';
import { AttentionView } from './AttentionView';
import { DiffStat, KIND_ICON, PlanChecklist, touchedPaths } from './Content';
import { Alias, Icon, labelOf, liveSubtasks, ProviderTag, StatusDot, SubtaskDots, SubtaskThread, warningText } from './bits';
import { RetryNotice } from './Retry';
import { t } from '../i18n';
import { AttachmentStrip, useAttachments } from './Attachments';
import { dropMentions } from './Mentions';
import { useDraft } from '../drafts';
import { menuAt, useContextMenu } from './ContextMenu';
import { agentMenuItems, EditableAgentName, type AgentField } from './AgentMenu';

/** One participant tile in the meeting-style Overview. */
export function AgentCard({
  task,
  project,
  items,
  activity,
  onPreview,
  connected,
  tasks,
  flash,
  selected,
  onSelect,
  onOpen,
  onOpenSubtask,
  now,
}: {
  task: Task;
  project?: Project;
  items: AttentionItem[];
  activity: TranscriptItem[];
  /** Open this agent with a file it touched in the preview column. */
  onPreview?: (path: string, line?: number) => void;
  connected: boolean;
  /** Every agent (a new name must be unique). */
  tasks: Task[];
  flash: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onOpenSubtask: (taskId: string, subtaskId: string) => void;
  now: number;
}) {
  // The same unsent message as on the agent's page: started here, finished there, or the other way round.
  const [draft, setDraft] = useDraft(task.taskId);
  // Sub-agents unfold inside the card, above its activity; folded by default.
  const [subOpen, setSubOpen] = useState(false);
  const [error, setError] = useState('');
  const menu = useContextMenu();
  const [renaming, setRenaming] = useState<AgentField | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const urgent = items.filter((i) => i.kind !== 'completion');
  const report = items.find((i) => i.kind === 'completion');
  const needs = urgent.some((i) => i.kind === 'approval' || i.kind === 'question' || i.kind === 'signin');
  const highRisk = items.some((i) => i.highRisk);

  // Images pasted or dropped on the tile's box go with the message, as on the agent's page.
  const attach = useAttachments(async (files) => {
    const text = await dropMentions(task.taskId, files);
    if (text) setDraft((d) => (d && !/\s$/.test(d) ? `${d} ` : d) + text);
  }, task.taskId);
  const send = async (interrupt = false) => {
    const text = draft.trim();
    const images = attach.refs;
    if ((!text && !images.length) || sending || attach.busy) return;
    setError('');
    setSending(true);
    const r = await call('task:send', { taskId: task.taskId, text, via: 'card', interrupt, ...(images.length ? { images } : {}) }).catch((e) => ({ ok: false, error: errorText(e) }));
    setSending(false);
    if (r.ok) {
      setDraft('');
      attach.clear();
    } else setError(r.error ?? t('Not delivered'));
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
      <header className="tile-head" onContextMenu={(e) => renaming || menu.open(menuAt(e, agentMenuItems(task, { onRename: setRenaming, setAside: true, onOpen })))}>
        <Alias alias={task.alias} size="md" />
        <div className="tile-ident">
          <div className="tile-name">
            <EditableAgentName task={task} tasks={tasks} editing={renaming} onDone={() => setRenaming(null)} />
            <ProviderTag provider={task.provider} />
          </div>
          {/* The original task, unless the label already says it (a label taken from the title). */}
          {sameText(task.title, labelOf(task)) ? null : (
            <div className="tile-title truncate" title={task.title}>
              {task.title}
            </div>
          )}
        </div>
        <SubtaskDots subtasks={liveSubtasks(task)} open={subOpen} onToggle={() => setSubOpen((o) => !o)} />
        <StatusDot status={task.status} connected={connected} />
        <button className="icon-btn" aria-label={t('Open')} title={t('Open (⌘1–9)')} onClick={onOpen}>
          <Icon name="expand" />
        </button>
        {menu.element}
      </header>
      <div className="tile-meta mono">
        <span className="truncate" title={task.host ? `${task.host}:${task.cwd}` : task.cwd}>
          <Icon name="folder" size={12} /> {task.host ? `${task.host}:` : ''}
          {project?.name ?? t('unknown project')}
        </span>
        {task.worktree ? (
          <span className="truncate" title={task.worktree.path}>
            <Icon name="branch" size={12} /> {task.worktree.branch}
          </span>
        ) : null}
        <span className="tile-updated">{timeAgo(task.updatedAt, now)}</span>
      </div>

      <div className="tile-body">
        {subOpen && liveSubtasks(task)?.length ? <SubtaskThread subtasks={liveSubtasks(task)!} now={now} max={4} heading onOpen={(id) => onOpenSubtask(task.taskId, id)} /> : null}
        {task.sharedCwdWarning ? (
          <div className="warn-text">
            <Icon name="alert" size={12} /> {warningText(task.sharedCwdWarning)}
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
            {task.retry ? <RetryNotice retry={task.retry} /> : (task.summary && t(task.summary)) || <span className="muted">{t('No report yet.')}</span>}
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
                    {(() => {
                      const file = onPreview ? touchedPaths(a)[0] : undefined;
                      if (!file) return <span className="step-text truncate">{stepText(a)}</span>;
                      const line = a.tool?.locations.find((l) => l.path === file)?.line;
                      return (
                        <button
                          className="step-text truncate link-step"
                          title={t('Preview {name}', { name: file })}
                          data-testid="card-preview-file"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPreview?.(file, line);
                          }}
                        >
                          {stepText(a)}
                        </button>
                      );
                    })()}
                    {stat ? <DiffStat added={stat.added} removed={stat.removed} /> : <span className="step-time">{timeAgo(a.createdAt, now)}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className={`tile-composer${attach.dragging ? ' dropping' : ''}${attach.items.length || attach.busy ? ' has-images' : ''}`} {...attach.dropProps}>
        <AttachmentStrip items={attach.items} busy={attach.busy} onRemove={attach.remove} />
        <textarea
          ref={input}
          className="composer-input"
          rows={1}
          value={draft}
          aria-label={t('Message {alias}', { alias: task.alias })}
          placeholder={task.status === 'running' ? t('Add to {alias}’s work… (⌘↵ stops it first)', { alias: task.alias }) : t('Message {alias}…', { alias: task.alias })}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={attach.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(e.metaKey || e.ctrlKey); // ⌘Enter stops the current turn first
            }
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <button className="send-btn" aria-label={t('Send to {alias}', { alias: task.alias })} disabled={(!draft.trim() && !attach.items.length) || sending || attach.busy} onClick={() => void send()}>
          <Icon name="send" />
        </button>
      </footer>
      {error || attach.error ? <div className="error-text tile-error">{error || attach.error}</div> : null}
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
  if (a.role === 'user') {
    const images = a.images?.length ? (a.images.length === 1 ? t('[image]') : t('[{n} images]', { n: a.images.length })) : '';
    return `${a.via === 'main' ? t('Main agent') : t('You')}${a.via === 'voice' ? ` (${t('voice')})` : ''}: ${[images, first].filter(Boolean).join(' ')}`;
  }
  return first;
}

/** "Fix the login redirect" and its shortened label "Fix the login…" say the same thing. */
function sameText(title: string, label: string): boolean {
  const norm = (x: string) => x.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(title);
  const b = norm(label);
  return !!b && (a === b || a.startsWith(b) || a.replace(/^(请|帮我|麻烦|帮忙|please|can you|could you)\s*/i, '').startsWith(b));
}
