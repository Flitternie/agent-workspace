import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MemoryBackup, MemoryRecord } from '../shared/types';
import { shq, sshError, sshRun, sshRunInput } from './util/ssh';

// User memory shared with the CLIs on every linked machine, so a terminal `claude` or
// `codex` sees what the app's agents see. A machine is linked once (its files backed
// up, its user-level notes merged in); from then on the shared user memory is the truth
// and every change goes to every linked machine.
//
//   Claude Code: one marked import line in ~/.claude/CLAUDE.md, added once,
//                pointing at ~/.agent-workspace/memory/user.md, which the app owns.
//   Codex:       a marked section at the end of ~/.codex/AGENTS.md (it has no imports).
//
// Text outside the app's lines and section is never changed. Before any change the
// whole file is backed up here (the version from before linking is kept for good, and
// a copy is also left on the machine), and a write only goes ahead if the file is still
// what was read. Any backup can be restored.

export const IMPORT_MARK = '<!-- agent-workspace:user-memory (your Agent Workspace user memory; remove these two lines to stop) -->';
export const IMPORT_LINE = '@~/.agent-workspace/memory/user.md';
export const BEGIN = '<!-- agent-workspace:user-memory:begin -->';
export const END = '<!-- agent-workspace:user-memory:end -->';
const SECTION_RE = /\n*<!-- agent-workspace:user-memory:begin -->[\s\S]*?<!-- agent-workspace:user-memory:end -->[ \t]*\n?/;
const IMPORT_RE = /\n*<!-- agent-workspace:user-memory \(.*?\) -->[ \t]*\n@~\/\.agent-workspace\/memory\/user\.md[ \t]*\n?/;

/** These files are loaded into every terminal session: keep the shared part reasonable. */
export const MAX_NOTES_CHARS = 16_000;
const KEEP_BACKUPS = 20;
const LOCAL = 'local';

/** claude-md: the user's CLAUDE.md (import line); claude-user: the app's own user.md; codex-md: AGENTS.md (section). */
export type TargetKind = 'claude-md' | 'claude-user' | 'codex-md';

export interface FileState {
  host: string; // LOCAL or an SSH alias
  kind: TargetKind;
  /** Absolute path on that machine. */
  path: string;
  /** "~/.claude/CLAUDE.md": the form import keys use. */
  file: string;
  /** The CLI's folder exists there (else that CLI is not set up on the machine: nothing is written for it). */
  dirExists: boolean;
  exists: boolean;
  content: string;
}

export type BackupEntry = MemoryBackup;

/** Removes the app's import lines and section; nothing else. */
export function stripAppText(text: string): string {
  let out = text;
  for (const re of [IMPORT_RE, SECTION_RE]) {
    const at = out.search(re);
    if (at === -1) continue;
    const before = out.slice(0, at).replace(/\s+$/, '');
    const after = out.slice(at).replace(re, '');
    out = before && after ? `${before}\n\n${after}` : before ? `${before}\n` : after;
  }
  return out;
}

