import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { MemoryBackup, MemoryRecord } from '../shared/types';
import { shq, sshError, sshRun, sshRunInput } from './util/ssh';

// User memory shared with the CLIs on every linked machine, so a terminal `claude` or
// `codex` sees what the app's agents see.
//
//   Claude Code: one marked import line in ~/.claude/CLAUDE.md, added once, pointing at
//                ~/.agent-workspace/memory/user.md, which the app owns.
//   Codex:       a marked section at the end of ~/.codex/AGENTS.md (it has no imports).
//   OpenCode:    the same section in ~/.config/opencode/AGENTS.md (its global rules file).
//   Antigravity: the same section in ~/.gemini/GEMINI.md (its global rules file).
//
// The rule above all: nothing the app does may delete or overwrite memory on either side.
// - The user's own text in those files is never changed; only the app's line and section
//   are added, updated or removed. Symlinked files are written through to their target.
// - The app's own text is not overwritten either once someone else changed it (the user,
//   or another Agent Workspace): the file is left alone until the user chooses.
// - Every change is preceded by a full backup of the file (kept here; the version from
//   before linking for good, plus a copy on the machine itself), and a write only goes
//   ahead if the file is still exactly what was read.
// - A line or section the user removed by hand is not put back.

export const IMPORT_LINE = '@~/.agent-workspace/memory/user.md';
const MARK = 'agent-workspace:user-memory';
const OWNER_RE = /owner=([\w-]+)/;
// The app's import comment (any owner) and the import line itself, wherever they are.
const IMPORT_COMMENT_RE = /^<!-- agent-workspace:user-memory(?: owner=[\w-]+)? \(.*?\) -->[ \t]*$/m;
const IMPORT_LINE_RE = /^@~\/\.agent-workspace\/memory\/user\.md[ \t]*$/m;
const SECTION_RE = /<!-- agent-workspace:user-memory:begin(?: owner=[\w-]+)? -->[\s\S]*?<!-- agent-workspace:user-memory:end -->/;

/** These files are loaded into every terminal session: keep the shared part reasonable. */
export const MAX_NOTES_CHARS = 16_000;
const KEEP_BACKUPS = 20;
const LOCAL = 'local';

/** claude-md: the user's CLAUDE.md (import line); claude-user: the app's own user.md; the others: a CLI's rules file (section). */
export type TargetKind = 'claude-md' | 'claude-user' | 'codex-md' | 'opencode-md' | 'gemini-md';
export const TARGET_KINDS: TargetKind[] = ['claude-md', 'claude-user', 'codex-md', 'opencode-md', 'gemini-md'];
/** Files the app keeps a marked section in (Codex, OpenCode, Antigravity: they have no imports). */
export const SECTION_KINDS: TargetKind[] = ['codex-md', 'opencode-md', 'gemini-md'];

export interface FileState {
  host: string; // LOCAL or an SSH alias
  kind: TargetKind;
  /** Absolute path on that machine, symlinks resolved (where writes go). */
  path: string;
  /** "~/.claude/CLAUDE.md" as the CLI knows it: the form import keys use. */
  file: string;
  /** The CLI's folder exists there (else that CLI is not set up on the machine: nothing is written for it). */
  dirExists: boolean;
  exists: boolean;
  content: string;
}

export type BackupEntry = MemoryBackup;

/** Per machine and file: what the app last wrote, and what the user decided. */
export interface TargetState {
  host: string;
  kind: TargetKind;
  /** The app's line / section was written there (so if it is gone now, the user removed it). */
  added?: boolean;
  /** Hash of the app's own text as last written (user.md, the section, the import line). */
  lastHash?: string;
  /** Writing stopped: restored from a backup, or the app's text was changed outside the app. */
  paused?: 'restored' | 'edited' | 'removed' | 'other-owner';
  /** Who else owns the app's text there (another Agent Workspace), for the message. */
  otherOwner?: string;
}

