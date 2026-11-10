import { createContext } from 'react';
import { previewKind } from '../../shared/preview';

/** Set by the agent view: what a click on a file (a tool row's Preview, a path in a message) does. */
export const PreviewContext = createContext<{ preview(path: string): void; openExternal?: (path: string) => void } | null>(null);

// File paths in agent messages become preview links: absolute (/…), home (~/…) and
// relative (docs/a.md, ./a.md, ../a.md, README.md) paths to a file the preview can show.
// A trailing :line or :line:col (as agents write them) is dropped. The main process
// still checks every path (inside the agent's folder or project only).

/** The scheme the links carry inside the Markdown tree (never a real URL). */
export const FILE_SCHEME = 'amw-file:';

const EXT = '(?:md|markdown|html?|png|jpe?g|gif|svg|webp|txt|json|csv|tsv|log|ya?ml|toml|xml)';
// Not inside a URL or a longer word; segments are path-ish characters (no spaces in plain text).
const PATH_RE = new RegExp(`(?<![\\w/.~:@-])((?:~/|\\.{1,2}/|/)?(?:[\\w@+.-]+/)*[\\w@+.-]*[\\w@+-]\\.${EXT})(?::\\d+(?::\\d+)?)?(?![\\w/-])`, 'gi');

/** A previewable path in a whole string (an inline code span or a link target), or undefined. */
export function fileTarget(raw: string): string | undefined {
  let s = raw.trim().replace(/^file:\/\//i, '');
  if (!s || /^[a-z][\w+.-]*:\/\//i.test(s) || /^(mailto|data):/i.test(s)) return undefined;
  s = s.replace(/:\d+(?::\d+)?$/, '').replace(/#.*$/, '');
  try {
    s = decodeURI(s);
  } catch {
    /* keep as written */
  }
  if (/[\n\r]/.test(s) || !previewKind(s)) return undefined;
  return s;
}

/** Plain text split into text and file-path pieces. */
export function splitPaths(text: string): Array<{ text: string; path?: string }> {
  const out: Array<{ text: string; path?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const at = m.index ?? 0;
    // "github.com/x/README.md" is a URL without its scheme, not a file (full URLs never match: see the lookbehind).
    if (/^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\//i.test(m[1])) continue;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: m[0], path: m[1] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

type Node = { type: string; value?: string; url?: string; children?: Node[] };

/**
 * remark plugin: text and inline code naming a previewable file become links with the
 * FILE_SCHEME, and so do Markdown links whose target is such a file. Code blocks and
 * existing web links stay as they are.
 */
export function remarkFilePaths() {
  const walk = (node: Node, inLink: boolean) => {
    if (!node.children) return;
    const next: Node[] = [];
    for (const child of node.children) {
      if (child.type === 'link') {
        const target = fileTarget(child.url ?? '');
        if (target) child.url = FILE_SCHEME + encodeURIComponent(target);
        walk(child, true);
        next.push(child);
      } else if (!inLink && child.type === 'inlineCode' && child.value) {
        const target = fileTarget(child.value);
        next.push(target ? { type: 'link', url: FILE_SCHEME + encodeURIComponent(target), children: [child] } : child);
      } else if (!inLink && child.type === 'text' && child.value) {
        for (const piece of splitPaths(child.value))
          next.push(piece.path ? { type: 'link', url: FILE_SCHEME + encodeURIComponent(piece.path), children: [{ type: 'text', value: piece.text }] } : { type: 'text', value: piece.text });
      } else {
        if (child.type !== 'code') walk(child, inLink);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: Node) => walk(tree, false);
}
