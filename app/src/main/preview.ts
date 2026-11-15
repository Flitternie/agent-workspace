import { existsSync, readdirSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FilePreview, PreviewKind, TranscriptItem } from '../shared/types';
import { previewKind } from '../shared/preview';
import { shq, sshError, sshRun } from './util/ssh';

// Files an agent mentions or wrote, read for the preview column.
//
// Finding the file: agents often work in a subfolder (or a symlinked repo) of the folder
// they were started in and name files relative to where they are, so a relative path is
// tried against the folders the agent actually worked in (most recent first), then its
// own folder, then searched for by its ending inside the agent's roots.
//
// Who may read what: files inside the agent's folder, worktree or project, including
// folders symlinked from there, open directly. Other files open only after the user
// confirms (allowOutside), and credential locations never do, so a crafted path in a
// transcript cannot quietly turn the preview into a general file reader.

export const MAX_BYTES: Record<PreviewKind, number> = { markdown: 2_000_000, html: 2_000_000, text: 2_000_000, code: 1_000_000, image: 10_000_000 };

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

const MARK = '__AMW_FILE__';

type PathApi = Pick<typeof path.posix, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

/** `requested` as an absolute, normalized path (relative ones are taken from `cwd`). */
export function resolveRequested(cwd: string, requested: string, p: PathApi = path, home = homedir()): string {
  // "~/notes.md" as agents write it: the home folder (still checked against the agent's roots).
  if (requested === '~' || requested.startsWith('~/')) return p.resolve(home, requested.slice(2));
  return p.resolve(cwd, requested);
}

