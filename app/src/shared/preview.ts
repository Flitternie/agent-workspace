import type { PreviewKind } from './types';

// Which files the preview column can show, by extension. Shared so the transcript
// offers "Preview" only where the main process will agree to read the file.

const KINDS: Record<string, PreviewKind> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  ...Object.fromEntries(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].map((e) => [e, 'image' as const])),
  ...Object.fromEntries(['txt', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'xml'].map((e) => [e, 'text' as const])),
};

export function previewKind(file: string): PreviewKind | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(file);
  return m ? KINDS[m[1].toLowerCase()] : undefined;
}

/** POSIX `path.resolve` for the renderer (no node:path there): `p` against `base`, `.` and `..` folded. */
export function resolvePosix(base: string, p: string): string {
  const out: string[] = [];
  for (const part of (p.startsWith('/') ? p : `${base}/${p}`).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return `/${out.join('/')}`;
}

export function dirnamePosix(p: string): string {
  return p.slice(0, p.lastIndexOf('/')) || '/';
}
