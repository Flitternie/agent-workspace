import { useState } from 'react';
import type { MapDecision, MapTask } from '../../shared/session-map';
import { t } from '../i18n';
import { Icon } from './bits';

// The session as a tree of tasks, git-graph style: one trunk, a colour per task so their stretches read
// apart, the node's shape for its state (done, going, given up), decisions as diamonds on short twigs off
// the trunk with the options that were offered, and agents forked off it as lanes curving away. The task
// being read is open and marked; others open on a click.

/** Soft, distinct hues, one per task in turn. */
const HUES = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#ef4444'];

export function SessionMap({
  tasks,
  current,
  onJump,
  onOpenAgent,
  onMerge,
  origin,
}: {
  tasks: MapTask[];
  /** The agent this session was forked from, drawn as where the trunk came in. */
  origin?: { taskId: string; alias: string; name: string };
  current: string | null;
  onJump: (turnId: string) => void;
  onOpenAgent: (taskId: string) => void;
  /** Merge this task into the one before (the reader overrules the grouping). */
  onMerge?: (startItemId: string) => void;
}) {
  /** Tasks opened by hand (the current one is always open). */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpened((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <ol className="session-map" data-testid="session-map">
      {origin ? (
        <li className="map-origin">
          <button className="map-branch from" onClick={() => onOpenAgent(origin.taskId)} title={origin.name} data-testid="map-origin">
            <span className="map-lane in" aria-hidden />
            <span className="map-branch-alias">{origin.alias}</span>
            <span className="truncate">{t('Forked from {name}', { name: origin.name })}</span>
          </button>
        </li>
      ) : null}
      {tasks.map((task, i) => {
        const on = task.startItemId === current;
        const open = on || opened.has(task.startItemId);
        const details = task.decisions.length + task.branches.length + task.subagents.length + task.attempts.length;
        const meta = [
          task.turnIds.length > 1 ? t('{n} turns', { n: task.turnIds.length }) : t('1 turn'),
          task.files.length ? (task.files.length === 1 ? t('1 file') : t('{n} files', { n: task.files.length })) : '',
          task.commands ? (task.commands === 1 ? t('1 command') : t('{n} commands', { n: task.commands })) : '',
        ].filter(Boolean);
        return (
          <li
            key={task.startItemId}
            className={`map-task${on ? ' current' : ''}${i === tasks.length - 1 ? ' last' : ''}`}
            style={{ ['--hue' as string]: HUES[i % HUES.length] }}
            data-status={task.status ?? 'unknown'}
            data-testid="map-task"
            data-start={task.startItemId}
          >
            <span className="map-node" aria-hidden>
              {task.status === 'done' ? <Icon name="check" size={8} /> : null}
            </span>
            <div className="map-head">
              <button className="map-title" onClick={() => onJump(task.startItemId)} title={task.outcome ? `${task.title}\n${task.outcome}` : task.title} data-testid="map-task-title">
                {task.title}
              </button>
              {details && !on ? (
                <button className={`map-caret${open ? ' open' : ''}`} onClick={() => toggle(task.startItemId)} aria-label={open ? t('Fold') : t('Unfold')} data-testid="map-caret">
                  <Icon name="chevron" size={10} />
                </button>
              ) : null}
              {i > 0 && onMerge ? (
                <button className="map-merge" onClick={() => onMerge(task.startItemId)} data-tip={t('Merge into the task above')} aria-label={t('Merge into the task above')} data-testid="map-merge">
                  <Icon name="collapse" size={10} />
                </button>
              ) : null}
            </div>
            <div className="map-meta">
              {task.status === 'in_progress' ? <span className="map-state going">{t('in progress')}</span> : task.status === 'abandoned' ? <span className="map-state dropped">{t('dropped')}</span> : null}
              {meta.join(' · ')}
            </div>
            {open && task.outcome ? <div className="map-outcome">{task.outcome}</div> : null}
            {open ? (
              task.decisions.map((d) => <Decision key={d.itemId + d.label} d={d} onJump={onJump} />)
            ) : details ? (
              <div className="map-folded">
                {task.decisions.length ? <span className="map-diamond" aria-hidden /> : null}
                {[
                  task.decisions.length ? t('{n} decisions', { n: task.decisions.length }) : '',
                  task.subagents.length ? t('{n} sub-agents', { n: task.subagents.length }) : '',
                  task.attempts.length ? t('{n} dropped', { n: task.attempts.length }) : '',
                  task.branches.length ? t('{n} forks', { n: task.branches.length }) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            ) : null}
            {open
              ? task.subagents.map((a) => (
                  <button key={a.itemId} className={`map-sub status-${a.status}`} onClick={() => onJump(a.turnId)} title={a.label} data-testid="map-subagent">
                    <span className="map-lane sub" aria-hidden />
                    <Icon name="subtasks" size={11} />
                    <span className="truncate">{a.label}</span>
                  </button>
                ))
              : null}
            {open
              ? task.attempts.map((a) => (
                  <button key={a.turnId + a.tried} className="map-attempt" onClick={() => onJump(a.turnId)} title={a.why ? `${a.tried}\n${a.why}` : a.tried} data-testid="map-attempt">
                    <span className="map-lane dead" aria-hidden />
                    <span className="map-cross" aria-hidden>
                      <Icon name="x" size={8} />
                    </span>
                    <span className="map-attempt-text">
                      <span className="map-attempt-tried">{t('Tried: {x}', { x: a.tried })}</span>
                      {a.why ? <span className="map-attempt-why">{a.why}</span> : null}
                    </span>
                  </button>
                ))
              : null}
            {open
              ? task.branches.map((b) => (
                  <button key={b.taskId} className="map-branch" onClick={() => onOpenAgent(b.taskId)} title={b.name} data-testid="map-branch">
                    <span className="map-lane" aria-hidden />
                    <span className="map-branch-alias">{b.alias}</span>
                    <span className="truncate">{b.name}</span>
                  </button>
                ))
              : null}
          </li>
        );
      })}
    </ol>
  );
}

function Decision({ d, onJump }: { d: MapDecision; onJump: (turnId: string) => void }) {
  const label = d.kind === 'approval' ? t('Allowed: {x}', { x: d.label }) : d.kind === 'answer' ? t('Answered: {x}', { x: d.label }) : d.kind === 'redirect' ? t('Changed course: {x}', { x: d.label }) : d.label;
  return (
    <div className={`map-decision kind-${d.kind}`} data-testid="map-decision">
      <span className="map-twig" aria-hidden />
      <span className="map-diamond" aria-hidden />
      <div className="map-decision-body">
        <button className="map-decision-label" onClick={() => onJump(d.turnId)} title={d.about ? `${d.about}\n→ ${d.label}` : d.label}>
          {label}
        </button>
        {/* An approval's options stay chips: allowing a command is not a fork in the work. */}
        {d.kind === 'approval' && d.options?.length ? (
          <div className="map-options">
            {d.options.map((o) => (
              <span key={o.label} className={`map-option${o.chosen ? ' chosen' : ''}`}>
                {o.chosen ? <Icon name="check" size={9} /> : null}
                {o.label}
              </span>
            ))}
          </div>
        ) : null}
        {/* A design or implementation choice is a fork: the way not taken branches off, dashed, and ends. */}
        {notTaken(d).map((alt) => (
          <div key={alt} className="map-not-taken" data-testid="map-not-taken">
            <span className="map-lane dead" aria-hidden />
            <span className="map-end" aria-hidden />
            <span className="truncate" title={alt}>
              {alt}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The ways not taken at a decision: what it ruled out, or the options offered and not chosen. */
function notTaken(d: MapDecision): string[] {
  if (d.kind === 'decided') return d.about ? [d.about] : [];
  if (d.kind === 'answer') return (d.options ?? []).filter((o) => !o.chosen).map((o) => o.label).slice(0, 4);
  return [];
}
