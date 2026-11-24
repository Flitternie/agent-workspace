import { describe, expect, it } from 'vitest';
import { foldsTurn, OPEN_TURNS, splitTurns, turnSummary } from '../../src/renderer/components/Content';
import type { TranscriptItem } from '../../src/shared/types';

let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const user = (text: string, s = 0): TranscriptItem => ({ id: `u${n++}`, taskId: 't', role: 'user', text, createdAt: at(s) });
const say = (text: string, s = 0, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id: `a${n++}`, taskId: 't', role: 'assistant', text, createdAt: at(s), ...extra });
const tool = (kind: string, path: string, s = 0, status: TranscriptItem['toolStatus'] = 'completed'): TranscriptItem => ({
  id: `x${n++}`, taskId: 't', role: 'tool', text: '', toolStatus: status, createdAt: at(s),
  tool: { name: kind, kind: kind as never, title: `${kind} ${path}`, locations: [{ path }], content: [] },
});

describe('turns', () => {
  it('splits at each of your messages; the last message of the agent is the answer', () => {
    const items = [say('hello before anything'), user('fix it', 0), tool('read', 'a.ts'), say('looking'), tool('edit', 'a.ts'), say('Fixed.', 90), user('thanks')];
    const turns = splitTurns(items);
    expect(turns.map((t) => [t.user?.text, t.steps.length, t.final?.text])).toEqual([
      [undefined, 0, 'hello before anything'],
      ['fix it', 3, 'Fixed.'],
      ['thanks', 0, undefined],
    ]);
  });

  it(`folds only turns before the latest ${OPEN_TURNS}, never one still going, and only with steps to fold`, () => {
    const done = { user: user('x'), steps: [tool('read', 'a'), tool('read', 'b')], final: say('ok'), live: false };
    expect(foldsTurn(done, 0, OPEN_TURNS + 1)).toBe(true);
    expect(foldsTurn(done, 1, OPEN_TURNS + 1)).toBe(false); // one of the latest
    expect(foldsTurn({ ...done, live: true }, 0, OPEN_TURNS + 1)).toBe(false);
    expect(foldsTurn({ ...done, steps: [tool('read', 'a')] }, 0, OPEN_TURNS + 1)).toBe(false);
    expect(splitTurns([user('go'), tool('execute', 'npm test', 0, 'running')])[0].live).toBe(true);
    // Settings › Advanced: the latest 3 open, or every turn (0).
    expect(foldsTurn(done, 1, 4, 3)).toBe(false);
    expect(foldsTurn(done, 0, 4, 3)).toBe(true);
    expect(foldsTurn(done, 0, 9, 0)).toBe(false);
  });

  it('sums a folded turn up: steps, files edited, commands, failures, time', () => {
    const turn = splitTurns([user('go', 0), tool('read', 'a.ts'), tool('edit', 'a.ts'), tool('edit', 'a.ts'), tool('edit', 'b.ts'), tool('execute', 'npm test', 0, 'failed'), tool('execute', 'npm test'), say('Done.', 130)])[0];
    expect(turnSummary(turn)).toBe('6 steps · edited 2 files · ran 2 commands · 1 failed · 2 min');
  });

  it('a message added while the agent worked joins that turn; one that stopped it starts a new one', () => {
    const u = (id: string, delivery?: 'steer' | 'interrupt') => ({ id, taskId: 't', role: 'user' as const, text: id, createdAt: '2026-01-01T00:00:00Z', ...(delivery ? { delivery } : {}) });
    const a = (id: string) => ({ id, taskId: 't', role: 'assistant' as const, text: id, createdAt: '2026-01-01T00:00:00Z' });
    const turns = splitTurns([u('ask'), a('working'), u('also this', 'steer'), a('done'), u('next'), a('ok'), u('stop, do that', 'interrupt'), a('fine')] as never);
    expect(turns.map((x) => x.user?.text)).toEqual(['ask', 'next', 'stop, do that']);
    expect(turns[0].steps.map((x) => x.text)).toEqual(['working', 'also this']);
    expect(turns[0].final?.text).toBe('done');
  });
});
