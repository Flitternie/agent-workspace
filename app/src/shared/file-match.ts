/**
 * @-mentions in a message box: the files (and folders) in an agent's folder that match what is typed
 * after @, best first. A name that starts with the query beats one that contains it, which beats a
 * path that contains it, which beats the letters in order with gaps (fuzzy); shorter paths win ties.
 */

export interface FileMatch {
  /** Relative to the agent's folder; a folder ends in /. */
  path: string;
  dir: boolean;
}

const base = (p: string) => p.slice(p.replace(/\/$/, '').lastIndexOf('/') + 1).replace(/\/$/, '');

/** Every folder the files are in (a/b/c.ts → a/, a/b/). */
export function foldersOf(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.indexOf('/');
    while (i !== -1) {
      dirs.add(f.slice(0, i + 1));
      i = f.indexOf('/', i + 1);
    }
  }
  return [...dirs];
}

function score(path: string, q: string): number {
  const p = path.toLowerCase();
  const name = base(p);
  if (name === q) return 4000 - path.length;
  if (name.startsWith(q)) return 3000 - path.length;
  const inName = name.indexOf(q);
  if (inName !== -1) return 2000 - inName * 10 - path.length;
  const inPath = p.indexOf(q);
  if (inPath !== -1) return 1000 - inPath - path.length / 10;
  // Letters in order: fewer gaps, earlier start is better.
  let at = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = p.indexOf(ch, at + 1);
    if (next === -1) return -1;
    if (at !== -1 && next > at + 1) gaps++;
    at = next;
  }
  return 500 - gaps * 20 - path.length / 10;
}

/**
 * The best matches for `query` among `files` (relative paths) and their folders. An empty query
 * lists the top level first. A query ending in / lists what is directly inside that folder.
 */
export function matchFiles(files: string[], query: string, limit = 50): FileMatch[] {
  const q = query.trim().toLowerCase();
  const entries: FileMatch[] = [...foldersOf(files).map((path) => ({ path, dir: true })), ...files.map((path) => ({ path, dir: false }))];
  if (!q || q.endsWith('/')) {
    const inside = entries.filter((e) => e.path.toLowerCase().startsWith(q) && e.path.length > q.length && !e.path.slice(q.length).replace(/\/$/, '').includes('/'));
    return inside.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path)).slice(0, limit);
  }
  return entries
    .map((e) => ({ e, s: score(e.path, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.e.path.length - b.e.path.length)
    .slice(0, limit)
    .map((x) => x.e);
}

/**
 * Full-width punctuation a Chinese (or Japanese) input method types in place of a path's: ＠ for @,
 * 。．for ., 、／ for /, ～ for ~. After @ they mean the path's own, so nobody has to switch input methods.
 */
const FULL_WIDTH: Record<string, string> = { '。': '.', '．': '.', '、': '/', '／': '/', '～': '~', '＿': '_', '－': '-' };
export const halfWidth = (s: string) => s.replace(/[。．、／～＿－]/g, (c) => FULL_WIDTH[c]);

/** The @-mention being typed just before the caret: its start (the @ or ＠) and what follows it (full-width punctuation as half-width); none when the caret is not in one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const m = /(^|\s)[@＠]([^\s@＠"]*)$/.exec(before);
  if (!m) return undefined;
  return { start: caret - m[2].length - 1, query: halfWidth(m[2]) };
}

/** How a chosen path goes into the message: @path, quoted when it has spaces; a file is followed by a space. */
export function mentionText(m: FileMatch): string {
  const ref = /\s/.test(m.path) ? `@"${m.path}"` : `@${m.path}`;
  return m.dir ? ref : `${ref} `;
}

/** Looks like a file or folder (has a / or an extension), not a person: "@src/a.ts", "@README.md", "@../docs/" but not "@Alice". */
export function pathLike(ref: string): boolean {
  return ref.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(ref);
}

/**
 * The @-mentions in a message: @path or @"path with spaces", at the start or after a space or
 * bracket, path-like only. Trailing punctuation ("see @a.ts.") is not part of the path.
 */
export function splitMentions(text: string): Array<{ text: string; path?: string }> {
  const out: Array<{ text: string; path?: string }> = [];
  const re = /(^|[\s(（])@(?:"([^"\n]+)"|([^\s"@]+))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    let raw = m[3] ?? m[2];
    let tail = '';
    if (m[3]) {
      const t = /[.,;:!?)）。，；：！？]+$/.exec(raw);
      if (t && t[0].length < raw.length) {
        tail = t[0];
        raw = raw.slice(0, -tail.length);
      }
    }
    if (!pathLike(raw)) continue;
    const start = (m.index ?? 0) + m[1].length;
    const token = m[0].slice(m[1].length, m[0].length - tail.length);
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: token, path: raw });
    last = start + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** A whole @-mention just before the caret (Backspace there removes it at once): its start, or undefined. */
export function mentionBefore(text: string, caret: number): number | undefined {
  const m = /(^|\s)(@(?:"[^"\n]+"|[^\s"@]+))$/.exec(text.slice(0, caret));
  if (!m) return undefined;
  const ref = m[2].slice(1).replace(/^"|"$/g, '');
  return pathLike(ref) ? caret - m[2].length : undefined;
}

/**
 * What is typed after @ that browses folders instead of searching the agent's own: a path starting
 * with ../, /, ~/ (or just ~). Split into the folder to list (as typed) and the start of a name in it.
 */
export function browsePath(query: string): { parent: string; prefix: string } | undefined {
  if (!/^(\.\.\/|\/|~\/|~$)/.test(query)) return undefined;
  if (query === '~') return { parent: '~/', prefix: '' };
  const slash = query.lastIndexOf('/');
  return { parent: query.slice(0, slash + 1), prefix: query.slice(slash + 1) };
}
