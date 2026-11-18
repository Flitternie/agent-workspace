import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeGrouping, parseGrouping, PAUSE_MS, sessionMap, turnsDigest } from '../../src/shared/session-map';
import type { TranscriptItem } from '../../src/shared/types';
import { Workspace } from '../../src/main/workspace';

const T0 = Date.parse('2026-11-18T10:00:00Z');
let n = 0;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const user = (text: string, min: number, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id: `u${++n}`, taskId: 't', role: 'user', text, createdAt: at(min), ...extra });
const said = (text: string, min: number): TranscriptItem => ({ id: `a${++n}`, taskId: 't', role: 'assistant', text, createdAt: at(min) });
const tool = (name: string, kind: string, min: number, content: unknown[] = [], title = name): TranscriptItem =>
  ({ id: `x${++n}`, taskId: 't', role: 'tool', text: '', createdAt: at(min), toolStatus: 'completed', tool: { name, kind, title, locations: [], content } }) as unknown as TranscriptItem;
const diff = (path: string) => ({ type: 'diff', diff: { path, operation: 'modify', phase: 'applied', hunks: [], added: 1, removed: 0 } });

const session = () => [
  user('Migrate the orders API to v2', 0),
  tool('TodoWrite', 'think', 1),
  tool('Edit', 'edit', 2, [diff('src/orders.ts')]),
  said('Done the endpoints. Keep v1 compatibility?', 3),
  user('好的', 4),
  tool('Bash', 'execute', 5),
  user('also fix the totals rounding', 6),
  tool('Edit', 'edit', 7, [diff('src/total.ts'), diff('src/orders.ts')]),
  user('接下来做退款流程', 8),
  tool('Edit', 'edit', 9, [diff('src/refund.ts')]),
];

