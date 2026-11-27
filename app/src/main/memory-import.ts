import { createHash, randomUUID } from 'node:crypto';
import type { MemoryCandidate, MemoryRecord, Project } from '../shared/types';
import { stripAppText } from './memory-writeback';

// Bringing the CLIs' own memory into app memory (read-only on their side: nothing
// here writes to ~/.claude, ~/.codex, ~/AGENTS.md or a repo). Two sources:
//  - Claude Code auto-memory: <claude dir>/projects/<encoded cwd>/memory/*.md, one
//    note per file with YAML frontmatter (name, description, type or metadata.type).
//    Always project memory (Claude Code loads it only in its folder).
//  - User instruction files: ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/AGENTS.md,
//    ~/.config/opencode/AGENTS.md (OpenCode), ~/.gemini/GEMINI.md and AGENTS.md (Antigravity),
//    split into one note per top-level section so the user can pick; and Claude Code's
//    user rules, ~/.claude/rules/*.md (one subfolder deep), one note per file.
// Each note has a stable key `source|host|file|section` (host 'local' = this computer).
// A record keeps every key whose text it holds (`importKeys`), so the same AGENTS.md
// on two machines is one record, and a re-scan updates rather than duplicates.

/** One note's body at most; longer ones are cut (the UI says so). */
export const MAX_BODY = 4000;
/** Instruction / memory files larger than this are skipped by the scan. */
const MAX_FILE_BYTES = 256 * 1024;

export const LOCAL = 'local';

export function memoryKey(source: MemoryCandidate['source'], host: string | undefined, file: string, section = ''): string {
  return [source, host ?? LOCAL, file, section].join('|');
}

export function keyHost(key: string): string {
  return key.split('|')[1] ?? LOCAL;
}

/** Whitespace-insensitive, so reflowed text still counts as the same note. */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/** How Claude Code names a project's folder under ~/.claude/projects: every non-alphanumeric character becomes '-'. */
export function encodeClaudeCwd(path: string): string {
  return path.replace(/\/+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

// ------------------------------------------------------------ parsing

/** Minimal YAML frontmatter: `key: value` lines, one level of nesting (metadata.type), quoted and block scalars. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  let parent = '';
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(\s*)([\w.-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, indent, k, raw] = kv;
    if (!indent) parent = raw.trim() ? '' : k;
    const key = indent && parent ? `${parent}.${k}` : k;
    let v = raw.trim();
    if (!v && !indent && /^\s+-\s/.test(lines[i + 1] ?? '')) {
      // A list (e.g. a rule's paths:): its items, comma-separated.
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s+-\s+/, '').trim().replace(/^(["'])(.*)\1$/, '$2'));
      v = items.join(', ');
    } else if (/^[|>][-+]?$/.test(v)) {
      // Block scalar: the following more-indented lines.
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s*$/.test(lines[i + 1]) || /^\s/.test(lines[i + 1]) && lines[i + 1].search(/\S/) > indent.length)) block.push(lines[++i].trim());
      v = block.join(v.startsWith('|') ? '\n' : ' ').trim();
    } else if (/^"(.*)"$/.test(v)) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n');
    else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    if (v || !indent) meta[key] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * Claude Code keeps its memory per project folder and loads it only there, whatever the
 * note's type (user, feedback, project, reference): so it is project memory here too.
 * User memory comes from the user-level instruction files, notes written in the app, and
 * notes the user promotes.
 */
export function scopeForType(_type: string | undefined): 'global' | 'project' {
  return 'project';
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'section';

/**
 * One note per top-level section: split at the highest heading level used more than
 * once (a lone `# Title` on top is the document's title, not a section); without
 * headings, one note per top-level bullet; otherwise the whole file. Empty sections
 * are dropped. `section` is a stable id from the heading / bullet text.
 */
export function splitInstructions(text: string): Array<{ section: string; title: string; body: string }> {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headings: Array<{ line: number; level: number; text: string }> = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) headings.push({ line: i, level: h[1].length, text: h[2] });
  });
  const out: Array<{ section: string; title: string; body: string }> = [];
  const used = new Map<string, number>();
  const push = (id: string, title: string, body: string[]) => {
    const b = body.join('\n').trim();
    if (!b) return;
    const n = (used.get(id) ?? 0) + 1;
    used.set(id, n);
    out.push({ section: n > 1 ? `${id}-${n}` : id, title, body: b });
  };

  if (headings.length) {
    const top = Math.min(...headings.map((h) => h.level));
    const tops = headings.filter((h) => h.level === top);
    const firstText = lines.findIndex((l) => l.trim());
    const titled = tops.length === 1 && tops[0].line === firstText && headings.some((h) => h.level > top);
    const docTitle = titled ? tops[0].text : '';
    const level = titled ? Math.min(...headings.filter((h) => h.level > top).map((h) => h.level)) : top;
    const cuts = headings.filter((h) => h.level <= level && !(titled && h === tops[0]));
    const start = titled ? tops[0].line + 1 : 0;
    push('preamble', docTitle || 'Introduction', lines.slice(start, cuts[0]?.line ?? lines.length));
    cuts.forEach((h, i) => {
      const content = lines.slice(h.line + 1, cuts[i + 1]?.line ?? lines.length);
      if (content.join('').trim()) push(slug(h.text), h.text, [lines[h.line], ...content]);
    });
    return out;
  }

  const bullet = /^([-*+]|\d+[.)])\s+(.*)$/;
  const items = lines.flatMap((l, i) => (bullet.test(l) ? [i] : []));
  if (items.length >= 2) {
    push('preamble', 'Introduction', lines.slice(0, items[0]));
    items.forEach((at, i) => {
      const first = bullet.exec(lines[at])![2];
      push(`item-${slug(first)}`, first.length > 80 ? `${first.slice(0, 79)}…` : first, lines.slice(at, items[i + 1] ?? lines.length));
    });
    return out;
  }
  push('all', '', lines);
  return out;
}

