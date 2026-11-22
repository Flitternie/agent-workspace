import { ALIAS_PROBLEM_TEXT, aliasProblem } from '../../shared/agent-name';
import type { Task } from '../../shared/types';
import { call } from '../api';
import { t } from '../i18n';
import { InlineEdit, type MenuItem } from './ContextMenu';
import { AgentName, isMainAgent, labelOf } from './bits';

/** Which of an agent's names is being edited in place. */
export type AgentField = 'alias' | 'name';

/** The renderer's check of a new agent name (the main process checks it again). */
export function aliasCheck(tasks: ReadonlyArray<Task>, taskId: string): (v: string) => string | null {
  return (v) => {
    const p = aliasProblem(v, tasks, taskId);
    return p ? t(ALIAS_PROBLEM_TEXT[p]) : null;
  };
}

export const saveAlias = (taskId: string, alias: string) => call('task:renameAgent', { taskId, alias });
export const saveTitle = (taskId: string, name: string) => call('task:rename', { taskId, name });

/** The same items wherever an agent is right-clicked (sidebar row, Overview tile, its header). */
export function agentMenuItems(
  task: Task,
  opts: { onRename: (field: AgentField) => void; onOpen?: () => void; setAside?: boolean },
): Array<MenuItem | '-'> {
  if (isMainAgent(task)) return opts.onOpen ? [{ id: 'open', label: t('Open'), icon: 'expand', onSelect: opts.onOpen }] : [];
  const items: Array<MenuItem | '-'> = [
    { id: 'rename-agent', label: t('Rename agent…'), icon: 'pencil', onSelect: () => opts.onRename('alias') },
    { id: 'rename-title', label: t('Rename title…'), icon: 'note', onSelect: () => opts.onRename('name') },
  ];
  if (opts.setAside || opts.onOpen) items.push('-');
  if (opts.setAside)
    items.push({
      id: 'set-aside',
      label: task.setAside ? t('Bring back') : t('Set aside'),
      icon: 'moon',
      onSelect: () => void call('task:setAside', { taskId: task.taskId, on: !task.setAside }).catch(() => {}),
    });
  if (opts.onOpen) items.push({ id: 'open', label: t('Open'), icon: 'expand', onSelect: opts.onOpen });
  return items;
}

/**
 * The agent's label and name ("合并发布 · 小陈"), one of them an input while it is renamed in place:
 * the other stays where it is.
 */
export function EditableAgentName({ task, tasks, editing, onDone }: { task: Task; tasks: ReadonlyArray<Task>; editing: AgentField | null; onDone: () => void }) {
  if (!editing || isMainAgent(task)) return <AgentName task={task} />;
  const label = labelOf(task);
  if (editing === 'alias')
    return (
      <>
        {label !== task.alias ? <span className="truncate">{label}</span> : null}
        <InlineEdit value={task.alias} label={t('Agent name')} testId="rename-agent-input" className="alias-edit" check={aliasCheck(tasks, task.taskId)} onSave={(v) => saveAlias(task.taskId, v)} onDone={onDone} />
      </>
    );
  return (
    <>
      <InlineEdit value={label === task.alias ? '' : label} label={t('Title')} testId="rename-title-input" className="title-edit" onSave={(v) => saveTitle(task.taskId, v)} onDone={onDone} />
      <span className="alias-tag">{task.alias}</span>
    </>
  );
}
