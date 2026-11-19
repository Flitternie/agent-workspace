import type { MemoryRecord, Task } from '../shared/types';

// App-owned scoped memory (spec 05 §2–4). Native session history stays with the
// provider; these records are short, explicit notes with provenance. Only records
// approved for reuse cross a task boundary, and project records never cross into
// another project.

/** Records eligible for injection into `task` at session start. */
export function memoryForTask(task: Task, all: MemoryRecord[]): MemoryRecord[] {
  return all.filter((m) => {
    if (m.scope === 'global') return m.approvedForReuse && !m.sourceRemoved;
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
    '## Workspace memory (provided by Agent Workspace)',
    'The user saved these notes for this scope. Follow them unless the user says otherwise.',
    ...records.map((m) => `- [${label(m)}] ${m.body.replace(/\s+/g, ' ').trim()}`),
  ].join('\n');
}

/** What changed in a session's memory since it was given its notes: new, edited, no longer applying. */
export interface MemoryDelta {
  added: MemoryRecord[];
  changed: MemoryRecord[];
  removed: string[];
}

export function memoryDelta(now: MemoryRecord[], seen: Record<string, { at: string; body: string }>): MemoryDelta {
  const ids = new Set(now.map((m) => m.id));
  return {
    added: now.filter((m) => !seen[m.id]),
    changed: now.filter((m) => seen[m.id] && seen[m.id].at !== m.updatedAt && seen[m.id].body !== m.body),
    removed: Object.entries(seen)
      .filter(([id]) => !ids.has(id))
      .map(([, v]) => v.body),
  };
}

export const deltaSize = (d: MemoryDelta) => d.added.length + d.changed.length + d.removed.length;

/** The memory a session has been given, as it records it. */
export const seenOf = (records: MemoryRecord[]) => Object.fromEntries(records.map((m) => [m.id, { at: m.updatedAt, body: m.body.replace(/\s+/g, ' ').trim().slice(0, 300) }]));

/** The update sent ahead of the user's next message, so a running session follows notes saved since it began. */
export function memoryUpdateText(d: MemoryDelta): string {
  const label = (m: MemoryRecord) => (m.scope === 'global' ? 'user preference' : m.scope === 'project' ? 'project convention' : 'task note');
  const line = (m: MemoryRecord) => m.body.replace(/\s+/g, ' ').trim();
  return [
    '## Workspace memory update (provided by Agent Workspace)',
    'The user changed their saved notes since this session began. Follow them from now on; no need to reply to this part.',
    ...d.added.map((m) => `- [${label(m)}] ${line(m)}`),
    ...d.changed.map((m) => `- [${label(m)}, updated] ${line(m)}`),
    ...d.removed.map((body) => `- [no longer applies] ${body}`),
  ].join('\n');
}