// ------------------------------------------------------------ scan

/**
 * POSIX sh, run with `sh -c` (here and over SSH whatever the login shell). One line
 * per file, `__AMW_MEM_FILE__<TAB>path<TAB>base64`, so login banners and the files'
 * own text can never be mistaken for output. MEMORY.md is Claude's index, not a note.
 */
export const MEMORY_SCAN_SCRIPT = `h="$HOME"; c="\${CLAUDE_CONFIG_DIR:-$h/.claude}"; x="\${CODEX_HOME:-$h/.codex}"
printf '__AMW_MEM_HOME__\\t%s\\n' "$h"
# A Claude Code auto-memory folder shared by every project (user settings or the environment).
st="$c/settings.json"; amd=""; pdn="\${CLAUDE_CODE_PROJECT_DIR_NAME:-}"
jv() { tr -d '\\n' < "$st" | grep -o "\\"$1\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" | head -n 1 | sed 's/.*:[[:space:]]*"//; s/"$//'; }
ok() { case "$1" in ""|*/*|..|.) return 1;; esac; }
ok "$pdn" || pdn=""
if [ -f "$st" ]; then amd=$(jv autoMemoryDirectory); [ -n "$pdn" ] || { pdn=$(jv CLAUDE_CODE_PROJECT_DIR_NAME); ok "$pdn" || pdn=""; }; fi
case "$amd" in "~/"*) amd="$h/\${amd#\\~/}";; /*) ;; *) amd="";; esac
[ -n "$amd" ] && printf '__AMW_MEM_SHARED__\\t%s\\n' "\${amd%/}"
[ -n "$pdn" ] && printf '__AMW_MEM_SHARED__\\t%s\\n' "$c/projects/$pdn/memory"
emit() {
  [ -f "$1" ] || return 0
  case "$1" in */MEMORY.md) return 0;; esac
  s=$(wc -c < "$1" | tr -d ' '); [ "$s" -le ${MAX_FILE_BYTES} ] || return 0
  printf '__AMW_MEM_FILE__\\t%s\\t%s\\n' "$1" "$(base64 < "$1" | tr -d '\\n')"
}
o="\${XDG_CONFIG_HOME:-$h/.config}/opencode"
for f in "$c/CLAUDE.md" "$c"/rules/*.md "$c"/rules/*/*.md "$x/AGENTS.md" "$h/AGENTS.md" "$o/AGENTS.md" "$h/.gemini/GEMINI.md" "$h/.gemini/AGENTS.md" "$c"/projects/*/memory/*.md; do emit "$f"; done
if [ -n "$amd" ]; then for f in "$amd"/*.md; do emit "$f"; done; fi
printf '__AMW_MEM_DONE__\\n'`;

