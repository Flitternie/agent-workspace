import type { MemoryRecord, Task } from '../shared/types';

// App-owned scoped memory (spec 05 §2–4). Native session history stays with the
// provider; these records are short, explicit notes with provenance. Only records
// approved for reuse cross a task boundary, and project records never cross into
// another project.

/** Records eligible for injection into `task` at session start. */
export function memoryForTask(task: Task, all: MemoryRecord[]): MemoryRecord[] {
  return all.filter((m) => {
    if (m.scope === 'global') return m.approvedForReuse;
    if (m.scope === 'project') return m.scopeId === task.projectId && (m.approvedForReuse || m.originTaskId === task.taskId);
    if (m.scope === 'task') return m.scopeId === task.taskId;
    return false; // native session memory is owned by the provider
  });
}

/** Records the UI may show while `task` is focused (never another project's or task's private notes). */
export function visibleMemory(task: Task | undefined, all: MemoryRecord[]): MemoryRecord[] {
  return all.filter((m) => {
    if (m.scope === 'global') return true;
    if (!task) return false;
    if (m.scope === 'project') return m.scopeId === task.projectId;
    if (m.scope === 'task') return m.scopeId === task.taskId;
    return false;
  });
}

export function instructionsFor(task: Task, records: MemoryRecord[]): string | undefined {
  if (!records.length) return undefined;
  const label = (m: MemoryRecord) => (m.scope === 'global' ? 'user preference' : m.scope === 'project' ? 'project convention' : 'task note');
  return [
    '## Workspace memory (provided by Agent Meeting Workspace)',
    'The user saved these notes for this scope. Follow them unless the user says otherwise.',
    ...records.map((m) => `- [${label(m)}] ${m.body.replace(/\s+/g, ' ').trim()}`),
  ].join('\n');
}
