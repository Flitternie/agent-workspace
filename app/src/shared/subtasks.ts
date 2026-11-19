// How an agent's sub-agents are listed when there may be dozens: the ones still working first, then
// failures, then the finished ones; each group in the order they started, so a batch reads in order
// and rows never swap among themselves. Lists that only have room for a few show the head and count the rest.

import type { SubtaskInfo } from './types';

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);
const RANK: Record<SubtaskInfo['status'], number> = { running: 0, failed: 1, done: 2 };

export function orderSubtasks(list: SubtaskInfo[]): SubtaskInfo[] {
  return [...list].sort((a, b) => {
    const d = RANK[a.status] - RANK[b.status];
    return d || ms(a.startedAt) - ms(b.startedAt);
  });
}

export interface SubtaskDigest {
  shown: SubtaskInfo[];
  /** What did not fit, by state. */
  hidden: { total: number; running: number; failed: number; done: number };
  /** Across the whole list. */
  running: number;
}

/** The first `max` in list order, and a count of the rest. */
export function digestSubtasks(list: SubtaskInfo[], max: number): SubtaskDigest {
  const ordered = orderSubtasks(list);
  const shown = ordered.slice(0, Math.max(0, max));
  const rest = ordered.slice(shown.length);
  const count = (s: SubtaskInfo['status']) => rest.filter((x) => x.status === s).length;
  return {
    shown,
    hidden: { total: rest.length, running: count('running'), failed: count('failed'), done: count('done') },
    running: list.filter((s) => s.status === 'running').length,
  };
}
