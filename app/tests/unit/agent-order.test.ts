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
  it('puts what waits on you first (longest waiting first), then work in progress (first started on top), then the rest', () => {
    const tasks = [
      task('idleLate', { statusSince: ago(1 * H) }),
      task('runningLate', { status: 'running', statusSince: ago(2 * H) }),
      task('askedLate'),
      task('runningEarly', { status: 'running', statusSince: ago(4 * H) }),
      task('askedEarly'),
      task('unread', { status: 'done', statusSince: ago(3 * H) }),
      task('idleEarly', { statusSince: ago(5 * H) }),
    ];
    const open = [ask('askedLate', 'question', 5), ask('askedEarly', 'approval', 30), ask('unread', 'completion', 1)];
    expect(rank(tasks, open).map((t) => t.taskId)).toEqual(['askedEarly', 'askedLate', 'runningEarly', 'runningLate', 'idleEarly', 'unread', 'idleLate']);
    expect(needsYou(tasks, open).map((t) => t.taskId)).toEqual(['askedEarly', 'askedLate']);
    expect(tierOf(tasks[5], open)).toBe(2);
  });

  it('two agents start one after the other: the first stays on top, also across projects', () => {
    const projects = [
      { projectId: 'shop', name: 'shop' },
      { projectId: 'legal', name: 'legal' },
    ];
    const first = task('first', { projectId: 'shop', status: 'running', statusSince: ago(10 * 60_000), lastUserActivityAt: ago(10 * 60_000) });
    // Just started, and just touched by the user, in another project.
    const next = task('next', { projectId: 'legal', status: 'starting', createdAt: ago(0), statusSince: ago(0), lastUserActivityAt: ago(0) });
    expect(rank([next, first], []).map((t) => t.taskId)).toEqual(['first', 'next']);
    expect(teams([next, first], projects, [], NOW).map((t) => t.project.name)).toEqual(['shop', 'legal']);
  });

  it('an agent that starts waiting on you rises to the top; one that finishes drops to the next group', () => {
    const projects = [
      { projectId: 'shop', name: 'shop' },
      { projectId: 'legal', name: 'legal' },
    ];
    const a = task('a', { projectId: 'shop', status: 'running', statusSince: ago(3 * H) });
    const b = task('b', { projectId: 'legal', status: 'running', statusSince: ago(2 * H) });
    const c = task('c', { projectId: 'legal', status: 'running', statusSince: ago(1 * H) });
    const idle = task('idle', { projectId: 'shop', statusSince: ago(5 * H) });
    expect(rank([a, b, c, idle], []).map((t) => t.taskId)).toEqual(['a', 'b', 'c', 'idle']);
    // c asks something: it goes first, and its team with it.
    const asking = { ...c, status: 'waiting_for_user' as const, statusSince: ago(0) };
    const open = [ask('c', 'approval', 0)];
    expect(rank([a, b, asking, idle], open).map((t) => t.taskId)).toEqual(['c', 'a', 'b', 'idle']);
    expect(teams([a, b, asking, idle], projects, open, NOW).map((t) => t.project.name)).toEqual(['legal', 'shop']);
    // a finishes: it joins the end of the rest, b now leads, so does b's team.
    const done = { ...a, status: 'done' as const, statusSince: ago(0) };
    expect(rank([done, b, c, idle], []).map((t) => t.taskId)).toEqual(['b', 'c', 'idle', 'a']);
    expect(teams([done, b, c, idle], projects, [], NOW).map((t) => t.project.name)).toEqual(['legal', 'shop']);
  });

  it('does not reshuffle on output, messages or reading a report: only a change of group moves an agent', () => {
    const a = task('a', { status: 'running', statusSince: ago(2 * H), updatedAt: ago(2 * H) });
    const b = task('b', { status: 'running', statusSince: ago(1 * H), updatedAt: ago(0), lastUserActivityAt: ago(0) });
    expect(rank([b, a], []).map((t) => t.taskId)).toEqual(['a', 'b']);
    // An unread report and a read one sit in the same group: reading it moves nothing.
    const x = task('x', { status: 'done', statusSince: ago(2 * H) });
    const y = task('y', { status: 'done', statusSince: ago(1 * H) });
    expect(rank([y, x], [ask('y', 'completion', 60)]).map((t) => t.taskId)).toEqual(['x', 'y']);
    expect(rank([y, x], []).map((t) => t.taskId)).toEqual(['x', 'y']);
  });

  it('groups agents into project teams; idle members fold away; the team with someone waiting comes first', () => {
    const projects = [
      { projectId: 'shop', name: 'shop' },
      { projectId: 'legal', name: 'legal' },
      { projectId: 'old', name: 'old' },
    ];
    const tasks = [
      task('s1', { projectId: 'shop', lastUserActivityAt: ago(1 * H), statusSince: ago(10 * 24 * H) }),
      task('s2', { projectId: 'shop', updatedAt: ago(IDLE_AFTER_MS + H), statusSince: ago(IDLE_AFTER_MS + H) }),
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
    const r1 = task('r1', { status: 'running', statusSince: ago(3 * H) });
    const r2 = task('r2', { status: 'running', statusSince: ago(2 * H) });
    const r3 = task('r3', { status: 'running', statusSince: ago(1 * H) });
    const asking = task('asking');
    // Two tiles, three working: the two that started first.
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
    // Set aside means hidden, even with a question it ended on (asked before it was set aside):
    // not in "Needs you", not among the members, not on the Overview. The main process clears the
    // flag when something new happens, which is what brings an agent back.
    expect(team.idle.map((t) => t.taskId).sort()).toEqual(['aside', 'asking', 'working']);
    expect(team.members.map((t) => t.taskId)).toEqual(['kept']);
    expect(overviewCandidates(tasks, open, NOW).map((t) => t.taskId)).toEqual(['kept']);
    expect(needsYou(tasks, open).map((t) => t.taskId)).toEqual([]);
    expect(isSetAside(tasks[2], open)).toBe(true);
    // Not set aside: the same question puts it in "Needs you".
    expect(needsYou([{ ...tasks[2], setAside: undefined }], open).map((t) => t.taskId)).toEqual(['asking']);
    // Seeing a result is not setting aside: a seen, recent agent stays listed.
    expect(team.members.map((t) => t.taskId)).toContain('kept');
  });

  it('folds a member into idle after the chosen time, or never', () => {
    const projects = [{ projectId: 'p1', name: 'shop' }];
    const two = task('two', { updatedAt: ago(2 * 24 * H), lastUserActivityAt: ago(2 * 24 * H) });
    expect(teams([two], projects, [], NOW)[0].members.map((t) => t.taskId)).toEqual(['two']); // default 3 days
    expect(teams([two], projects, [], NOW, 24 * H)[0].idle.map((t) => t.taskId)).toEqual(['two']);
    const old = task('old');
    expect(teams([old], projects, [], NOW, Infinity)[0].members.map((t) => t.taskId)).toEqual(['old']);
  });
});
