import type { PreviewKind } from './types';

// Which files the preview column can show, by extension. Shared so the transcript
// offers "Preview" only where the main process will agree to read the file.

/** Source files, by extension → highlight.js language (those in its common set get colours). */
const CODE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', ipynb: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', scala: 'scala', dart: 'dart',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', m: 'objectivec', mm: 'objectivec', cs: 'csharp',
  rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua', r: 'r', jl: 'julia', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', clj: 'clojure',
  css: 'css', scss: 'scss', less: 'less', sql: 'sql', graphql: 'graphql', proto: 'protobuf',
  vue: 'xml', svelte: 'xml', tex: 'latex', ini: 'ini', cfg: 'ini', conf: 'ini', diff: 'diff', patch: 'diff', gradle: 'gradle', tf: 'hcl', nix: 'nix',
};

/** Text files that also get colours. */
const TEXT_LANG: Record<string, string> = { json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', xml: 'xml' };

const KINDS: Record<string, PreviewKind> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
  // Office documents, converted by macOS's textutil.
  ...Object.fromEntries(['docx', 'doc', 'rtf', 'odt'].map((e) => [e, 'document' as const])),
  ...Object.fromEntries(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].map((e) => [e, 'image' as const])),
  ...Object.fromEntries(['txt', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'xml'].map((e) => [e, 'text' as const])),
  ...Object.fromEntries(Object.keys(CODE).map((e) => [e, 'code' as const])),
};

/** Every extension the preview can show (for finding file paths in messages). */
export const PREVIEW_EXTENSIONS = Object.keys(KINDS);

/** The highlight.js language for a file, if it gets colours. */
export function codeLanguage(file: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(file);
  const ext = m?.[1].toLowerCase() ?? '';
  return CODE[ext] ?? TEXT_LANG[ext];
}

/**
 * Whether "Open in default app" may hand the file to macOS: documents only. A script or
 * source file could be run by its default app instead of opened.
 */
export function openableKind(file: string): boolean {
  const k = previewKind(file);
  return !!k && k !== 'code';
}

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