export interface WriteResult {
  written: string[];
  /** Things the user should know or decide (paused files and why). */
  notices: string[];
  errors: string[];
}

// ------------------------------------------------------------ the app's text in a file

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The app's own text in a file (import comment + line, section, or all of user.md), or null. */
export function appText(kind: TargetKind, content: string): string | null {
  if (kind === 'claude-user') return content || null;
  if (SECTION_KINDS.includes(kind)) return SECTION_RE.exec(content)?.[0] ?? null;
  return IMPORT_LINE_RE.test(content) ? [IMPORT_COMMENT_RE.exec(content)?.[0] ?? '', IMPORT_LINE].join('\n') : null;
}

/** The owner id written in the app's text, if any. */
export function ownerOf(kind: TargetKind, content: string): string | undefined {
  const t = appText(kind, content);
  return t ? OWNER_RE.exec(t)?.[1] : undefined;
}

/** Removes the app's import comment and line and its section; nothing else. */
export function stripAppText(text: string): string {
  const cut = (s: string, re: RegExp) => {
    const m = re.exec(s);
    if (!m) return s;
    const before = s.slice(0, m.index).replace(/\s+$/, '');
    const after = s.slice(m.index + m[0].length).replace(/^[ \t]*\n/, '').replace(/^\s*\n/, '');
    return before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
  };
  return cut(cut(cut(text, IMPORT_COMMENT_RE), IMPORT_LINE_RE), SECTION_RE);
}

const append = (text: string, block: string) => (!text ? `${block}\n` : `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}\n`);

/** CLAUDE.md with the import line (added once, at the end). */
export function withImport(text: string, owner: string): string {
  if (IMPORT_LINE_RE.test(text)) return text;
  return append(text, `<!-- ${MARK} owner=${owner} (your Agent Workspace user memory; remove these two lines to stop) -->\n${IMPORT_LINE}`);
}

export interface Note {
  title?: string;
  body: string;
}

/**
 * One block per note, its Markdown kept (lists, code). A one-line note is a bullet; a
 * longer one gets its title as a heading and its body as written.
 */
export function renderNotes(notes: Note[]): string {
  return notes
    .map((n) => {
      const body = n.body.trim();
      if (!body.includes('\n')) return `- ${body.replace(/^([-*+]|\d+[.)])\s+/, '')}`;
      const [first, ...rest] = body.split('\n');
      const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(first);
      const title = heading ? heading[1] : n.title || first.replace(/^([-*+]|\d+[.)])\s+/, '').slice(0, 80);
      const text = heading ? rest.join('\n').trim() : body;
      return `### ${title}\n\n${text}`;
    })
    .join('\n\n');
}

/** AGENTS.md with the section holding `notes` (replaced in place, or appended). */
export function withSection(text: string, notes: Note[], owner: string): string {
  const section = [`<!-- ${MARK}:begin owner=${owner} -->`, '<!-- Your Agent Workspace user memory, kept in sync by the app. Edit it in the app (Settings › Memory). -->', '', renderNotes(notes), '', `<!-- ${MARK}:end -->`].join('\n');
  const m = SECTION_RE.exec(text);
  return m ? text.slice(0, m.index) + section + text.slice(m.index + m[0].length) : append(text, section);
}

export function userFile(notes: Note[], owner: string, label: string): string {
  return [`<!-- ${MARK} owner=${owner} — your user memory from Agent Workspace (${label}). Edit it in the app (Settings › Memory). -->`, '', '# User memory', '', renderNotes(notes), ''].join('\n');
}