/** One bullet per note; a note that starts with a heading reads "Heading: text". */
export function noteLine(note: string): string {
  const [first, ...rest] = note.trim().split('\n');
  const h = /^#{1,6}\s+(.*?)\s*#*$/.exec(first.trim());
  const text = h ? `${h[1]}: ${rest.join('\n').trim()}` : note;
  // Paragraphs (e.g. a Claude memory's description, then its body) become sentences.
  const paras = text.replace(/^#{1,6}\s+/gm, '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return paras.map((p, i) => (i < paras.length - 1 && !/[.!?:;。！？：；]$/.test(p) ? `${p}${/[\u3400-\u9fff]$/.test(p) ? '。' : '.'}` : p)).join(' ');
}

export function renderNotes(notes: string[]): string {
  return notes.map((n) => `- ${n}`).join('\n');
}

/** Appends a block after the existing text, separated by a blank line. */
const append = (text: string, block: string) => (!text ? `${block}\n` : `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}\n`);

/** CLAUDE.md with the import line present exactly once (added at the end if missing). */
export function withImport(text: string): string {
  return IMPORT_RE.test(text) ? text : append(text, `${IMPORT_MARK}\n${IMPORT_LINE}`);
}

/** AGENTS.md with the section holding `notes` (replaced in place, or appended). */
export function withSection(text: string, notes: string[]): string {
  const section = [BEGIN, '<!-- Your Agent Workspace user memory, kept in sync by the app. Edit it in the app (Settings › Memory): changes here are replaced. -->', renderNotes(notes), END].join('\n');
  if (!SECTION_RE.test(text)) return append(text, section);
  return text.slice(0, text.indexOf(BEGIN)) + section + text.slice(text.indexOf(END) + END.length);
}

export function userFile(notes: string[]): string {
  return ['<!-- Your user memory from Agent Workspace, kept in sync by the app on every linked machine. Edit it in the app (Settings › Memory): changes here are replaced. -->', '', '# User memory', '', renderNotes(notes), ''].join('\n');
}

/**
 * The notes shared with a file's CLI: approved user memory, minus notes that came from
 * that CLI's own file on that machine (they are already there, outside the app's text).
 */
export function notesFor(host: string, ownFile: string, records: MemoryRecord[]): string[] {
  const fromThere = (key: string) => {
    const [, h, file] = key.split('|');
    return (h ?? LOCAL) === host && file === ownFile;
  };
  const notes: string[] = [];
  let size = 0;
  for (const r of records) {
    if (r.scope !== 'global' || !r.approvedForReuse) continue;
    if ([r.source ?? '', ...(r.importKeys ?? [])].some(fromThere)) continue;
    const note = noteLine(r.body);
    if (!note || size + note.length > MAX_NOTES_CHARS) continue;
    size += note.length;
    notes.push(note);
  }
  return notes;
}

/** What each of a machine's files should become (null: leave it as it is). */
export function plan(files: FileState[], records: MemoryRecord[]): Array<{ file: FileState; next: string | null }> {
  const claudeMd = files.find((f) => f.kind === 'claude-md');
  return files.map((f) => {
    let next: string | null = null;
    if (f.dirExists) {
      if (f.kind === 'claude-md') next = withImport(f.content);
      if (f.kind === 'claude-user') next = userFile(notesFor(f.host, claudeMd?.file ?? '', records));
      if (f.kind === 'codex-md') next = withSection(f.content, notesFor(f.host, f.file, records));
    }
    return { file: f, next: next === null || (f.exists && next === f.content) ? null : next };
  });
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------ one machine's files

const MARK = '__AMW_WB__';

/** The three files on a machine in one round trip; base64 so any content survives banners and quoting. */
export const READ_SCRIPT = `h="$HOME"; c="\${CLAUDE_CONFIG_DIR:-$h/.claude}"; x="\${CODEX_HOME:-$h/.codex}"
for t in "claude-md:$c:$c/CLAUDE.md" "claude-user:$c:$h/.agent-workspace/memory/user.md" "codex-md:$x:$x/AGENTS.md"; do
  k="\${t%%:*}"; r="\${t#*:}"; d="\${r%%:*}"; f="\${r#*:}"
  de=0; [ -d "$d" ] && de=1; fe=0; [ -f "$f" ] && fe=1
  b=""; [ "$fe" = 1 ] && b=$(base64 < "$f" | tr -d '\\n')
  printf '${MARK}\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$k" "$f" "$de" "$fe" "$b" "$h"
done
printf '${MARK}_DONE\\n'`;

export function parseRead(host: string, stdout: string): FileState[] {
  if (!stdout.includes(`${MARK}_DONE`)) throw new Error('Incomplete answer.');
  return stdout.split('\n').flatMap((line) => {
    const p = line.replace(/\r$/, '').split('\t');
    if (p[0] !== MARK || p.length < 7) return [];
    const [, kind, path, de, fe, b64, home] = p;
    const file = home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
    return [{ host, kind: kind as TargetKind, path, file, dirExists: de === '1', exists: fe === '1', content: Buffer.from(b64, 'base64').toString('utf8') }];
  });
}

/**
 * Replaces `path` with stdin (or deletes it: restoring "did not exist") only if it still
 * has the content that was read (`expect`: its sha256, '-' = absent). With `keep`, a copy
 * of the current file is first left beside the other backups on that machine.
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

export class MemoryWriteback {
  private dir: string;

  constructor(
    dataDir: string,
    /** The home used for this Mac (tests). */
    private home = homedir(),
  ) {
    this.dir = join(dataDir, 'memory-backups');
    mkdirSync(this.dir, { recursive: true });
  }

  private index(): BackupEntry[] {
    try {
      return (JSON.parse(readFileSync(join(this.dir, 'index.json'), 'utf8')) as { backups: BackupEntry[] }).backups;
    } catch {
      return [];
    }
  }

  private save(backups: BackupEntry[]): void {
    writeFileSync(join(this.dir, 'index.json'), JSON.stringify({ backups }, null, 2));
  }

  backups(host?: string): BackupEntry[] {
    return this.index().filter((b) => host === undefined || b.host === host);
  }

  backupContent(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Not a backup id.');
    return readFileSync(join(this.dir, `${id}.bak`), 'utf8');
  }

  /** A machine's three files as they are now. */
  async read(host: string): Promise<FileState[]> {
    if (host === LOCAL) {
      const c = process.env.CLAUDE_CONFIG_DIR || join(this.home, '.claude');
      const x = process.env.CODEX_HOME || join(this.home, '.codex');
      const rows: Array<[TargetKind, string, string]> = [
        ['claude-md', c, join(c, 'CLAUDE.md')],
        ['claude-user', c, join(this.home, '.agent-workspace/memory/user.md')],
        ['codex-md', x, join(x, 'AGENTS.md')],
      ];
      return rows.map(([kind, d, path]) => {
        const exists = existsSync(path) && statSync(path).isFile();
        return { host, kind, path, file: path.startsWith(`${this.home}/`) ? `~/${path.slice(this.home.length + 1)}` : path, dirExists: existsSync(d), exists, content: exists ? readFileSync(path, 'utf8') : '' };
      });
    }
    const r = await sshRun(host, `sh -c ${shq(READ_SCRIPT)}`, 30_000);
    if (r.code !== 0) throw new Error(r.code === 255 ? sshError(host, r.stderr) : `Could not read the memory files on ${host}.`);
    return parseRead(host, r.stdout);
  }

  private backup(f: FileState, reason: BackupEntry['reason']): BackupEntry {
    let all = this.index();
    const entry: BackupEntry = { id: `${Date.now()}-${randomUUID().slice(0, 6)}`, host: f.host, path: f.path, at: new Date().toISOString(), reason, existed: f.exists, size: Buffer.byteLength(f.content) };
    if (reason === 'link' && !all.some((b) => b.host === f.host && b.path === f.path && b.original)) entry.original = true;
    writeFileSync(join(this.dir, `${entry.id}.bak`), f.content);
    all.push(entry);
    const mine = all.filter((b) => b.host === f.host && b.path === f.path && !b.original);
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) {
      rmSync(join(this.dir, `${old.id}.bak`), { force: true });
      all = all.filter((b) => b !== old);
    }
    this.save(all);
    return entry;
  }

  /** Writes `next` (null = delete) if the file is still as read; `keep` also leaves a copy on the machine. */
  private async put(f: FileState, next: string | null, keep?: string): Promise<void> {
    const expect = f.exists ? sha(f.content) : '-';
    if (f.host === LOCAL) {
      const now = existsSync(f.path) ? readFileSync(f.path, 'utf8') : null;
      if ((now === null ? '-' : sha(now)) !== expect) throw new Error(`${f.path} changed since it was read; nothing written.`);
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
    if (r.code === 3) throw new Error(`${f.path} on ${f.host} changed since it was read; nothing written.`);
    if (r.code !== 0 || !r.stdout.includes('__AMW_WB_OK__')) throw new Error(r.code === 255 ? sshError(f.host, r.stderr) : `Could not write ${f.path} on ${f.host}: ${r.stderr.trim().split('\n').pop() ?? ''}`);
  }

  /**
   * Brings a machine's files in line with `records`: each changed file is backed up, then
   * written if still unchanged. `link` = the first sync (also leaves copies on the machine).
   */
  async write(host: string, records: MemoryRecord[], reason: 'link' | 'sync'): Promise<{ written: string[]; errors: string[] }> {
    const written: string[] = [];
    const errors: string[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const { file, next } of plan(await this.read(host), records)) {
      if (next === null) continue;
      // Import line taken out by hand on a linked machine: that is the user's call; say so instead of re-adding it.
      if (reason === 'sync' && file.kind === 'claude-md' && file.exists) {
        errors.push(`The Agent Workspace line was removed from ${file.path}${host === LOCAL ? '' : ` on ${host}`}; Claude Code there no longer gets user memory. Link the machine again to put it back.`);
        continue;
      }
      this.backup(file, reason);
      try {
        await this.put(file, next, reason === 'link' && file.kind !== 'claude-user' ? `${file.path.split('/').pop()}.before-agent-workspace.${stamp}` : undefined);
        written.push(file.path);
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    return { written, errors };
  }

  /** Puts a file back as it was in a backup; the current version is backed up first. */
  async restore(id: string): Promise<void> {
    const b = this.index().find((x) => x.id === id);
    if (!b) throw new Error('That backup no longer exists.');
    const content = this.backupContent(id);
    const current = (await this.read(b.host)).find((f) => f.path === b.path);
    if (!current) throw new Error(`${b.path} is not one of the files the app manages.`);
    this.backup(current, 'restore');
    await this.put(current, b.existed ? content : null);
  }

  /**
   * Unlinks a machine: `remove` takes out only the app's lines, section and user.md;
   * `original` puts each file back as it was before linking. Backed up first either way.
   */
  async unlink(host: string, how: 'remove' | 'original'): Promise<void> {
    const originals = this.index().filter((b) => b.host === host && b.original);
    for (const f of await this.read(host)) {
      const orig = originals.find((b) => b.path === f.path);
      const next = f.kind === 'claude-user' ? null : how === 'original' && orig ? (orig.existed ? this.backupContent(orig.id) : null) : stripAppText(f.content);
      if (!f.exists && next === null) continue;
      if (f.exists && next === f.content) continue;
      this.backup(f, 'unlink');
      await this.put(f, next);
    }
  }
}
