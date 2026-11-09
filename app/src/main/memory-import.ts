import { createHash, randomUUID } from 'node:crypto';
import type { MemoryCandidate, MemoryRecord, Project } from '../shared/types';

// Bringing the CLIs' own memory into app memory (read-only on their side: nothing
// here writes to ~/.claude, ~/.codex, ~/AGENTS.md or a repo). Two sources:
//  - Claude Code auto-memory: <claude dir>/projects/<encoded cwd>/memory/*.md, one
//    note per file with YAML frontmatter (name, description, type or metadata.type).
//  - User instruction files: ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/AGENTS.md,
//    split into one note per top-level section so the user can pick.
// Each note has a stable key `source|host|file|section` (host 'local' = this Mac).
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
    if (/^[|>][-+]?$/.test(v)) {
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

/** user/feedback are about the person; project/reference belong to the folder. Untyped notes stay with their folder. */
export function scopeForType(type: string | undefined): 'global' | 'project' {
  return type === 'user' || type === 'feedback' ? 'global' : 'project';
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
for f in "$c/CLAUDE.md" "$x/AGENTS.md" "$h/AGENTS.md" "$c"/projects/*/memory/*.md; do
  [ -f "$f" ] || continue
  case "$f" in */MEMORY.md) continue;; esac
  s=$(wc -c < "$f" | tr -d ' '); [ "$s" -le ${MAX_FILE_BYTES} ] || continue
  printf '__AMW_MEM_FILE__\\t%s\\t%s\\n' "$f" "$(base64 < "$f" | tr -d '\\n')"
done
printf '__AMW_MEM_DONE__\\n'`;

export interface ScannedFile {
  path: string;
  content: string;
}

export function parseScanOutput(stdout: string): { home: string; files: ScannedFile[]; complete: boolean } {
  let home = '';
  const files: ScannedFile[] = [];
  let complete = false;
  for (const line of stdout.split('\n')) {
    const parts = line.replace(/\r$/, '').split('\t');
    if (parts[0] === '__AMW_MEM_HOME__') home = parts[1] ?? '';
    else if (parts[0] === '__AMW_MEM_FILE__' && parts.length >= 3) files.push({ path: parts[1], content: Buffer.from(parts[2], 'base64').toString('utf8') });
    else if (parts[0] === '__AMW_MEM_DONE__') complete = true;
  }
  return { home, files, complete };
}

function cap(body: string): { body: string; truncated: boolean } {
  return body.length > MAX_BODY ? { body: `${body.slice(0, MAX_BODY - 1)}…`, truncated: true } : { body, truncated: false };
}

/** Candidates from one machine's scanned files; Claude project notes are matched to app projects on that machine. */
export function candidatesFrom(host: string | undefined, home: string, files: ScannedFile[], projects: Project[]): MemoryCandidate[] {
  const rel = (p: string) => (home && p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
  const out: MemoryCandidate[] = [];
  const base = { host, alreadyImported: false, dismissed: false };
  for (const f of files) {
    const file = rel(f.path);
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
    for (const s of splitInstructions(f.content)) {
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
 * Automatic sync of user-level notes. Same text from several machines / files is one
 * record listing all its keys. New text is added; a source whose text changed updates
 * its record unless the user edited it (user wins); keys the user deleted (tombstones)
 * are skipped; a record whose every source was scanned and not found is marked
 * `sourceRemoved`, never deleted. `scanned` = machines read successfully this time:
 * keys on other machines are left as they are.
 */
export function syncUserMemory(state: MemoryState, candidates: MemoryCandidate[], scanned: string[]): { added: number; updated: number; removed: number } {
  const counts = { added: 0, updated: 0, removed: 0 };
  const dead = new Set(state.memoryTombstones ?? []);
  const groups = new Map<string, { hash: string; title: string; body: string; keys: string[] }>();
  for (const c of candidates) {
    if (c.suggestedScope !== 'global') continue;
    const hash = bodyHash(c.body);
    const g = groups.get(hash) ?? { hash, title: c.title, body: c.body, keys: [] };
    g.keys.push(c.key);
    groups.set(hash, g);
  }
  const live = [...groups.values()].filter((g) => !dead.has(`hash:${g.hash}`) && !g.keys.some((k) => dead.has(k)));
  const imported = () => state.memory.filter((r) => r.scope === 'global' && r.importedHash);
  const claimed = new Set<MemoryRecord>();
  const placed = new Map<(typeof live)[number], MemoryRecord>();

  // Unchanged text first, so a record stays with the text it holds when sources diverge.
  for (const g of live) {
    const r = imported().find((m) => m.importedHash === g.hash && !claimed.has(m));
    if (r) {
      claimed.add(r);
      placed.set(g, r);
    }
  }
  for (const g of live) {
    if (placed.has(g)) continue;
    let r = imported().find((m) => m.importKeys?.some((k) => g.keys.includes(k)));
    if (r && !claimed.has(r)) {
      if (!edited(r)) {
        Object.assign(r, { body: g.body, title: g.title, importedHash: g.hash, updatedAt: now() });
        counts.updated++;
      }
    } else {
      r = newRecord(g, 'global', 'global');
      state.memory.push(r);
      counts.added++;
    }
    claimed.add(r);
    placed.set(g, r);
  }
  for (const [g, r] of placed) {
    detach(state, g.keys, r);
    r.importKeys = [...new Set([...(r.importKeys ?? []), ...g.keys])];
  }

  const found = new Set(candidates.map((c) => c.key));
  const seen = new Set(scanned);
  for (const r of state.memory) {
    if (!r.importKeys?.length) {
      if (r.importedHash && !r.sourceRemoved) {
        // Every key moved to other records (its text is gone everywhere).
        r.sourceRemoved = true;
        counts.removed++;
      }
      continue;
    }
    const gone = r.importKeys.every((k) => seen.has(keyHost(k)) && !found.has(k));
    if (gone && !r.sourceRemoved) {
      r.sourceRemoved = true;
      r.updatedAt = now();
      counts.removed++;
    } else if (!gone && r.sourceRemoved) r.sourceRemoved = false;
  }
  return counts;
}
