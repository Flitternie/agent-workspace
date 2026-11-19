import { describe, expect, it } from 'vitest';
import { mainLanes } from '../../src/shared/main-lanes';
import type { TranscriptItem } from '../../src/shared/types';

let n = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const user = (text: string): TranscriptItem => ({ id: `u${n++}`, taskId: 'main', role: 'user', text, createdAt: at() });
const tool = (name: string, result: string): TranscriptItem => ({
  id: `x${n++}`, taskId: 'main', role: 'tool', text: '', toolStatus: 'completed', createdAt: at(),
  tool: { name: `mcp__workspace__${name}`, kind: 'other', title: `workspace / ${name}`, locations: [], content: [{ type: 'text', text: result } as never] },
});
const sys = (text: string): TranscriptItem => ({ id: `s${n++}`, taskId: 'main', role: 'system', text, createdAt: at() });
const tasks = [
  { taskId: 't-ann', alias: 'Ann', name: 'Orders page', projectId: 'p-shop' },
  { taskId: 't-bob', alias: 'Bob', name: 'Paper intro', projectId: 'p-paper' },
  { taskId: 't-cat', alias: 'Cat', name: 'Orders API', projectId: 'p-shop' },
  { taskId: 't-dan', alias: 'Dan', name: 'Orders, other way', projectId: 'p-shop' },
];
const projects = [{ projectId: 'p-shop', name: 'shop' }, { projectId: 'p-paper', name: 'paper' }];

describe('the main agent as lanes', () => {
  it('gives every agent it handed work to a lane, in time order, gathered by project', () => {
    const items = [
      user('Fix the orders page'),
      tool('send_to_agent', 'Sent to Ann; it is working on it.'),
      user('And draft the paper intro'),
      tool('create_agent', 'Started Bob (claude) on paper: "Paper intro".'),
      user('Also the orders API'),
      tool('send_to_agent', "Added to Cat's current work; it will read it at its next step."),
      sys('Ann is waiting on you (question): "Which layout?"'),
      user('Try another way for the orders page'),
      tool('fork_agent', 'Forked Ann as Dan in its own worktree (amw/x); it is working on its instruction.'),
      tool('send_to_agent', 'Not delivered to Bob: not running'),
      sys('Someone is waiting on you (question): "x"'), // never handed work: no lane
    ];
    const { lanes, rows } = mainLanes(items, tasks, projects);
    // shop's agents together (Ann, Cat, Dan), then paper (Bob).
    // A fork's lane right after its origin: Dan (forked off Ann) before Cat.
    expect(lanes.map((l) => [l.alias, l.projectName])).toEqual([['Ann', 'shop'], ['Dan', 'shop'], ['Cat', 'shop'], ['Bob', 'paper']]);
    expect(rows.map((r) => [r.kind, r.lane, r.from])).toEqual([
      ['ask', 0, undefined],
      ['send', 1, undefined],
      ['ask', 0, undefined],
      ['create', 4, undefined],
      ['ask', 0, undefined],
      ['send', 3, undefined],
      ['waiting', 1, undefined],
      ['ask', 0, undefined],
      ['fork', 2, 1],
      ['failed', 4, undefined],
    ]);
    // Each lane runs from its first to its last event (Ann's goes on to the fork off it).
    expect(lanes.map((l) => [l.alias, l.first, l.last])).toEqual([['Ann', 1, 8], ['Dan', 8, 8], ['Cat', 5, 5], ['Bob', 3, 9]]);
    expect(rows[1].turnId).toBe(rows[0].itemId);
    expect(lanes[0].taskId).toBe('t-ann');
  });
});
