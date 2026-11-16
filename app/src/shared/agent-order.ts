// How agents are ordered and grouped, in one place: the sidebar's teams, the Overview's tiles and
// ⌘1–9 all read from here, so they always agree. Pure functions of the snapshot, no model involved:
// the order must react at once and stay predictable.

import type { AttentionItem, Project, Task } from './types';

/** A member who has done nothing (and been asked nothing) for this long folds into its team's idle row. */
export const IDLE_AFTER_MS = 3 * 24 * 3600_000;
/** "Recently running": the Overview keeps an agent this long after it last did anything. */
export const RECENT_MS = 2 * 3600_000;
/** Overview layouts: how many tiles fit. 0 = automatic. */
export const OVERVIEW_SLOTS = [0, 1, 2, 4, 6, 9] as const;

/**
 * 0 waiting on you (a question, a permission, an error to retry) · 1 working · 2 just finished with
 * a report you have not read, or failed · 3 everything else.
 */
export type Tier = 0 | 1 | 2 | 3;

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** When the user last did something with this agent (messaged, opened, answered it). */
export function userActiveAt(t: Task): number {
  return Math.max(ms(t.lastUserActivityAt), ms(t.createdAt));
}

/** When anything last happened to this agent, its own work included. */
export function activeAt(t: Task): number {
  return Math.max(userActiveAt(t), ms(t.updatedAt));
}

/** Set aside by the user and nothing has happened since that needs them or is under way. */
export function isSetAside(t: Task, open: AttentionItem[]): boolean {
  return !!t.setAside && tierOf(t, open) >= 2;
}

export function tierOf(t: Task, open: AttentionItem[]): Tier {
  const mine = open.filter((a) => a.taskId === t.taskId && a.state === 'open');
  if (mine.some((a) => a.kind !== 'completion')) return 0;
  if (t.status === 'running' || t.status === 'starting') return 1;
  if (mine.length || t.status === 'failed') return 2;
  return 3;
}

/** Since when the agent has been waiting on the user (its oldest open request). */
function waitingSince(t: Task, open: AttentionItem[]): number {
  const times = open.filter((a) => a.taskId === t.taskId && a.state === 'open' && a.kind !== 'completion').map((a) => ms(a.createdAt));
  return times.length ? Math.min(...times) : Infinity;
}

/**
 * Most urgent first: by tier; waiting longest first among those waiting on you; then the ones you
 * touched most recently (not the ones that merely printed something last, so background output
 * does not reshuffle the list).
 */
export function rank(tasks: Task[], open: AttentionItem[]): Task[] {
  const tier = new Map(tasks.map((t) => [t.taskId, tierOf(t, open)]));
  return [...tasks].sort((a, b) => {
    const d = tier.get(a.taskId)! - tier.get(b.taskId)!;
    if (d) return d;
    if (tier.get(a.taskId) === 0) return waitingSince(a, open) - waitingSince(b, open);
    return userActiveAt(b) - userActiveAt(a) || a.taskId.localeCompare(b.taskId);
  });
}

/** Agents waiting on the user, across every team: the sidebar's "Needs you" strip. */
export function needsYou(tasks: Task[], open: AttentionItem[]): Task[] {
  return rank(tasks, open).filter((t) => tierOf(t, open) === 0);
}

export interface Team {
  project: Pick<Project, 'projectId' | 'name'>;
  /** Members to show: working, waiting, or touched within IDLE_AFTER_MS; most urgent first. */
  members: Task[];
  /** Members folded into "N idle". */
  idle: Task[];
  counts: { waiting: number; running: number; failed: number };
  /** Expanded unless the user says otherwise: something is going on, or it was used recently. */
  active: boolean;
}

/** One team per project, the team with someone waiting on you first, then the one you used last. */
export function teams(tasks: Task[], projects: Array<Pick<Project, 'projectId' | 'name'>>, open: AttentionItem[], now: number): Team[] {
  const out: Array<Team & { last: number }> = [];
  for (const project of projects) {
    const all = rank(
      tasks.filter((t) => t.projectId === project.projectId),
      open,
    );
    if (!all.length) continue;
    const busy = (t: Task) => !isSetAside(t, open) && (tierOf(t, open) <= 2 || now - activeAt(t) < IDLE_AFTER_MS);
    const members = all.filter(busy);
    out.push({
      project,
      members,
      idle: all.filter((t) => !busy(t)),
      counts: {
        waiting: all.filter((t) => tierOf(t, open) === 0).length,
        running: all.filter((t) => t.status === 'running' || t.status === 'starting').length,
        failed: all.filter((t) => t.status === 'failed').length,
      },
      active: members.length > 0,
      last: Math.max(...all.map(userActiveAt)),
    });
  }
  return out
    .sort((a, b) => Number(b.counts.waiting > 0) - Number(a.counts.waiting > 0) || b.last - a.last || a.project.name.localeCompare(b.project.name))
    .map(({ last: _last, ...team }) => team);
}

/** Agents in sidebar order as shown (expanded teams' members): what ⌘1–9 point at. */
export function visibleOrder(list: Team[], expanded: (team: Team) => boolean): Task[] {
  return list.filter(expanded).flatMap((team) => team.members);
}

/** Agents the Overview may show: waiting, working, unread or failed, or active within RECENT_MS; most urgent first. */
export function overviewCandidates(tasks: Task[], open: AttentionItem[], now: number): Task[] {
  return rank(tasks, open).filter((t) => !isSetAside(t, open) && (tierOf(t, open) <= 2 || now - activeAt(t) < RECENT_MS));
}

/**
 * Which agents get the Overview's `slots` tiles, in which positions. Tiles stay where they were:
 * a shown agent leaves only when it is no longer a candidate, or when a candidate of a strictly
 * more urgent tier needs its place (the least urgent tile gives way). `keep` (the selected tile)
 * never gives way. New agents fill free positions in priority order.
 */
export function fillSlots(previous: string[], candidates: Task[], open: AttentionItem[], slots: number, keep?: string | null): string[] {
  const tier = new Map(candidates.map((t) => [t.taskId, tierOf(t, open)]));
  const order = new Map(candidates.map((t, i) => [t.taskId, i]));
  // Positions as they were; an agent that is no longer a candidate leaves a gap for a newcomer.
  const shown: Array<string | null> = previous.map((id) => (tier.has(id) ? id : null));
  const present = () => shown.filter((id): id is string => !!id);
  // Least urgent shown tile that may give way (never the kept one).
  const weakest = () =>
    present()
      .filter((id) => id !== keep)
      .sort((a, b) => tier.get(b)! - tier.get(a)! || order.get(b)! - order.get(a)!)[0];
  while (present().length > slots) {
    const w = weakest();
    if (!w) break;
    shown[shown.indexOf(w)] = null;
  }
  for (const t of candidates) {
    if (shown.includes(t.taskId)) continue;
    if (present().length < slots) {
      const gap = shown.indexOf(null);
      if (gap === -1) shown.push(t.taskId);
      else shown[gap] = t.taskId;
      continue;
    }
    const w = weakest();
    if (w && tier.get(t.taskId)! < tier.get(w)!) shown[shown.indexOf(w)] = t.taskId;
  }
  return present();
}

/** Tiles for a layout: the automatic one shows every candidate, up to nine. */
export function slotsFor(layout: number | undefined, candidates: number): number {
  return layout ? layout : Math.min(Math.max(candidates, 0), 9);
}
