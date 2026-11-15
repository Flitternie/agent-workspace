import type { SubtaskInfo, Task } from '../../shared/types';
import { t } from '../i18n';
import { AgentName, Alias, clock, elapsed, Icon, labelOf } from './bits';

/**
 * A sub-agent's run, read-only: what it was asked, each step it took, what it reported back.
 * Sub-agents are an agent's own helpers, so they can be watched, not talked to.
 */
export function SubtaskView({ task, subtask, now, onBack }: { task: Task; subtask?: SubtaskInfo; now: number; onBack: () => void }) {
  return (
    <div className="subtask-view" data-testid="subtask-view">
      <header className="stage-head drag">
        <button className="btn btn-ghost" onClick={onBack} data-testid="subtask-back" title={t('Back to {name}', { name: labelOf(task) })}>
          <Icon name="chevron" size={12} /> <Alias alias={task.alias} size="sm" /> <AgentName task={task} />
        </button>
      </header>
      {!subtask ? (
        <div className="empty">
          <p className="muted">{t('This sub-agent’s turn is over; its run is in the agent’s conversation.')}</p>
        </div>
      ) : (
        <div className="subtask-view-body">
          <div className="subtask-view-title">
            <span className={`sdot sdot-${subtask.status}`} />
            <h2>{subtask.description}</h2>
            <span className={`subtask-view-status st-${subtask.status}`}>
              {subtask.status === 'running' ? t('Working · {time}', { time: elapsed(subtask, now) }) : subtask.status === 'done' ? t('Done in {time}', { time: elapsed(subtask, now) }) : t('Failed')}
            </span>
          </div>
          <p className="muted small">{t('A helper {name} started for this turn: you can follow it here, not talk to it.', { name: task.alias })}</p>
          <ol className="subtask-steps" data-testid="subtask-steps">
            {(subtask.steps ?? []).map((step, i, all) => (
              <li key={`${step.at}-${i}`} className={subtask.status === 'running' && i === all.length - 1 ? 'current' : ''}>
                <span className="subtask-step-time">{clock(subtask.startedAt, Date.parse(step.at))}</span>
                <span>{step.text}</span>
              </li>
            ))}
            {!subtask.steps?.length ? <li className="muted">{t('No steps yet.')}</li> : null}
          </ol>
          {subtask.result ? (
            <div className="subtask-result" data-testid="subtask-result">
              <div className="section-label">{t('Reported back to {name}', { name: task.alias })}</div>
              <p>{subtask.result}</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
