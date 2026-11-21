import { useCallback, useSyncExternalStore } from 'react';
import type { ImageRef } from '../shared/types';

// What is typed to an agent but not sent yet, kept per agent: leaving its page (for the Overview
// or another agent) and coming back finds the message where it was, and the agent's page and its
// Overview tile show the same unsent text. The text is kept on this machine across restarts; the
// images waiting with it only while the app is open (they are stored files, prepared again easily).

const KEY = 'amw.drafts';
/** Unsent messages kept at most; the oldest go first (agents removed long ago, mostly). */
const MAX = 50;

type Listener = () => void;
const listeners = new Set<Listener>();
let texts: Record<string, string> = load();
const images = new Map<string, ImageRef[]>();

function load(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1]));
  } catch {
    return {};
  }
}

function save(): void {
  try {
    if (Object.keys(texts).length) localStorage.setItem(KEY, JSON.stringify(texts));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage full or unavailable: the draft still lives for this session.
  }
  for (const l of listeners) l();
}

export function draftText(taskId: string): string {
  return texts[taskId] ?? '';
}

export function setDraftText(taskId: string, text: string): void {
  if ((texts[taskId] ?? '') === text) return;
  // Re-inserted at the end, so the object's order is oldest-edited first and trimming drops those.
  const { [taskId]: _old, ...rest } = texts;
  texts = text ? { ...rest, [taskId]: text } : rest;
  const ids = Object.keys(texts);
  if (ids.length > MAX) for (const id of ids.slice(0, ids.length - MAX)) delete texts[id];
  save();
}

/** Forget drafts of agents that are gone (removed, or from another data folder). */
export function pruneDrafts(liveTaskIds: Iterable<string>): void {
  const live = new Set(liveTaskIds);
  for (const id of images.keys()) if (!live.has(id)) images.delete(id);
  const gone = Object.keys(texts).filter((id) => !live.has(id));
  if (!gone.length) return;
  texts = Object.fromEntries(Object.entries(texts).filter(([id]) => live.has(id)));
  save();
}

/** Images waiting to go with an agent's next message (kept while the app runs). */
export function draftImages(taskId: string): ImageRef[] {
  return images.get(taskId) ?? [];
}

export function setDraftImages(taskId: string, refs: ImageRef[]): void {
  if (refs.length) images.set(taskId, refs);
  else images.delete(taskId);
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/**
 * The unsent message to an agent, as state: every box showing that agent's draft follows it.
 * The setter takes a value or an update, like useState's.
 */
export function useDraft(taskId: string): [string, (next: string | ((cur: string) => string)) => void] {
  const text = useSyncExternalStore(subscribe, () => draftText(taskId));
  const set = useCallback(
    (next: string | ((cur: string) => string)) => setDraftText(taskId, typeof next === 'function' ? next(draftText(taskId)) : next),
    [taskId],
  );
  return [text, set];
}
