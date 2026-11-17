import { describe, expect, it } from 'vitest';
import { fillSlots, IDLE_AFTER_MS, isSetAside, needsYou, overviewCandidates, rank, RECENT_MS, slotsFor, teams, tierOf, visibleOrder } from '../../src/shared/agent-order';
import type { AttentionItem, Task } from '../../src/shared/types';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const ago = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3600_000;

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    taskId: id,
    alias: id,
    name: id,
    projectId: 'p1',
    title: id,
    provider: 'claude',
    status: 'idle',
    summary: '',
    cwd: '/tmp',
    createdAt: ago(30 * 24 * H),
    updatedAt: ago(30 * 24 * H),
    ...over,
  };
}

function ask(taskId: string, kind: AttentionItem['kind'], minutesAgo: number): AttentionItem {
  return { id: `a-${taskId}-${kind}`, taskId, kind, state: 'open', headline: '', createdAt: ago(minutesAgo * 60_000) } as AttentionItem;
}

describe('agent order', () => {
  it('puts what waits on you first (longest waiting first), then work in progress, then what you touched last', () => {
    const tasks = [
      task('idleRecent', { lastUserActivityAt: ago(1 * H) }),
      task('running', { status: 'running' }),
      task('askedLate'),
      task('askedEarly'),
      task('unread', { status: 'done' }),
      task('idleOld', { lastUserActivityAt: ago(5 * H) }),
    ];
    const open = [ask('askedLate', 'question', 5), ask('askedEarly', 'approval', 30), ask('unread', 'completion', 1)];
    expect(rank(tasks, open).map((t) => t.taskId)).toEqual(['askedEarly', 'askedLate', 'running', 'unread', 'idleRecent', 'idleOld']);
    expect(needsYou(tasks, open).map((t) => t.taskId)).toEqual(['askedEarly', 'askedLate']);
    expect(tierOf(tasks[4], open)).toBe(2);
  });

  it('does not reshuffle when an agent merely prints something: background output is not your activity', () => {
    const a = task('a', { lastUserActivityAt: ago(1 * H), updatedAt: ago(2 * H) });
    const b = task('b', { lastUserActivityAt: ago(3 * H), updatedAt: ago(0) });
    expect(rank([b, a], []).map((t) => t.taskId)).toEqual(['a', 'b']);
  });

  it('groups agents into project teams; idle members fold away; the team with someone waiting comes first', () => {
    const projects = [
      { projectId: 'shop', name: 'shop' },
      { projectId: 'legal', name: 'legal' },
      { projectId: 'old', name: 'old' },
    ];
    const tasks = [
      task('s1', { projectId: 'shop', lastUserActivityAt: ago(1 * H) }),
      task('s2', { projectId: 'shop', updatedAt: ago(IDLE_AFTER_MS + H) }),
      task('l1', { projectId: 'legal', lastUserActivityAt: ago(5 * H) }),
      task('o1', { projectId: 'old' }),
    ];
    const open = [ask('l1', 'question', 10)];
    const list = teams(tasks, projects, open, NOW);
    expect(list.map((t) => t.project.name)).toEqual(['legal', 'shop', 'old']);
    const shop = list[1];
    expect(shop.members.map((t) => t.taskId)).toEqual(['s1']);
    expect(shop.idle.map((t) => t.taskId)).toEqual(['s2']);
    expect(list[0].counts).toEqual({ waiting: 1, running: 0, failed: 0 });
    expect(list[2].active).toBe(false);
    // ⌘1–9 follow what is shown: collapsed teams and idle members get no number.
    expect(visibleOrder(list, (t) => t.active).map((t) => t.taskId)).toEqual(['l1', 's1']);
  });

  it('the Overview shows only what is busy or was recently', () => {
    const tasks = [task('busy', { status: 'running' }), task('recent', { updatedAt: ago(RECENT_MS / 2) }), task('stale', { updatedAt: ago(RECENT_MS * 2) })];
    expect(overviewCandidates(tasks, [], NOW).map((t) => t.taskId)).toEqual(['busy', 'recent']);
    expect(slotsFor(0, 12)).toBe(9);
    expect(slotsFor(0, 2)).toBe(2);
    expect(slotsFor(4, 12)).toBe(4);
  });

  it('keeps tiles in place; a more urgent agent takes the least urgent tile; the selected tile stays', () => {
    const r1 = task('r1', { status: 'running', lastUserActivityAt: ago(1 * H) });
    const r2 = task('r2', { status: 'running', lastUserActivityAt: ago(2 * H) });
    const r3 = task('r3', { status: 'running', lastUserActivityAt: ago(3 * H) });
    const asking = task('asking');
    // Two tiles, three working: the two you touched last.
    let shown = fillSlots([], [r1, r2, r3], [], 2);
    expect(shown).toEqual(['r1', 'r2']);
    // Same tier coming and going does not swap tiles: r3 (just touched) waits for a free one.
    const r3Touched = { ...r3, lastUserActivityAt: ago(0) };
    expect(fillSlots(shown, rank([r1, r2, r3Touched], []), [], 2)).toEqual(['r1', 'r2']);
    // Someone asks you something: it takes the least urgent tile's place, in that position.
    const open = [ask('asking', 'question', 1)];
    shown = fillSlots(shown, rank([r1, r2, r3, asking], open), open, 2);
    expect(shown).toEqual(['r1', 'asking']);
    // …unless that tile is the one you selected.
    expect(fillSlots(['r1', 'r2'], rank([r1, r2, r3, asking], open), open, 2, 'r2')).toEqual(['asking', 'r2']);
    // A finished agent leaves; the next one takes its tile, and the others stay put.
    expect(fillSlots(['r1', 'asking'], rank([r2, asking], open), open, 2)).toEqual(['r2', 'asking']);
    // A smaller layout drops the least urgent tiles.
    expect(fillSlots(['r1', 'r2', 'asking'], rank([r1, r2, asking], open), open, 1)).toEqual(['asking']);
  });

  it('set aside: folded under idle and out of the Overview until it works or needs you', () => {
    const fresh = { updatedAt: ago(10 * 60_000), lastUserActivityAt: ago(10 * 60_000) };
    const tasks = [task('aside', { status: 'done', setAside: true, ...fresh }), task('kept', { status: 'done', ...fresh }), task('asking', { status: 'waiting_for_user', setAside: true, ...fresh }), task('working', { status: 'running', setAside: true, ...fresh })];
    const open = [ask('aside', 'completion', 5), ask('asking', 'question', 2)];
    const [team] = teams(tasks, [{ projectId: 'p1', name: 'shop' }], open, NOW);
    expect(team.idle.map((t) => t.taskId)).toEqual(['aside']);
    expect(team.members.map((t) => t.taskId).sort()).toEqual(['asking', 'kept', 'working']);
    expect(overviewCandidates(tasks, open, NOW).map((t) => t.taskId)).not.toContain('aside');
    // Asking you or working outranks the user's "set aside".
    expect(isSetAside(tasks[2], open)).toBe(false);
    expect(isSetAside(tasks[3], open)).toBe(false);
    // Seeing a result is not setting aside: a seen, recent agent stays listed.
    expect(team.members.map((t) => t.taskId)).toContain('kept');
  });
});
