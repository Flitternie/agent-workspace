import { realpathSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FilePreview, PreviewKind } from '../shared/types';
import { previewKind } from '../shared/preview';
import { shq, sshError, sshRun } from './util/ssh';

// Files an agent wrote, read for the preview column. Only files inside the agent's
// folder (cwd / worktree) or its project are readable, so a crafted path in a
// transcript cannot turn the preview into a general file reader.

export const MAX_BYTES: Record<PreviewKind, number> = { markdown: 2_000_000, html: 2_000_000, text: 2_000_000, image: 10_000_000 };

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

const MARK = '__AMW_FILE__';

type PathApi = Pick<typeof path.posix, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

/** `requested` as an absolute, normalized path (relative ones are taken from `cwd`). */
export function resolveRequested(cwd: string, requested: string, p: PathApi = path): string {
  return p.resolve(cwd, requested);
}

/** Whether `target` is `root` or below it. Both must already be absolute, normalized (and symlink-free). */
export function isInside(target: string, root: string, p: PathApi = path): boolean {
  const rel = p.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${p.sep}`) && rel !== '..' && !p.isAbsolute(rel));
}

export function checkContained(target: string, roots: string[], p: PathApi = path): void {
  if (!roots.some((r) => isInside(target, r, p))) throw new Error('Only files inside this agent’s folder or its project can be previewed.');
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

/** Resolves `requested` on this Mac (symlinks included) and checks it lies inside `roots`. */
export function localPath(cwd: string, requested: string, roots: string[]): string {
  let real: string;
  try {
    real = realpathSync(resolveRequested(cwd, requested));
  } catch {
    throw new Error(`File not found: ${requested}`);
  }
  const realRoots = roots.flatMap((r) => {
    try {
      return [realpathSync(r)];
    } catch {
      return [];
    }
  });
  checkContained(real, realRoots);
  return real;
}

export function readLocal(cwd: string, requested: string, roots: string[]): FilePreview {
  const file = localPath(cwd, requested, roots);
  const kind = kindOf(file);
  const st = statSync(file);
  if (!st.isFile()) throw new Error(`Not a file: ${requested}`);
  if (st.size > MAX_BYTES[kind]) throw tooLarge(kind, st.size);
  return toPreview(file, kind, readFileSync(file));
}

/**
 * Same rules on an SSH host: `realpath` there resolves the file and the roots, the
 * check runs here, then a second call sends the file as base64 (safe for any bytes).
 */
export async function readRemote(host: string, cwd: string, requested: string, roots: string[]): Promise<FilePreview> {
  const wanted = resolveRequested(cwd, requested, path.posix);
  kindOf(wanted); // no round trip for a type we would refuse anyway
  // One marked line per path (login shells may print their own text first); a missing root prints an empty one.
  const r = await sshRun(host, [wanted, ...roots].map((p) => `printf '${MARK}%s\\n' "$(realpath ${shq(p)} 2>/dev/null)"`).join('; '), 20_000);
  if (r.code !== 0 && !r.stdout) throw new Error(sshError(host, r.stderr));
  const [file, ...realRoots] = r.stdout.split('\n').filter((l) => l.startsWith(MARK)).map((l) => l.slice(MARK.length));
  if (!file) throw new Error(`File not found: ${requested}`);
  checkContained(file, realRoots.filter(Boolean), path.posix);
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