/** Whether `target` is `root` or below it. Both must already be absolute, normalized (and symlink-free). */
export function isInside(target: string, root: string, p: PathApi = path): boolean {
  const rel = p.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${p.sep}`) && rel !== '..' && !p.isAbsolute(rel));
}

/**
 * Folders the agent worked in, most recent first: where its shell commands `cd`-ed to or
 * ran, and the folders of files it read or changed. `p` is posix for an agent on a host.
 */
export function workDirs(items: TranscriptItem[], cwd: string, p: Pick<typeof path.posix, 'resolve' | 'dirname' | 'isAbsolute'> = path, max = 12): string[] {
  const out: string[] = [];
  const add = (dir: string | undefined) => {
    if (!dir || dir === '-' || /[$`*?]/.test(dir)) return;
    const d = p.resolve(cwd, dir.replace(/^(["'])(.*)\1$/, '$2'));
    if (!out.includes(d)) out.push(d);
  };
  for (let i = items.length - 1; i >= 0 && out.length < max; i--) {
    const tool = items[i].tool;
    if (!tool) continue;
    for (const c of [...tool.content].reverse()) {
      if (c.type === 'terminal') {
        const cds = [...c.command.matchAll(/(?:^|[;&|(]\s*|\n\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)].map((m) => m[1]);
        for (const d of cds.reverse()) add(d);
        add(c.cwd);
      } else if (c.type === 'diff') add(p.dirname(c.diff.path));
    }
    for (const l of tool.locations) if (p.isAbsolute(l.path)) add(p.dirname(l.path));
  }
  return out.slice(0, max);
}

/** Error text the UI recognizes to offer "Show anyway" (see FilePreview). */
export const OUTSIDE = 'This file is outside the agent’s folder and project.';

/** Credentials and keys: never previewed, confirmed or not. */
export function isPrivate(file: string, home: string, p: PathApi = path): boolean {
  const rel = isInside(file, home, p) ? p.relative(home, file).split(p.sep) : [];
  const dirs = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store', '.azure', 'Library'];
  if (rel.length && dirs.includes(rel[0])) return true;
  if (rel[0] === '.config' && ['gh', 'gcloud', 'op'].includes(rel[1] ?? '')) return true;
  const name = file.split(/[\\/]/).pop() ?? '';
  return /^(auth|credentials|\.credentials|token|tokens|secrets?)\.(json|ya?ml|toml|txt)$/i.test(name) || /^\.netrc$/.test(name);
}

export function checkContained(target: string, roots: string[], p: PathApi = path, opts: { allowOutside?: boolean; home?: string } = {}): void {
  if (isPrivate(target, opts.home ?? homedir(), p)) throw new Error('This file is in a private location (keys or credentials) and is not previewed.');
  if (roots.some((r) => isInside(target, r, p)) || opts.allowOutside) return;
  throw new Error(OUTSIDE);
}

/** Where to look for a file and who may read it, from the workspace. */
export interface PreviewWhere {
  cwd: string;
  /** Folders the agent worked in, most recent first (relative paths are tried here first). */
  bases: string[];
  /** The agent's folder, worktree and project. */
  roots: string[];
  allowOutside?: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build']);

/** `rel` (e.g. "slides/a.html") somewhere below `root`, following symlinks, a few levels deep. */
function searchLocal(root: string, rel: string, depth = 6): string | undefined {
  const parts = rel.split('/').filter((x) => x && x !== '.');
  let seen = 0;
  const walk = (dir: string, d: number): string | undefined => {
    if (d > depth || ++seen > 20_000) return undefined;
    const direct = path.join(dir, ...parts);
    if (existsSync(direct) && statSync(direct).isFile()) return direct;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
      const full = path.join(dir, e);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      const hit = walk(full, d + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root, 0);
}

/** The agent's roots, plus the folders symlinked directly inside them (a repo linked into ~/projects). */
function realRootsLocal(roots: string[]): string[] {
  const out = new Set<string>();
  for (const r of roots) {
    try {
      out.add(realpathSync(r));
      for (const e of readdirSync(r)) {
        const full = path.join(r, e);
        try {
          if (statSync(full).isDirectory() && realpathSync(full) !== path.join(realpathSync(r), e)) out.add(realpathSync(full));
        } catch {
          /* broken link */
        }
      }
    } catch {
      /* missing root */
    }
  }
  return [...out];
}

/** The file `requested` names, as the agent meant it (see the top of this file). */
export function findLocal(requested: string, where: PreviewWhere, home = homedir()): string | undefined {
  const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
  if (path.isAbsolute(requested) || requested.startsWith('~/')) {
    const f = resolveRequested(where.cwd, requested, path, home);
    return isFile(f) ? f : undefined;
  }
  for (const base of [...where.bases, where.cwd]) {
    const f = path.resolve(base, requested);
    if (isFile(f)) return f;
  }
  for (const root of where.roots) {
    const f = searchLocal(root, requested);
    if (f) return f;
  }
  return undefined;
}

function kindOf(file: string): PreviewKind {
  const kind = previewKind(file);
  if (!kind) throw new Error(`This file type cannot be previewed: ${path.basename(file)}`);
  return kind;
}

function tooLarge(kind: PreviewKind, size: number): Error {
  return new Error(`File is too large to preview (${(size / 1e6).toFixed(1)} MB; limit ${MAX_BYTES[kind] / 1e6} MB).`);
}

function toPreview(file: string, kind: PreviewKind, data: Buffer): FilePreview {
  if (kind === 'image') return { path: file, kind, size: data.length, dataUrl: `data:${MIME[path.extname(file).slice(1).toLowerCase()]};base64,${data.toString('base64')}` };
  return { path: file, kind, size: data.length, text: data.toString('utf8') };
}

/** Finds `requested` on this Mac (see findLocal), resolves symlinks and checks who may read it. */
export function localPath(requested: string, where: PreviewWhere, home = homedir()): string {
  const found = findLocal(requested, where, home);
  if (!found) throw new Error(`File not found: ${requested}`);
  const real = realpathSync(found);
  checkContained(real, realRootsLocal(where.roots), path, { allowOutside: where.allowOutside, home });
  return real;
}

export function readLocal(requested: string, where: PreviewWhere): FilePreview {
  const file = localPath(requested, where);
  const kind = kindOf(file);
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`Not a file: ${requested}`);
  if (st.size > MAX_BYTES[kind]) throw tooLarge(kind, st.size);
  return toPreview(file, kind, readFileSync(file));
}

/**
 * The same on an SSH host, in one round trip: the shell there finds the file (bases, own
 * folder, then a search below the roots), and prints its real path, the real roots
 * (with the folders symlinked inside them) and the home folder; the check runs here.
 */
export function remoteFindScript(requested: string, where: PreviewWhere): string {
  const q = shq;
  const lines = [`req=${q(requested)}`, 'cand=""'];
  if (requested.startsWith('/')) lines.push('[ -f "$req" ] && cand="$req"');
  else if (requested.startsWith('~/')) lines.push(`[ -f "$HOME"/${q(requested.slice(2))} ] && cand="$HOME"/${q(requested.slice(2))}`);
  else {
    for (const b of [...where.bases, where.cwd]) lines.push(`[ -z "$cand" ] && [ -f ${q(b)}/"$req" ] && cand=${q(b)}/"$req"`);
    const prune = [...SKIP_DIRS].map((d) => `-name ${q(d)}`).join(' -o ');
    for (const r of where.roots) lines.push(`[ -z "$cand" ] && cand=$(find -L ${q(r)} -maxdepth 6 \\( ${prune} \\) -prune -o -type f -path "*/$req" -print 2>/dev/null | head -n 1)`);
  }
  lines.push(`printf '${MARK}FILE %s\\n' "$( [ -n "$cand" ] && realpath "$cand" 2>/dev/null)"`);
  lines.push(`printf '${MARK}HOME %s\\n' "$HOME"`);
  for (const r of where.roots) lines.push(`printf '${MARK}ROOT %s\\n' "$(realpath ${q(r)} 2>/dev/null)"; for l in ${q(r)}/*; do [ -L "$l" ] && [ -d "$l" ] && printf '${MARK}ROOT %s\\n' "$(realpath "$l")"; done`);
  return lines.join('\n');
}

export function parseRemoteFind(stdout: string): { file: string; home: string; roots: string[] } {
  const get = (k: string) => stdout.split('\n').filter((l) => l.startsWith(`${MARK}${k} `)).map((l) => l.slice(MARK.length + k.length + 1).trim());
  return { file: get('FILE')[0] ?? '', home: get('HOME')[0] ?? '', roots: get('ROOT').filter(Boolean) };
}

export async function readRemote(host: string, requested: string, where: PreviewWhere): Promise<FilePreview> {
  kindOf(requested); // no round trip for a type we would refuse anyway
  const r = await sshRun(host, `sh -c ${shq(remoteFindScript(requested, where))}`, 30_000);
  if (r.code !== 0 && !r.stdout.includes(MARK)) throw new Error(sshError(host, r.stderr));
  const { file, home, roots } = parseRemoteFind(r.stdout);
  if (!file) throw new Error(`File not found: ${requested}`);
  checkContained(file, roots, path.posix, { allowOutside: where.allowOutside, home: home || '/nonexistent' });
  const kind = kindOf(file); // a symlink's target decides, as on this Mac
  const max = MAX_BYTES[kind];
  // Size first, so an oversized file is never sent; exit 3 marks "not a regular file".
  const read = await sshRun(host, `f=${shq(file)}; [ -f "$f" ] || exit 3; n=$(wc -c < "$f" | tr -d ' '); printf '${MARK}%s\\n' "$n"; [ "$n" -le ${max} ] && base64 < "$f"`, 60_000);
  if (read.code === 3) throw new Error(`Not a file: ${requested}`);
  const out = read.stdout.slice(read.stdout.indexOf(MARK) + MARK.length);
  const nl = out.indexOf('\n');
  const size = Number(out.slice(0, nl));
  if (size > max) throw tooLarge(kind, size);
  if (read.code !== 0 || !read.stdout.includes(MARK)) throw new Error(sshError(host, read.stderr));
  return toPreview(file, kind, Buffer.from(out.slice(nl + 1).replace(/\s+/g, ''), 'base64'));
}