export interface ScannedFile {
  path: string;
  content: string;
}

export function parseScanOutput(stdout: string): { home: string; files: ScannedFile[]; complete: boolean; shared: string[] } {
  let home = '';
  const files: ScannedFile[] = [];
  const shared: string[] = [];
  let complete = false;
  for (const line of stdout.split('\n')) {
    const parts = line.replace(/\r$/, '').split('\t');
    if (parts[0] === '__AMW_MEM_HOME__') home = parts[1] ?? '';
    else if (parts[0] === '__AMW_MEM_FILE__' && parts.length >= 3) files.push({ path: parts[1], content: Buffer.from(parts[2], 'base64').toString('utf8') });
    else if (parts[0] === '__AMW_MEM_SHARED__' && parts[1]) shared.push(parts[1].replace(/\/+$/, ''));
    else if (parts[0] === '__AMW_MEM_DONE__') complete = true;
  }
  return { home, files, complete, shared };
}

function cap(body: string): { body: string; truncated: boolean } {
  return body.length > MAX_BODY ? { body: `${body.slice(0, MAX_BODY - 1)}…`, truncated: true } : { body, truncated: false };
}

/** Candidates from one machine's scanned files; Claude project notes are matched to app projects on that machine. */
/** Key section of a note from a Claude Code auto-memory folder shared by every project (user memory). */
export const SHARED_DIR = 'user-dir';

export function candidatesFrom(host: string | undefined, home: string, files: ScannedFile[], projects: Project[], shared: string[] = []): MemoryCandidate[] {
  const rel = (p: string) => (home && p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
  const out: MemoryCandidate[] = [];
  const base = { host, alreadyImported: false, dismissed: false };
  const done = new Set<string>();
  for (const f of files) {
    if (done.has(f.path)) continue;
    done.add(f.path);
    const file = rel(f.path);
    // Auto memory every project shares (autoMemoryDirectory in user settings, or
    // CLAUDE_CODE_PROJECT_DIR_NAME): Claude Code's user-level memory, so user memory here.
    const dir = f.path.slice(0, f.path.lastIndexOf('/'));
    if (shared.includes(dir)) {
      const { meta, body } = parseFrontmatter(f.content);
      const type = (meta.type || meta['metadata.type'] || '').toLowerCase() || undefined;
      const text = [meta.description, body.trim()].filter(Boolean).join('\n\n').trim();
      if (!text) continue;
      out.push({ ...base, key: memoryKey('claude-memory', host, file, SHARED_DIR), source: 'claude-memory', file, title: meta.name || f.path.slice(dir.length + 1).replace(/\.md$/, ''), ...cap(text), suggestedScope: 'global', memoryType: type });
      continue;
    }
    const mem = /\/projects\/([^/]+)\/memory\/([^/]+)\.md$/.exec(f.path);
    if (mem) {
      const { meta, body } = parseFrontmatter(f.content);
      const type = (meta.type || meta['metadata.type'] || '').toLowerCase() || undefined;
      const text = [meta.description, body.trim()].filter(Boolean).join('\n\n').trim();
      if (!text) continue;
      const scope = scopeForType(type);
      const project = scope === 'project' ? projects.find((p) => (p.host ?? undefined) === host && encodeClaudeCwd(p.rootPath) === mem[1]) : undefined;
      out.push({ ...base, key: memoryKey('claude-memory', host, file), source: 'claude-memory', file, title: meta.name || mem[2], ...cap(text), suggestedScope: scope, memoryType: type, projectId: project?.projectId, folderHint: scope === 'project' && !project ? mem[1] : undefined });
      continue;
    }
    // Claude Code's user rules (~/.claude/rules/, read in every project): one note per file.
    // A rule with `paths:` applies only to matching files, and keeps saying so.
    if (/\/rules\/(?:[^/]+\/)?[^/]+\.md$/.test(f.path) && !/\/projects\//.test(f.path)) {
      const { meta, body } = parseFrontmatter(f.content);
      const text = body.trim();
      if (!text) continue;
      const paths = (meta.paths ?? '').replace(/^\[|\]$/g, '').split(/\s*,\s*/).map((x) => x.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean);
      const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1]?.trim();
      const scoped = paths.length ? `Applies only when working with files matching: ${paths.map((x) => '`' + x + '`').join(', ')}.\n\n${text}` : text;
      out.push({ ...base, key: memoryKey('instructions', host, file, ''), source: 'instructions', file, title: heading || file.split('/').pop()!.replace(/\.md$/, ''), ...cap(scoped), suggestedScope: 'global' });
      continue;
    }
    // The app's own import line and section are not the user's notes (they come from here).
    for (const s of splitInstructions(stripAppText(f.content))) {
      out.push({ ...base, key: memoryKey('instructions', host, file, s.section), source: 'instructions', file, title: s.title || file, ...cap(s.body), suggestedScope: 'global' });
    }
  }
  return out;
}