/** Notes back out of the app's text (a section or user.md), for "keep these edits". */
export function parseNotes(text: string): Note[] {
  const body = text.replace(/<!--[\s\S]*?-->/g, '').replace(/^# User memory\s*$/m, '').trim();
  const notes: Note[] = [];
  for (const block of body.split(/\n(?=### )/)) {
    const b = block.trim();
    if (!b) continue;
    const h = /^### (.*)\n?([\s\S]*)$/.exec(b);
    if (h) {
      notes.push({ title: h[1].trim(), body: `## ${h[1].trim()}\n\n${h[2].trim()}`.trim() });
      continue;
    }
    for (const line of b.split('\n')) {
      const item = /^[-*+]\s+(.*)$/.exec(line.trim());
      if (item?.[1].trim()) notes.push({ body: item[1].trim() });
    }
  }
  return notes;
}

const edited = (r: MemoryRecord) => !!r.importedHash && hashBody(r.body) !== r.importedHash;
/** Same as memory-import's bodyHash (whitespace-insensitive). */
const hashBody = (body: string) => createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/**
 * The notes shared with a file's CLI: approved, active user memory, minus notes that
 * came from that CLI's own file on that machine and were not changed in the app (the CLI
 * already reads them there). Over the size limit, the ones the user wrote or changed in
 * the app go first, then the newest; the rest are left out (`left`) and the app gives
 * them to its own agents instead. Shared notes keep their order.
 */
export function notesFor(host: string, ownFile: string, records: MemoryRecord[]): { notes: Note[]; dropped: number; covered: Set<string>; left: string[] } {
  // Claude Code also reads its user rules (~/.claude/rules/ beside CLAUDE.md) by itself.
  const rules = /CLAUDE\.md$/.test(ownFile) ? ownFile.replace(/CLAUDE\.md$/, 'rules/') : undefined;
  const fromThere = (key: string) => {
    const [source, h, file, section] = key.split('|');
    if ((h ?? LOCAL) !== host) return false;
    // Claude Code's shared auto memory on that machine: Claude reads it there itself.
    if (source === 'claude-memory') return !!rules && section === 'user-dir';
    return source === 'instructions' && (file === ownFile || (!!rules && !!file?.startsWith(rules)));
  };
  const covered = new Set<string>();
  const want: MemoryRecord[] = [];
  for (const r of records) {
    if (r.scope !== 'global' || !r.approvedForReuse || r.sourceRemoved) continue;
    if (!edited(r) && (r.importKeys ?? []).some(fromThere)) {
      covered.add(r.id);
      continue;
    }
    if (r.body.trim()) want.push(r);
  }
  const tier = (r: MemoryRecord) => (!r.importKeys?.length ? 0 : edited(r) ? 1 : 2);
  const ranked = [...want].sort((a, b) => tier(a) - tier(b) || b.updatedAt.localeCompare(a.updatedAt));
  const keep = new Set<string>();
  let size = 0;
  for (const r of ranked) {
    const n = r.body.trim().length;
    if (size + n > MAX_NOTES_CHARS) continue;
    size += n;
    keep.add(r.id);
  }
  const notes = want.filter((r) => keep.has(r.id)).map((r) => ({ title: r.title, body: r.body.trim() }));
  for (const id of keep) covered.add(id);
  const left = want.filter((r) => !keep.has(r.id)).map((r) => r.id);
  return { notes, dropped: left.length, covered, left };
}

/** What each of a machine's files should become (null: leave it as it is). */
export function plan(files: FileState[], records: MemoryRecord[], owner: string, label: string): Array<{ file: FileState; next: string | null }> {
  const claudeMd = files.find((f) => f.kind === 'claude-md');
  return files.map((f) => {
    let next: string | null = null;
    if (f.dirExists) {
      if (f.kind === 'claude-md') next = withImport(f.content, owner);
      if (f.kind === 'claude-user') next = userFile(notesFor(f.host, claudeMd?.file ?? '', records).notes, owner, label);
      if (SECTION_KINDS.includes(f.kind)) next = withSection(f.content, notesFor(f.host, f.file, records).notes, owner);
    }
    return { file: f, next: next === null || (f.exists && next === f.content) ? null : next };
  });
}

// ------------------------------------------------------------ one machine's files

const WB = '__AMW_WB__';

/**
 * The files on a machine in one round trip, symlinks resolved; base64 so any content
 * survives banners and quoting.
 */
export const READ_SCRIPT = `h="$HOME"; c="\${CLAUDE_CONFIG_DIR:-$h/.claude}"; x="\${CODEX_HOME:-$h/.codex}"; o="\${XDG_CONFIG_HOME:-$h/.config}/opencode"; g="$h/.gemini"
for t in "claude-md:$c:$c/CLAUDE.md" "claude-user:$c:$h/.agent-workspace/memory/user.md" "codex-md:$x:$x/AGENTS.md" "opencode-md:$o:$o/AGENTS.md" "gemini-md:$g:$g/GEMINI.md"; do
  k="\${t%%:*}"; r="\${t#*:}"; d="\${r%%:*}"; f="\${r#*:}"; shown="$f"
  [ -L "$f" ] && f=$(readlink -f "$f" 2>/dev/null || echo "$f")
  de=0; [ -d "$d" ] && de=1; fe=0; [ -f "$f" ] && fe=1
  b=""; [ "$fe" = 1 ] && b=$(base64 < "$f" | tr -d '\\n')
  printf '${WB}\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$k" "$f" "$de" "$fe" "$b" "$h" "$shown"
done
printf '${WB}_DONE\\n'`;

export function parseRead(host: string, stdout: string): FileState[] {
  if (!stdout.includes(`${WB}_DONE`)) throw new Error('Incomplete answer.');
  return stdout.split('\n').flatMap((line) => {
    const p = line.replace(/\r$/, '').split('\t');
    if (p[0] !== WB || p.length < 8) return [];
    const [, kind, path, de, fe, b64, home, shown] = p;
    const file = home && shown.startsWith(`${home}/`) ? `~/${shown.slice(home.length + 1)}` : shown;
    return [{ host, kind: kind as TargetKind, path, file, dirExists: de === '1', exists: fe === '1', content: Buffer.from(b64, 'base64').toString('utf8') }];
  });
}

/**
 * Replaces `path` with stdin (or deletes it) only if it still has the content that was
 * read (`expect`: its sha256, '-' = absent). With `keep`, a copy of the current file is
 * first left in ~/.agent-workspace/backups on that machine.
 */
export function writeScript(path: string, expect: string, opts: { remove?: boolean; keep?: string }): string {
  return [
    `f=${shq(path)}`,
    `cur=-; [ -f "$f" ] && cur=$({ sha256sum 2>/dev/null || shasum -a 256; } < "$f" | cut -d' ' -f1)`,
    `[ "$cur" = ${shq(expect)} ] || { echo 'changed since read' >&2; exit 3; }`,
    ...(opts.keep ? [`b="$HOME/.agent-workspace/backups"; mkdir -p "$b"; [ -f "$f" ] && cp -p "$f" "$b/"${shq(opts.keep)}`] : []),
    opts.remove ? 'rm -f "$f"' : 'mkdir -p "$(dirname "$f")" && cat > "$f.amw-tmp" && mv "$f.amw-tmp" "$f"',
    'echo __AMW_WB_OK__',
  ].join('\n');
}

const NOTICE: Record<NonNullable<TargetState['paused']>, (f: FileState) => string> = {
  restored: (f) => `${f.file} was restored from a backup; the app does not write to it until you resume.`,
  edited: (f) => `The Agent Workspace part of ${f.file} was changed outside the app; it is left as it is until you choose.`,
  removed: (f) => `The Agent Workspace ${f.kind === 'claude-md' ? 'line' : 'section'} was removed from ${f.file}; it is not put back unless you ask.`,
  'other-owner': (f) => `${f.file} is kept in sync by another Agent Workspace; this one leaves it alone.`,
};

export class MemoryWriteback {
  private dir: string;
  /** This app's identity in the files it writes (so two installs never overwrite each other). */
  readonly owner: string;
  readonly label: string;

  constructor(
    dataDir: string,
    /** The home used for this computer (tests). */
    private home = homedir(),
  ) {
    this.dir = join(dataDir, 'memory-backups');
    mkdirSync(this.dir, { recursive: true });
    const idFile = join(dataDir, 'instance.json');
    let id: { owner?: string } = {};
    try {
      id = JSON.parse(readFileSync(idFile, 'utf8')) as { owner?: string };
    } catch {
      /* first run */
    }
    if (!id.owner) {
      id.owner = randomUUID().slice(0, 12);
      writeFileSync(idFile, JSON.stringify(id));
    }
    this.owner = id.owner;
    this.label = `${hostname().replace(/\.local$/, '')}: ${dataDir}`;
  }

  // -------------------------------------------------- bookkeeping (written atomically)

  private load(): { backups: BackupEntry[]; targets: TargetState[] } {
    try {
      const j = JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')) as { backups?: BackupEntry[]; targets?: TargetState[] };
      return { backups: j.backups ?? [], targets: j.targets ?? [] };
    } catch {
      return { backups: [], targets: [] };
    }
  }

  private store(i: { backups: BackupEntry[]; targets: TargetState[] }): void {
    const file = join(this.dir, 'index.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(i, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  private target(i: { targets: TargetState[] }, host: string, kind: TargetKind): TargetState {
    let t = i.targets.find((x) => x.host === host && x.kind === kind);
    if (!t) i.targets.push((t = { host, kind }));
    return t;
  }

  targets(host?: string): TargetState[] {
    return this.load().targets.filter((t) => host === undefined || t.host === host);
  }

  backups(host?: string): BackupEntry[] {
    return this.load().backups.filter((b) => host === undefined || b.host === host);
  }

  backupContent(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Not a backup id.');
    return readFileSync(join(this.dir, `${id}.bak`), 'utf8');
  }

  // -------------------------------------------------- files

  /** A machine's files as they are now (symlinks resolved). */
  async read(host: string): Promise<FileState[]> {
    if (host === LOCAL) {
      const c = process.env.CLAUDE_CONFIG_DIR || join(this.home, '.claude');
      const x = process.env.CODEX_HOME || join(this.home, '.codex');
      // (XDG_CONFIG_HOME only for the real home: a test's home keeps everything inside it.)
      const o = join((this.home === homedir() && process.env.XDG_CONFIG_HOME) || join(this.home, '.config'), 'opencode');
      const g = join(this.home, '.gemini');
      const rows: Array<[TargetKind, string, string]> = [
        ['claude-md', c, join(c, 'CLAUDE.md')],
        ['claude-user', c, join(this.home, '.agent-workspace/memory/user.md')],
        ['codex-md', x, join(x, 'AGENTS.md')],
        ['opencode-md', o, join(o, 'AGENTS.md')],
        ['gemini-md', g, join(g, 'GEMINI.md')],
      ];
      return rows.map(([kind, d, shown]) => {
        let path = shown;
        try {
          if (lstatSync(shown).isSymbolicLink()) path = realpathSync(shown);
        } catch {
          /* missing, or a broken link: written as a new file at the link's place */
        }
        const exists = existsSync(path) && statSync(path).isFile();
        return { host, kind, path, file: shown.startsWith(`${this.home}/`) ? `~/${shown.slice(this.home.length + 1)}` : shown, dirExists: existsSync(d), exists, content: exists ? readFileSync(path, 'utf8') : '' };
      });
    }
    const r = await sshRun(host, `sh -c ${shq(READ_SCRIPT)}`, 30_000);
    if (r.code !== 0) throw new Error(r.code === 255 ? sshError(host, r.stderr) : `Could not read the memory files on ${host}.`);
    return parseRead(host, r.stdout);
  }

  /** Saves the file as it is now; returns the entry (call `forget` if the write then fails). */
  private backup(i: { backups: BackupEntry[] }, f: FileState, reason: BackupEntry['reason']): BackupEntry {
    const entry: BackupEntry = { id: `${Date.now()}-${randomUUID().slice(0, 6)}`, host: f.host, path: f.path, at: new Date().toISOString(), reason, existed: f.exists, size: Buffer.byteLength(f.content) };
    if (!i.backups.some((b) => b.host === f.host && b.path === f.path && b.original)) entry.original = true;
    writeFileSync(join(this.dir, `${entry.id}.bak`), f.content);
    i.backups.push(entry);
    const mine = i.backups.filter((b) => b.host === f.host && b.path === f.path && !b.original);
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) {
      rmSync(join(this.dir, `${old.id}.bak`), { force: true });
      i.backups = i.backups.filter((b) => b !== old);
    }
    return entry;
  }

  private forget(i: { backups: BackupEntry[] }, entry: BackupEntry): void {
    rmSync(join(this.dir, `${entry.id}.bak`), { force: true });
    i.backups = i.backups.filter((b) => b !== entry);
  }

  /** Writes `next` (null = delete) if the file is still as read; `keep` also leaves a copy on the machine. */
  private async put(f: FileState, next: string | null, keep?: string): Promise<void> {
    const expect = f.exists ? sha(f.content) : '-';
    if (f.host === LOCAL) {
      const now = existsSync(f.path) ? readFileSync(f.path, 'utf8') : null;
      if ((now === null ? '-' : sha(now)) !== expect) throw new Error(`${f.file} changed since it was read; nothing written.`);
      if (keep && now !== null) {
        const b = join(this.home, '.agent-workspace/backups');
        mkdirSync(b, { recursive: true });
        writeFileSync(join(b, keep), now);
      }
      if (next === null) rmSync(f.path, { force: true });
      else {
        mkdirSync(dirname(f.path), { recursive: true });
        writeFileSync(`${f.path}.amw-tmp`, next);
        renameSync(`${f.path}.amw-tmp`, f.path);
      }
      return;
    }
    const r = await sshRunInput(f.host, `sh -c ${shq(writeScript(f.path, expect, { remove: next === null, keep }))}`, Buffer.from(next ?? ''), 60_000);
    if (r.code === 3) throw new Error(`${f.file} on ${f.host} changed since it was read; nothing written.`);
    if (r.code !== 0 || !r.stdout.includes('__AMW_WB_OK__')) throw new Error(r.code === 255 ? sshError(f.host, r.stderr) : `Could not write ${f.file} on ${f.host}: ${r.stderr.trim().split('\n').pop() ?? ''}`);
  }

  /**
   * Whether the app may write this file now, and if not why. The app's own text must be
   * what it last wrote: if someone changed or removed it, or another install owns it,
   * the file is left alone.
   */
  private check(f: FileState, t: TargetState, linking: boolean): TargetState['paused'] | undefined {
    if (t.paused && !linking) return t.paused;
    const mine = appText(f.kind, f.content);
    const owner = ownerOf(f.kind, f.content);
    if (owner && owner !== this.owner) return 'other-owner';
    if (linking) return undefined;
    if (mine === null) return t.added && f.kind !== 'claude-user' ? 'removed' : undefined;
    if (t.lastHash && sha(mine) !== t.lastHash) return 'edited';
    return undefined;
  }

  /**
   * Brings a machine's files in line with `records`. `link` = the first sync: copies are
   * also left on the machine, and earlier pauses are cleared (the user asked for it).
   */
  async write(host: string, records: MemoryRecord[], reason: 'link' | 'sync'): Promise<WriteResult> {
    const res: WriteResult = { written: [], notices: [], errors: [] };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const files = await this.read(host);
    const i = this.load();
    for (const { file, next } of plan(files, records, this.owner, this.label)) {
      const t = this.target(i, host, file.kind);
      if (reason === 'link') delete t.paused;
      const stop = this.check(file, t, reason === 'link');
      if (stop) {
        t.paused = stop;
        if (stop === 'other-owner') t.otherOwner = ownerOf(file.kind, file.content);
        res.notices.push(NOTICE[stop](file));
        continue;
      }
      if (next === null) continue;
      const entry = this.backup(i, file, reason);
      try {
        await this.put(file, next, reason === 'link' && file.kind !== 'claude-user' ? `${file.file.split('/').pop()}.before-agent-workspace.${stamp}` : undefined);
        const mine = appText(file.kind, next);
        Object.assign(t, { added: true, lastHash: mine ? sha(mine) : undefined });
        res.written.push(file.path);
      } catch (error) {
        this.forget(i, entry);
        res.errors.push((error as Error).message);
      }
    }
    this.store(i);
    // Over the limit: say which notes the CLIs' files leave out (the app's agents still get them).
    const over = notesFor(host, files.find((f) => SECTION_KINDS.includes(f.kind))?.file ?? '', records).dropped;
    if (over) res.notices.push(`${over} note(s) are not in the CLIs' files on ${host === LOCAL ? 'this computer' : host}: user memory is over ${MAX_NOTES_CHARS.toLocaleString('en-US')} characters. Agents started by the app still get them; terminal sessions do not.`);
    return res;
  }

  /** Puts a file back as it was in a backup (the current version is backed up first) and pauses writing to it. */
  async restore(id: string): Promise<void> {
    const i = this.load();
    const b = i.backups.find((x) => x.id === id);
    if (!b) throw new Error('That backup no longer exists.');
    const content = this.backupContent(id);
    const current = (await this.read(b.host)).find((f) => f.path === b.path);
    if (!current) throw new Error(`${b.path} is not one of the files the app manages.`);
    const entry = this.backup(i, current, 'restore');
    try {
      await this.put(current, b.existed ? content : null);
    } catch (error) {
      this.forget(i, entry);
      this.store(i);
      throw error;
    }
    this.target(i, b.host, current.kind).paused = 'restored';
    this.store(i);
  }

  /**
   * After the user chose, for a paused file: `resume` writes again (the app's text is
   * replaced, after a backup); `adopt` returns the notes found in the app's text there
   * so they can join user memory, then resumes.
   */
  async resolve(host: string, kind: TargetKind, how: 'resume' | 'adopt'): Promise<Note[]> {
    const f = (await this.read(host)).find((x) => x.kind === kind);
    const i = this.load();
    const t = this.target(i, host, kind);
    const mine = f ? appText(kind, f.content) : null;
    const notes = how === 'adopt' && mine ? parseNotes(mine) : [];
    // From now on the text there counts as the app's last write; a removed line may be added again.
    Object.assign(t, { paused: undefined, otherOwner: undefined, lastHash: mine ? sha(mine) : undefined, added: t.paused === 'removed' ? false : t.added });
    this.store(i);
    return notes;
  }

  /**
   * Unlinks a machine: takes out only the app's import line and section, and its own
   * user.md (each backed up first). A file the app created that holds nothing else is
   * removed; text added by anyone else stays. Files owned by another install are not touched.
   */
  async unlink(host: string): Promise<string[]> {
    const i = this.load();
    const notices: string[] = [];
    for (const f of await this.read(host)) {
      if (!f.exists) continue;
      const owner = ownerOf(f.kind, f.content);
      if (owner && owner !== this.owner) {
        notices.push(NOTICE['other-owner'](f));
        continue;
      }
      const createdByApp = i.backups.some((b) => b.host === host && b.path === f.path && b.original && !b.existed);
      let next: string | null = f.kind === 'claude-user' ? null : stripAppText(f.content);
      if (next !== null && !next.trim() && createdByApp) next = null;
      if (next === f.content) continue;
      const entry = this.backup(i, f, 'unlink');
      try {
        await this.put(f, next);
      } catch (error) {
        this.forget(i, entry);
        notices.push((error as Error).message);
      }
    }
    i.targets = i.targets.filter((t) => t.host !== host);
    this.store(i);
    return notices;
  }
}
