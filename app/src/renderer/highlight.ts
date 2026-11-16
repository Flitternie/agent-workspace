// Source colours for the preview with Shiki (VS Code's grammars), loaded only when a file is first shown:
// the core, the JavaScript regex engine (no WebAssembly) and one light theme, then each language's
// grammar on first use. Only the languages below ship; anything else shows uncoloured.
import type { HighlighterCore, ThemedToken } from 'shiki/core';

const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  python: () => import('@shikijs/langs/python'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  xml: () => import('@shikijs/langs/xml'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  less: () => import('@shikijs/langs/less'),
  bash: () => import('@shikijs/langs/bash'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  scala: () => import('@shikijs/langs/scala'),
  dart: () => import('@shikijs/langs/dart'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  'objective-c': () => import('@shikijs/langs/objective-c'),
  csharp: () => import('@shikijs/langs/csharp'),
  ruby: () => import('@shikijs/langs/ruby'),
  php: () => import('@shikijs/langs/php'),
  perl: () => import('@shikijs/langs/perl'),
  lua: () => import('@shikijs/langs/lua'),
  r: () => import('@shikijs/langs/r'),
  julia: () => import('@shikijs/langs/julia'),
  elixir: () => import('@shikijs/langs/elixir'),
  erlang: () => import('@shikijs/langs/erlang'),
  haskell: () => import('@shikijs/langs/haskell'),
  ocaml: () => import('@shikijs/langs/ocaml'),
  clojure: () => import('@shikijs/langs/clojure'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  proto: () => import('@shikijs/langs/proto'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  latex: () => import('@shikijs/langs/latex'),
  ini: () => import('@shikijs/langs/ini'),
  diff: () => import('@shikijs/langs/diff'),
  groovy: () => import('@shikijs/langs/groovy'),
  hcl: () => import('@shikijs/langs/hcl'),
  nix: () => import('@shikijs/langs/nix'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  makefile: () => import('@shikijs/langs/makefile'),
};

/** File extension (or whole name) → the grammar above. */
const BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  py: 'python', pyi: 'python', ipynb: 'json', json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', scala: 'scala', dart: 'dart',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', m: 'objective-c', mm: 'objective-c', cs: 'csharp',
  rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua', r: 'r', jl: 'julia', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', clj: 'clojure',
  sql: 'sql', graphql: 'graphql', proto: 'proto', vue: 'vue', svelte: 'svelte', tex: 'latex', ini: 'ini', cfg: 'ini', conf: 'ini',
  diff: 'diff', patch: 'diff', gradle: 'groovy', tf: 'hcl', nix: 'nix', dockerfile: 'dockerfile', makefile: 'makefile',
};

/** The grammar for a file, if one ships. */
export function shikiLang(file: string): string | undefined {
  const name = file.split('/').pop()!.toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return BY_EXT[ext];
}

let core: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  return (core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('@shikijs/themes/github-light'),
    ]);
    return createHighlighterCore({ themes: [theme.default], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  })());
}

export type Token = Pick<ThemedToken, 'content' | 'color' | 'fontStyle'>;

/** Coloured tokens per line, or null when the language does not ship or colouring fails. */
export async function highlightLines(code: string, lang: string): Promise<Token[][] | null> {
  const load = LANGS[lang];
  if (!load) return null;
  try {
    const h = await highlighter();
    if (!loaded.has(lang)) loaded.set(lang, load().then((m) => h.loadLanguage((m as { default: Parameters<HighlighterCore['loadLanguage']>[0] }).default)));
    await loaded.get(lang);
    return h.codeToTokensBase(code, { lang, theme: 'github-light' });
  } catch {
    return null;
  }
}