describe('session map', () => {
  it('groups turns the way the model says, with its titles; newer turns join its last task', () => {
    const items = [...session(), user('and the refund emails', 10)];
    const map = sessionMap(items, [], { turns: 4, tasks: [{ start: 0, title: '订单接口迁移到 v2' }, { start: 3, title: '退款流程' }] });
    expect(map.map((t) => [t.title, t.turnIds.length])).toEqual([
      ['订单接口迁移到 v2', 3],
      ['退款流程', 2],
    ]);
    expect(map[0].files).toEqual(['src/orders.ts', 'src/total.ts']);
    expect(map[0].commands).toBe(1);
  });

  it('without the model: structure only (a second plan, a long pause), never the wording', () => {
    // The same words that would "say" a new task change nothing without a model.
    expect(sessionMap(session()).map((t) => t.turnIds.length)).toEqual([4]);
    const items = [user('Build the dashboard', 0), tool('TodoWrite', 'think', 1), user('more', 2), user('settings', 3), tool('TodoWrite', 'think', 4), user('later', 4 + PAUSE_MS / 60_000 + 1)];
    expect(sessionMap(items).map((t) => [t.title, t.turnIds.length])).toEqual([
      ['Build the dashboard', 2],
      ['settings', 1],
      ['later', 1],
    ]);
    // A grouping that does not fit the turns is ignored.
    expect(sessionMap(items, [], { turns: 9, tasks: [{ start: 2, title: 'x' }] }).length).toBe(3);
  });

  it('decisions come from structured records: approvals and answers given, turns stopped to change course', () => {
    const items: TranscriptItem[] = [
      user('Clean up the build', 0),
      { id: 's1', taskId: 't', role: 'system', text: 'whatever the wording', createdAt: at(1), decision: { kind: 'approval', label: 'Allow once', about: 'rm -rf dist' } },
      { id: 's2', taskId: 't', role: 'system', text: 'Approval decision sent to claude: Allow', createdAt: at(2) },
      user('stop, keep the old dist folder', 3, { delivery: 'interrupt' }),
    ];
    const [task] = sessionMap(items);
    expect(task.decisions).toEqual([
      { itemId: 's1', turnId: items[0].id, kind: 'approval', label: 'Allow once', about: 'rm -rf dist' },
      { itemId: items[3].id, turnId: items[3].id, kind: 'redirect', label: 'stop, keep the old dist folder' },
    ]);
  });

  it('hangs forked agents off the task under way when they were made', () => {
    const items = [user('Task one', 0), user('Task two', 30)];
    const map = sessionMap(items, [{ taskId: 'f1', alias: 'B', name: 'Try another way', createdAt: at(10) }], { turns: 2, tasks: [{ start: 0, title: 'one' }, { start: 1, title: 'two' }] });
    expect(map[0].branches).toEqual([{ taskId: 'f1', alias: 'B', name: 'Try another way' }]);
    expect(map[1].branches).toEqual([]);
  });

  it('checks the model answer: JSON with starts in order from 0, within the turns', () => {
    expect(parseGrouping('Sure:\n{"tasks":[{"start":0,"title":"A"},{"start":3,"title":"B"}]}', 5)).toEqual({ version: 2, turns: 5, tasks: [{ start: 0, title: 'A' }, { start: 3, title: 'B' }] });
    expect(parseGrouping('{"tasks":[{"start":1,"title":"A"}]}', 5)).toBeNull();
    expect(parseGrouping('{"tasks":[{"start":0,"title":"A"},{"start":0,"title":"B"}]}', 5)).toBeNull();
    expect(parseGrouping('no json', 5)).toBeNull();
  });

  it('the digest gives the model what was asked, what came of it, and structural hints', () => {
    const digest = turnsDigest(session());
    expect(digest).toContain('[0] user: Migrate the orders API to v2');
    expect(digest).toContain('agent: Done the endpoints. Keep v1 compatibility?');
    expect(digest).toContain('(new plan; files: src/orders.ts)');
    expect(digest).toContain('[3] user: 接下来做退款流程');
  });

  it('asks the model once per new turns and keeps its answer', async () => {
    const asked: string[] = [];
    const ws = new Workspace({ dataDir: mkdtempSync(join(tmpdir(), 'amw-map-')), adapters: {}, backgroundModel: async (_s, prompt) => (asked.push(prompt), '{"tasks":[{"start":0,"title":"Orders v2"},{"start":3,"title":"Refunds"}]}') });
    const store = (ws as unknown as { store: { setTranscript(id: string, items: TranscriptItem[]): void } }).store;
    store.setTranscript('t', session());
    expect((await ws.sessionMapGrouping('t'))?.tasks.map((t) => t.title)).toEqual(['Orders v2', 'Refunds']);
    await ws.sessionMapGrouping('t');
    expect(asked.length).toBe(1);
    store.setTranscript('t', [...session(), user('and the refund emails', 20)]);
    await ws.sessionMapGrouping('t');
    expect(asked.length).toBe(2);
  });

  it('keeps outcome, status and decisions only where they are grounded in the task’s own turns', () => {
    const g = parseGrouping(
      JSON.stringify({
        tasks: [
          { start: 0, title: 'Orders v2', outcome: 'Endpoints moved, v1 kept', status: 'done', decisions: [{ turn: 1, decision: 'Keep v1 compatibility', rejected: 'Drop v1' }, { turn: 4, decision: 'outside its task' }] },
          { start: 3, title: 'Refunds', status: 'weird', decisions: [{ turn: 9, decision: 'not a turn' }] },
        ],
      }),
      5,
    )!;
    expect(g.tasks[0]).toEqual({ start: 0, title: 'Orders v2', outcome: 'Endpoints moved, v1 kept', status: 'done', decisions: [{ turn: 1, decision: 'Keep v1 compatibility', rejected: 'Drop v1' }] });
    expect(g.tasks[1]).toEqual({ start: 3, title: 'Refunds' });
    const map = sessionMap(session(), [], g);
    expect(map[0].decisions).toEqual([{ itemId: map[0].turnIds[1], turnId: map[0].turnIds[1], kind: 'decided', label: 'Keep v1 compatibility', about: 'Drop v1' }]);
    expect([map[0].outcome, map[0].status]).toEqual(['Endpoints moved, v1 kept', 'done']);
  });

  it('an update keeps the earlier tasks and replaces from the latest one', () => {
    const earlier = { version: 2, turns: 4, tasks: [{ start: 0, title: 'A' }, { start: 3, title: 'B' }] };
    const fresh = parseGrouping('{"tasks":[{"start":3,"title":"B, renamed"},{"start":5,"title":"C"}]}', 6, 3)!;
    expect(mergeGrouping(earlier, fresh).tasks.map((t) => t.title)).toEqual(['A', 'B, renamed', 'C']);
    // An update must start at the latest task.
    expect(parseGrouping('{"tasks":[{"start":0,"title":"X"}]}', 6, 3)).toBeNull();
  });

  it('the reader can merge a task into the one before, or start one at a turn', () => {
    const items = session();
    const g = { version: 2, turns: 4, tasks: [{ start: 0, title: 'Orders' }, { start: 3, title: 'Refunds' }] };
    const merged = sessionMap(items, [], g, { merged: [items[8].id] });
    expect(merged.map((t) => [t.title, t.turnIds.length])).toEqual([['Orders', 4]]);
    const split = sessionMap(items, [], g, { split: [items[6].id] });
    expect(split.map((t) => t.turnIds.length)).toEqual([2, 1, 1]);
  });

  it('a decision keeps the options that were offered, the chosen one marked', () => {
    const items: TranscriptItem[] = [
      user('Pick a bundler', 0),
      { id: 's1', taskId: 't', role: 'system', text: '', createdAt: at(1), decision: { kind: 'answer', label: 'Vite', about: 'Which bundler?', options: [{ label: 'Vite', chosen: true }, { label: 'webpack', chosen: false }] } },
    ];
    expect(sessionMap(items)[0].decisions[0].options).toEqual([
      { label: 'Vite', chosen: true },
      { label: 'webpack', chosen: false },
    ]);
  });
});
