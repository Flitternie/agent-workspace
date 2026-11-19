import type { TranscriptItem } from './types';

// The main agent's conversation in chapters. A new chapter starts a fresh session for it, handed
// over what is going on now (not the whole past), so what the user was busy with days ago does
// not crowd what they are busy with now. The user starts one by hand, or the app does when the
// user comes back after a long pause or a chapter has grown long: time and turns together.

/** Where the current chapter starts (the index of its marker, or 0). */
export function chapterStart(items: TranscriptItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].chapter) return i;
  return 0;
}

/** The chapters, oldest first: each its items and how it started. */
export function chapters(items: TranscriptItem[]): Array<{ start: number; at: string; reason?: 'manual' | 'idle' | 'long'; items: TranscriptItem[] }> {
  const marks = items.map((x, i) => (x.chapter ? i : -1)).filter((i) => i >= 0);
  const starts = marks[0] === 0 ? marks : [0, ...marks];
  return starts.map((start, k) => ({
    start,
    at: items[start]?.createdAt ?? '',
    reason: items[start]?.chapter?.reason,
    items: items.slice(start, starts[k + 1] ?? items.length),
  }));
}

const HOUR = 3600_000;
/** Back after this long: a new chapter (overnight, or longer). */
export const IDLE_NEW = 16 * HOUR;
/** Back after this long, with at least LONG_TURNS in the chapter: a new one. */
export const IDLE_SOME = 4 * HOUR;
export const SOME_TURNS = 20;
/** A chapter this long starts over at the next pause of PAUSE. */
export const LONG_TURNS = 60;
export const PAUSE = 0.5 * HOUR;

/** Whether the user's next message to the main agent should open a new chapter, and why. */
export function chapterDue(items: TranscriptItem[], now: number): 'idle' | 'long' | null {
  const current = items.slice(chapterStart(items));
  const asks = current.filter((x) => x.role === 'user');
  if (!asks.length) return null;
  const idle = now - Date.parse(asks[asks.length - 1].createdAt);
  if (idle >= IDLE_NEW) return 'idle';
  if (idle >= IDLE_SOME && asks.length >= SOME_TURNS) return 'idle';
  if (asks.length >= LONG_TURNS && idle >= PAUSE) return 'long';
  return null;
}