// ------------------------------------------------------------ records

export interface MemoryState {
  memory: MemoryRecord[];
  /** Keys and `hash:<bodyHash>` of imported notes the user deleted: never re-imported automatically. */
  memoryTombstones?: string[];
}

const edited = (r: MemoryRecord) => !!r.importedHash && bodyHash(r.body) !== r.importedHash;
const now = () => new Date().toISOString();

/** Called when the user deletes an imported record: sync must not bring it back. */
export function tombstone(state: MemoryState, r: MemoryRecord): void {
  if (!r.importKeys?.length) return;
  const t = new Set(state.memoryTombstones ?? []);
  for (const k of r.importKeys) t.add(k);
  if (r.importedHash) t.add(`hash:${r.importedHash}`);
  state.memoryTombstones = [...t].slice(-2000);
}

/** Fills `alreadyImported` / `dismissed` from the current records. */
export function markCandidates(candidates: MemoryCandidate[], state: MemoryState): MemoryCandidate[] {
  const keys = new Set(state.memory.flatMap((r) => r.importKeys ?? []));
  const hashes = new Set(state.memory.filter((r) => r.scope === 'global' && r.importedHash).map((r) => r.importedHash!));
  const dead = new Set(state.memoryTombstones ?? []);
  return candidates.map((c) => ({
    ...c,
    alreadyImported: keys.has(c.key) || (c.suggestedScope === 'global' && hashes.has(bodyHash(c.body))),
    dismissed: dead.has(c.key) || dead.has(`hash:${bodyHash(c.body)}`),
  }));
}

function newRecord(c: { title: string; body: string; keys: string[] }, scope: 'global' | 'project', scopeId: string): MemoryRecord {
  return { id: `m-${randomUUID().slice(0, 8)}`, scope, scopeId, body: c.body, title: c.title, source: c.keys[0], importKeys: [...c.keys], importedHash: bodyHash(c.body), approvedForReuse: true, updatedAt: now() };
}

/** Each key lives on one record only: a key that moved to `keep` is dropped from the others. */
function detach(state: MemoryState, keys: string[], keep: MemoryRecord): void {
  for (const r of state.memory) if (r !== keep && r.importKeys?.some((k) => keys.includes(k))) r.importKeys = r.importKeys.filter((k) => !keys.includes(k));
}

/**
 * Explicit import of picked candidates into a scope. Re-importing a key updates its
 * record (the user asked for it, so this overrides edits and clears a tombstone).
 */
