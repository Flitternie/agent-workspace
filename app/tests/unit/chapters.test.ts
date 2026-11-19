import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chapterDue, chapters, chapterStart, IDLE_NEW, IDLE_SOME, LONG_TURNS, PAUSE, SOME_TURNS } from '../../src/shared/chapters';
import type { TranscriptItem } from '../../src/shared/types';

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 18, 9);
let n = 0;
const user = (at: number): TranscriptItem => ({ id: `u${n++}`, taskId: 'm', role: 'user', text: 'hi', createdAt: new Date(at).toISOString() });
const mark = (at: number): TranscriptItem => ({ id: `c${n++}`, taskId: 'm', role: 'system', text: 'New chapter', chapter: { reason: 'manual' }, createdAt: new Date(at).toISOString() });
const turns = (k: number, from = T0) => Array.from({ length: k }, (_, i) => user(from + i * 60_000));

describe('when the main agent starts a new chapter', () => {
  it('after a long pause (overnight), whatever the length', () => {
    const items = turns(3);
    expect(chapterDue(items, T0 + IDLE_NEW + 3 * 60_000)).toBe('idle');
    expect(chapterDue(items, T0 + IDLE_NEW - H)).toBeNull();
  });
  it('after a shorter pause only when the chapter has many turns already', () => {
    const few = turns(SOME_TURNS - 1);
    const some = turns(SOME_TURNS);
    const later = T0 + SOME_TURNS * 60_000 + IDLE_SOME;
    expect(chapterDue(few, later)).toBeNull();
    expect(chapterDue(some, later)).toBe('idle');
  });
  it('a very long chapter starts over at the next pause, not mid-flow', () => {
    const long = turns(LONG_TURNS);
    const end = T0 + (LONG_TURNS - 1) * 60_000;
    expect(chapterDue(long, end + 60_000)).toBeNull();
    expect(chapterDue(long, end + PAUSE)).toBe('long');
  });
  it('counts only the current chapter; nothing said in it yet is nothing to close', () => {
    const items = [...turns(LONG_TURNS), mark(T0 + 2 * H), ...turns(2, T0 + 2 * H)];
    expect(chapterStart(items)).toBe(LONG_TURNS);
    expect(chapterDue(items, T0 + 3 * H)).toBeNull();
    expect(chapterDue([...turns(2), mark(T0 + H)], T0 + IDLE_NEW * 2)).toBeNull();
    expect(chapters(items).map((c) => c.items.length)).toEqual([LONG_TURNS, 3]);
  });
});

const opened: Array<{ shutdown(): Promise<void> }> = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.shutdown();
});

describe('a new chapter in the workspace', () => {
  it('marks the conversation, starts a fresh session, and hands over what is going on now', async () => {
    const { Workspace } = await import('../../src/main/workspace');
    const ws = new Workspace({ dataDir: mkdtempSync(join(tmpdir(), 'amw-chap-')), adapters: {} });
    opened.push(ws);
    const d = ws.store.data;
    d.projects.push({ projectId: 'p1', name: 'shop', rootPath: '/tmp', createdAt: '' } as never);
    d.tasks.push({ taskId: 't1', alias: 'Ann', name: 'Orders page', projectId: 'p1', title: 'Orders', provider: 'mock', status: 'running', summary: 'Adding pagination', cwd: '/tmp', createdAt: '', updatedAt: new Date().toISOString() } as never);
    d.mainAgent = { taskId: 'main', alias: 'Main', name: 'Main agent', projectId: '', title: '', provider: 'mock', status: 'idle', summary: '', cwd: '/tmp', createdAt: '', updatedAt: '', sessionLocalId: 's-old' } as never;
    ws.store.transcript('main').push(user(Date.now() - H));
    await ws.newMainChapter('manual');
    const items = ws.store.transcript('main');
    expect(items.at(-1)).toMatchObject({ role: 'system', chapter: { reason: 'manual' } });
    expect((d.mainAgent as { sessionLocalId?: string }).sessionLocalId).toBeUndefined();
    const handover = (ws as unknown as { pendingHandover?: string }).pendingHandover ?? '';
    expect(handover).toContain('new chapter');
    expect(handover).toContain('Ann (shop, Orders page): running — Adding pagination');
    // Again right away: nothing said in the new chapter, nothing to close.
    await ws.newMainChapter('manual');
    expect(ws.store.transcript('main').filter((x) => x.chapter).length).toBe(1);
  });
});
