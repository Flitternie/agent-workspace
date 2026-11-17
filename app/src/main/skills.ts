import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { run } from './util/exec';
import { shq, sshError, sshRun, sshRunInput } from './util/ssh';
import type { FoundSkill, LibrarySkill, SkillInfo, SkillSource, SkillsLoad } from '../shared/skills';

export type { FoundSkill, LibrarySkill, SkillsLoad } from '../shared/skills';

// One skill library for every agent the app starts: Claude Code and Codex, on this Mac
// and on SSH hosts. Skills are folders with a SKILL.md (the same format works for both).
// The library is the app's own; ~/.claude/skills and ~/.codex/skills are only read, to
// import from, and never written.
//
//   <dataDir>/skills/plugin/.claude-plugin/plugin.json   a Claude Code plugin ("workspace")
//   <dataDir>/skills/plugin/skills/<name>/SKILL.md        enabled skills (Codex: an extra root)
//   <dataDir>/skills/disabled/<name>/                     kept, but not loaded
//   <dataDir>/skills/manifest.json                        where each skill came from
//
// On an SSH host the CLI only reads paths there, so the plugin folder is copied to
// ~/.agent-workspace/skills before an agent starts on it (only when it changed).

/** Where the CLIs keep their own skills, read for importing. */
export const NATIVE_SKILL_DIRS: Array<{ source: SkillSource; dir: string }> = [
  { source: 'claude', dir: '.claude/skills' },
  { source: 'codex', dir: '.codex/skills' },
  { source: 'agents', dir: '.agents/skills' },
];