export function importCandidates(state: MemoryState, picks: Array<{ candidate: MemoryCandidate; scope: 'global' | 'project'; scopeId: string }>): MemoryRecord[] {
  const touched: MemoryRecord[] = [];
  for (const { candidate: c, scope, scopeId } of picks) {
    const hash = bodyHash(c.body);
    state.memoryTombstones = (state.memoryTombstones ?? []).filter((k) => k !== c.key && k !== `hash:${hash}`);
    let r =
      state.memory.find((m) => m.importKeys?.includes(c.key)) ??
      state.memory.find((m) => m.scope === scope && m.scopeId === scopeId && m.importedHash === hash);
    if (r) {
      Object.assign(r, { scope, scopeId, body: c.body, title: c.title, importedHash: hash, sourceRemoved: false, approvedForReuse: true, updatedAt: now() });
      r.importKeys = [...new Set([...(r.importKeys ?? []), c.key])];
    } else {
      r = newRecord({ ...c, keys: [c.key] }, scope, scopeId);
      state.memory.push(r);
    }
    detach(state, [c.key], r);
    touched.push(r);
  }
  return touched;
}

/**
 * Keeps notes imported from Claude Code memory in step with their files (one file is one
 * note and its key, so edits and deletions on a machine are unambiguous). Project auto
 * memory is never brought in here (it belongs to its project; the user imports it); the
 * auto memory every project shares (user-level) is: a new file there becomes a note,
 * unless its text is already in memory or the user deleted it.
 * (The user's own CLAUDE.md / AGENTS.md text is imported once, when a machine is linked or
 * by hand, and then belongs to the app.) Nothing is ever deleted or overwritten:
 * - a changed file updates its note, unless the note was edited in the app: then the
 *   file's text is kept beside it (`sourceBody`) for the user to choose;
 * - a file gone from a machine that was read retires its note (`sourceRemoved`: no longer
 *   shared or given to agents, kept so it can be restored); it comes back with the file.
 * `scanned` = machines read successfully this time: other machines' notes are left alone.
 */
export function syncUserMemory(state: MemoryState, candidates: MemoryCandidate[], scanned: string[]): { added: number; updated: number; removed: number } {
  const counts = { added: 0, updated: 0, removed: 0 };
  const notes = candidates.filter((c) => c.source === 'claude-memory');
  const byKey = (key: string) => state.memory.find((r) => r.importKeys?.includes(key));
  const dead = new Set(state.memoryTombstones ?? []);
  for (const c of notes) {
    const r = byKey(c.key);
    const hash = bodyHash(c.body);
    if (!r) {
      // Only Claude Code's user-level auto memory (a folder every project shares) comes in by itself.
      if (c.suggestedScope !== 'global') continue;
      if (dead.has(c.key) || dead.has(`hash:${hash}`)) continue;
      if (state.memory.some((m) => !m.sourceRemoved && (m.importedHash === hash || bodyHash(m.body) === hash))) continue;
      state.memory.push(newRecord({ title: c.title, body: c.body, keys: [c.key] }, 'global', 'global'));
      counts.added++;
      continue;
    }
    if (r.sourceRemoved) {
      r.sourceRemoved = false;
      r.updatedAt = now();
    }
    if (r.importedHash === hash) {
      if (r.sourceBody !== undefined) delete r.sourceBody;
      continue;
    }
    if (edited(r)) {
      // Both changed: keep the user's version, offer the file's.
      if (r.sourceBody !== c.body) r.sourceBody = c.body;
      continue;
    }
    Object.assign(r, { body: c.body, title: c.title, importedHash: hash, updatedAt: now() });
    delete r.sourceBody;
    counts.updated++;
  }
  const found = new Set(notes.map((c) => c.key));
  const seen = new Set(scanned);
  for (const r of state.memory) {
    if (r.sourceRemoved) continue;
    const keys = (r.importKeys ?? []).filter((k) => k.startsWith('claude-memory|'));
    if (keys.length && keys.every((k) => seen.has(keyHost(k)) && !found.has(k))) {
      r.sourceRemoved = true;
      r.updatedAt = now();
      counts.removed++;
    }
  }
  return counts;
}
