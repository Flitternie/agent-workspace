import type { FileDiff } from '../shared/content';
import type { TranscriptItem } from '../shared/types';

export interface FileChange {
  path: string;
  /** This file's diffs in the turn, oldest first (applied ones; proposed only while waiting for approval). */
  diffs: FileDiff[];
  added: number;
  removed: number;
  operation: FileDiff['operation'];
  /** Where the latest change starts in the new file. */
  line?: number;
  /** The tool call that changed it last (to notice new changes). */
  lastItemId: string;
}

export interface TurnChanges {
  /** The current turn (since the user's last message), or the last one that changed anything. */
  which: 'current' | 'previous';
  files: FileChange[];
}

function fileChanges(items: TranscriptItem[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const item of items) {
    if (item.role !== 'tool' || !item.tool || item.toolStatus === 'failed' || item.toolStatus === 'declined') continue;
    for (const c of item.tool.content) {
      if (c.type !== 'diff') continue;
      const d = c.diff;
      if (d.phase === 'proposed' && item.toolStatus === 'completed') continue;
      const cur = byPath.get(d.path) ?? { path: d.path, diffs: [], added: 0, removed: 0, operation: d.operation, lastItemId: item.id };
      // A later full diff of the same call replaces its proposed one.
      cur.diffs = cur.diffs.filter((x) => !(x.phase === 'proposed' && d.phase === 'applied'));
      cur.diffs.push(d);
      cur.added += d.added;
      cur.removed += d.removed;
      cur.operation = cur.operation === 'add' ? 'add' : d.operation;
      cur.line = d.snippet ? item.tool.locations.find((l) => l.path === d.path)?.line : (d.hunks[0]?.newStart ?? cur.line);
      cur.lastItemId = item.id;
      byPath.delete(d.path);
      byPath.set(d.path, cur);
    }
  }
  return [...byPath.values()];
}

/** The files the agent changed in its latest turn: since the user last wrote, else in the turn before. */
export function turnChanges(transcript: TranscriptItem[]): TurnChanges {
  const userAt = transcript.map((x, i) => (x.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const last = userAt.at(-1) ?? -1;
  const current = fileChanges(transcript.slice(last + 1));
  if (current.length || last < 0) return { which: 'current', files: current };
  const before = userAt.at(-2) ?? -1;
  return { which: 'previous', files: fileChanges(transcript.slice(before + 1, last)) };
}