interface Manifest {
  skills: Record<string, { origin?: LibrarySkill['origin']; importedAt?: string }>;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const REMOTE_DIR = '.agent-workspace/skills';
const PLUGIN_JSON = JSON.stringify({ name: 'workspace', description: 'Skills shared by Agent Workspace with every agent it starts.' }, null, 2);

/** `name` and `description` from SKILL.md frontmatter (single-line or folded values). */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
      const more: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      value = more.join(value.startsWith('|') ? '\n' : ' ');
    }
    out[kv[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return out;
}

/** Hidden files and folders (.git, .DS_Store…) are not part of a skill. */
const visible = (rel: string) => !rel.split('/').some((p) => p.startsWith('.'));

function listFiles(dir: string, rel = '.'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (!visible(r.slice(2))) continue;
    const full = join(dir, r);
    const st = statSync(full); // follows symlinks, like the copy does
    if (st.isDirectory()) out.push(...listFiles(dir, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

/**
 * sha256 over "./relative/path\n" + content for each visible file, in byte order of the
 * paths. HASH_SH computes the same on a host, so a skill can be compared across machines.
 */
export function folderHash(dir: string): string {
  const h = createHash('sha256');
  for (const f of listFiles(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    h.update(`${f}\n`);
    h.update(readFileSync(join(dir, f)));
  }
  return h.digest('hex');
}

/** Shell version of folderHash, run in the skill's folder. */
export const HASH_SH = `find -L . -type f ! -path '*/.*' | LC_ALL=C sort | while IFS= read -r f; do printf '%s\\n' "$f"; cat "$f"; done | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1`;

function readSkill(dir: string, fallbackName: string): SkillInfo | null {
  const md = join(dir, 'SKILL.md');
  if (!existsSync(md)) return null;
  const fm = parseFrontmatter(readFileSync(md, 'utf8'));
  return { name: fm.name && NAME_RE.test(fm.name) ? fm.name : fallbackName, description: fm.description ?? '', hash: folderHash(dir) };
}

/** Skills in the CLIs' own folders on this Mac. */
export function scanLocal(home = homedir()): FoundSkill[] {
  const out: FoundSkill[] = [];
  for (const { source, dir } of NATIVE_SKILL_DIRS) {
    const base = join(home, dir);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base)) {
      if (e.startsWith('.')) continue; // Codex's bundled .system skills, etc.
      const path = join(base, e);
      try {
        if (!statSync(path).isDirectory()) continue;
        const info = readSkill(path, e);
        if (info) out.push({ ...info, key: `|${source}|${path}`, source, path });
      } catch {
        /* unreadable entry: skip */
      }
    }
  }
  return out;
}

const SKILL_MARK = '__AMW_SKILL__';
const END_MARK = '__AMW_SKILL_END__';

/** One round trip: every skill folder in the CLIs' dirs on the host, with its hash and SKILL.md head. */
export function remoteScanScript(): string {
  const dirs = NATIVE_SKILL_DIRS.map((d) => `${d.source}:${d.dir}`).join(' ');
  return [
    `for entry in ${dirs}; do src="\${entry%%:*}"; base="$HOME/\${entry#*:}"; [ -d "$base" ] || continue`,
    `  for d in "$base"/*/; do [ -f "$d/SKILL.md" ] || continue; d="\${d%/}"`,
    `    h=$(cd "$d" && ${HASH_SH})`,
    `    printf '${SKILL_MARK}\\t%s\\t%s\\t%s\\n' "$src" "$d" "$h"; head -n 60 "$d/SKILL.md"; printf '\\n${END_MARK}\\n'`,
    '  done',
    'done',
  ].join('\n');
}

export function parseRemoteScan(host: string, stdout: string): FoundSkill[] {
  const out: FoundSkill[] = [];
  const re = new RegExp(`^${SKILL_MARK}\\t(\\w+)\\t(.+)\\t([0-9a-f]{64})\\n([\\s\\S]*?)\\n${END_MARK}$`, 'gm');
  for (const m of stdout.matchAll(re)) {
    const [, source, path, hash, head] = m;
    if (!NATIVE_SKILL_DIRS.some((d) => d.source === source)) continue;
    const fm = parseFrontmatter(head);
    const folder = posix.basename(path);
    out.push({ key: `${host}|${source}|${path}`, host, source: source as SkillSource, path, hash, name: fm.name && NAME_RE.test(fm.name) ? fm.name : folder, description: fm.description ?? '' });
  }
  return out;
}

export class SkillLibrary {
  readonly base: string;
  readonly pluginDir: string;
  readonly root: string;
  private disabledDir: string;
  /** host → library hash last copied there (this run). */
  private synced = new Map<string, { hash: string; load: SkillsLoad }>();

  constructor(dataDir: string) {
    this.base = join(dataDir, 'skills');
    this.pluginDir = join(this.base, 'plugin');
    this.root = join(this.pluginDir, 'skills');
    this.disabledDir = join(this.base, 'disabled');
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.disabledDir, { recursive: true });
    mkdirSync(join(this.pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(this.pluginDir, '.claude-plugin', 'plugin.json'), PLUGIN_JSON);
  }

  private manifest(): Manifest {
    try {
      return JSON.parse(readFileSync(join(this.base, 'manifest.json'), 'utf8')) as Manifest;
    } catch {
      return { skills: {} };
    }
  }

  private saveManifest(m: Manifest): void {
    writeFileSync(join(this.base, 'manifest.json'), JSON.stringify(m, null, 2));
  }

  list(): LibrarySkill[] {
    const m = this.manifest();
    const read = (dir: string, enabled: boolean) =>
      readdirSync(dir)
        .filter((n) => !n.startsWith('.') && NAME_RE.test(n))
        .flatMap((n) => {
          const info = readSkill(join(dir, n), n);
          return info ? [{ ...info, name: n, enabled, origin: m.skills[n]?.origin, importedAt: m.skills[n]?.importedAt }] : [];
        });
    return [...read(this.root, true), ...read(this.disabledDir, false)].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Enabled skills, or none: then agents start without the plugin / extra root. */
  hasEnabled(): boolean {
    return readdirSync(this.root).some((n) => !n.startsWith('.') && existsSync(join(this.root, n, 'SKILL.md')));
  }

  /** What changes when the set of loaded skills changes. */
  libraryHash(): string {
    return folderHash(this.root);
  }

  private where(name: string): string | undefined {
    if (!NAME_RE.test(name)) throw new Error(`Not a valid skill name: ${name}`);
    return [join(this.root, name), join(this.disabledDir, name)].find((p) => existsSync(p));
  }

  /** Copies a found skill into the library (replacing one of the same name), enabled. */
  async import(found: FoundSkill): Promise<void> {
    if (!NAME_RE.test(found.name)) throw new Error(`Not a valid skill name: ${found.name}`);
    const staging = mkdtempSync(join(tmpdir(), 'amw-skill-'));
    try {
      const into = join(staging, 'skill');
      if (found.host) {
        // Marked, since a login shell may print a banner before it.
        const r = await sshRun(found.host, `cd ${shq(found.path)} && printf '__AMW_TGZ__\\n' && tar czf - --exclude='*/.*' . | base64 && printf '\\n__AMW_TGZ_END__\\n'`, 120_000);
        const b64 = /__AMW_TGZ__\n([\s\S]*?)\n__AMW_TGZ_END__/.exec(r.stdout)?.[1];
        if (r.code !== 0 || b64 === undefined) throw new Error(r.code === 255 ? sshError(found.host, r.stderr) : `Could not read ${found.path} on ${found.host}.`);
        const tgz = Buffer.from(b64, 'base64');
        if (tgz.length > MAX_IMPORT_BYTES) throw new Error(`${found.name} is too large to import (${(tgz.length / 1e6).toFixed(1)} MB).`);
        mkdirSync(into);
        writeFileSync(join(staging, 'skill.tgz'), tgz);
        const x = await run('tar', ['xzf', join(staging, 'skill.tgz'), '-C', into]);
        if (x.code !== 0) throw new Error(`Could not unpack ${found.name}: ${x.stderr.trim()}`);
      } else {
        cpSync(found.path, into, { recursive: true, dereference: true, filter: (src) => visible(src.slice(found.path.length + 1).replace(/\\/g, '/')) });
      }
      if (!existsSync(join(into, 'SKILL.md'))) throw new Error(`${found.name} has no SKILL.md.`);
      const old = this.where(found.name);
      if (old) rmSync(old, { recursive: true, force: true });
      renameSync(into, join(this.root, found.name));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const m = this.manifest();
    m.skills[found.name] = { origin: { host: found.host, source: found.source, path: found.path }, importedAt: new Date().toISOString() };
    this.saveManifest(m);
  }

  setEnabled(name: string, enabled: boolean): void {
    const from = this.where(name);
    if (!from) throw new Error(`No skill named ${name}.`);
    const to = join(enabled ? this.root : this.disabledDir, name);
    if (from !== to) renameSync(from, to);
  }

  remove(name: string): void {
    const at = this.where(name);
    if (at) rmSync(at, { recursive: true, force: true });
    const m = this.manifest();
    delete m.skills[name];
    this.saveManifest(m);
  }

  /** Where agents on this Mac load the library from. */
  localLoad(): SkillsLoad | undefined {
    return this.hasEnabled() ? { pluginDir: this.pluginDir, root: this.root } : undefined;
  }

  /**
   * Copies the plugin folder to `host` when it differs from what is there (a hash stamp
   * on the host), and returns where agents there load it from.
   */
  async ensureOnHost(host: string): Promise<SkillsLoad | undefined> {
    if (!this.hasEnabled()) return undefined;
    const hash = this.libraryHash();
    const cached = this.synced.get(host);
    if (cached?.hash === hash) return cached.load;
    const probe = await sshRun(host, `printf '__AMW_HOME__%s\\n' "$HOME"; printf '__AMW_HASH__%s\\n' "$(cat "$HOME/${REMOTE_DIR}/.amw-hash" 2>/dev/null)"`, 30_000);
    if (probe.code !== 0) throw new Error(probe.code === 255 ? sshError(host, probe.stderr) : `Could not check skills on ${host}.`);
    const home = /__AMW_HOME__(.+)/.exec(probe.stdout)?.[1]?.trim();
    if (!home?.startsWith('/')) throw new Error(`Could not find the home folder on ${host}.`);
    const pluginDir = posix.join(home, REMOTE_DIR);
    const load = { pluginDir, root: posix.join(pluginDir, 'skills') };
    if (/__AMW_HASH__(.*)/.exec(probe.stdout)?.[1]?.trim() !== hash) {
      // Unpack beside, then swap, so an agent never sees a half-copied library.
      const script = [
        'set -e',
        `d="$HOME/${REMOTE_DIR}"`,
        'rm -rf "$d.tmp" && mkdir -p "$d.tmp"',
        'tar xzf - -C "$d.tmp"',
        `printf %s ${hash} > "$d.tmp/.amw-hash"`,
        'rm -rf "$d.old"; [ -d "$d" ] && mv "$d" "$d.old"; mv "$d.tmp" "$d"; rm -rf "$d.old"',
      ].join('\n');
      const r = await sshRunInput(host, script, await packed(this.pluginDir), 120_000);
      if (r.code !== 0) throw new Error(r.code === 255 ? sshError(host, r.stderr) : `Could not copy skills to ${host}: ${r.stderr.trim().split('\n').pop() ?? ''}`);
    }
    this.synced.set(host, { hash, load });
    return load;
  }
}

/** The plugin folder as a .tgz (binary; `run` returns text, so tar writes a file). */
async function packed(dir: string): Promise<Buffer> {
  const tmp = mkdtempSync(join(tmpdir(), 'amw-skills-'));
  try {
    const file = join(tmp, 'skills.tgz');
    // macOS tar would add ._ files for extended attributes; hosts are usually Linux.
    const mac = process.platform === 'darwin' ? ['--no-mac-metadata'] : [];
    const r = await run('tar', ['czf', file, ...mac, '--exclude', '.DS_Store', '-C', dir, '.'], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`Could not pack the skill library: ${r.stderr.trim()}`);
    return readFileSync(file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
