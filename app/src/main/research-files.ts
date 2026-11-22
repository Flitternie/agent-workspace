// Where a research lives: a .research/ folder at the project's root or in one of its folders (one per
// repository, for a project that holds several), on this Mac or on an SSH host. Local files are read each
// time (a hand edit shows at once). A host's are fetched once into memory (tree and notes in one round
// trip) and written back in order; readers wait for pending writes.
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../shared/types';
import { normalizeResearch, type ResearchDoc, type ResearchNotes } from '../shared/research';
import { createResearch, isNoteScope, noteRel, readNotes, readResearch, sampleNotes, sampleResearch, writeNote, writeResearch } from './research';
import { emptyResearch, isResearchDir, parseResearchId, researchId } from '../shared/research';
import { shq, sshError, sshRun, sshRunInput } from './util/ssh';

const MARK = '@@AMW-RESEARCH';
const README = `# .research

The research tree Agent Workspace shows for this project: aspects, the methods tried in each, their
experiments (one agent each), findings, and the end-to-end runs and ablations behind them; summary.md
and notes/ are the agents' markdown notes. Plain files, so people and tools can read and edit them.
`;

interface Remote {
  doc: ResearchDoc | null;
  notes: ResearchNotes;
}

export class ResearchFiles {
  private remote = new Map<string, Remote>();
  private fetching = new Map<string, Promise<void>>();
  private writes = new Map<string, Promise<void>>();
  /** A host project's folders with a research (found in one round trip). */
  private remoteDirs = new Map<string, string[]>();
  private listing = new Map<string, Promise<void>>();

  constructor(
    /** The project a research id names, its root moved to the research's folder. */
    private project: (id: string) => Project,
    /** The project itself. */
    private realProject: (projectId: string) => Project,
    /** A host's research arrived or failed to: the snapshot should show it. */
    private changed: () => void,
    private log: (...args: unknown[]) => void = () => {},
  ) {}

  /** The ids of a project's researches: at its root, then in its folders (one level down). A host's: once listed. */
  ids(projectId: string): string[] {
    const p = this.realProject(projectId);
    if (p.host) {
      const dirs = this.remoteDirs.get(projectId);
      if (!dirs) {
        void this.list(p);
        return [];
      }
      return dirs.map((d) => researchId(projectId, d || undefined));
    }
    const out: string[] = [];
    if (existsSync(join(p.rootPath, '.research', 'research.json'))) out.push(projectId);
    try {
      for (const e of readdirSync(p.rootPath, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && isResearchDir(e.name) && existsSync(join(p.rootPath, e.name, '.research', 'research.json'))) out.push(researchId(projectId, e.name));
      }
    } catch {
      // A missing root: no research.
    }
    return out;
  }

  /** Resolves once a project's researches are known (a host's: listed), so an agent starting now gets their tools. */
  async listed(projectId: string): Promise<void> {
    const p = this.realProject(projectId);
    if (p.host && !this.remoteDirs.has(projectId)) await this.list(p);
  }

  /** Lists again (a host's) on the next read: after a create. */
  forget(projectId: string): void {
    this.remoteDirs.delete(projectId);
  }

  /** Resolves once the research can be read as it is: pending writes done, a host's fetched. */
  async ready(projectId: string): Promise<void> {
    await this.writes.get(projectId);
    const p = this.project(projectId);
    if (p.host && !this.remote.has(projectId)) await this.fetch(p);
  }

  /** The tree now (a host's: what was fetched; null until then, and the fetch is started). */
  doc(projectId: string): ResearchDoc | null {
    const p = this.project(projectId);
    if (!p.host) return readResearch(p);
    const r = this.remote.get(projectId);
    if (!r) void this.fetch(p);
    return r?.doc ?? null;
  }

  notes(projectId: string): ResearchNotes {
    const p = this.project(projectId);
    if (!p.host) return readNotes(p);
    return this.remote.get(projectId)?.notes ?? { aspects: {} };
  }

  saveDoc(projectId: string, doc: ResearchDoc): void {
    const p = this.project(projectId);
    if (!p.host) return writeResearch(p, doc);
    const r = this.remote.get(projectId) ?? { doc: null, notes: { aspects: {} } };
    const first = !r.doc;
    this.remote.set(projectId, { ...r, doc });
    if (first) this.enqueue(p, '.research/README.md', README);
    this.enqueue(p, '.research/research.json', `${JSON.stringify(doc, null, 2)}\n`);
  }

  saveNote(projectId: string, scope: string, text: string): void {
    const p = this.project(projectId);
    if (!p.host) return writeNote(p, scope, text);
    if (!isNoteScope(scope)) throw new Error('Not a note name.');
    const body = text.endsWith('\n') ? text : `${text}\n`;
    const r = this.remote.get(projectId) ?? { doc: null, notes: { aspects: {} } };
    const note = { text: body, updatedAt: new Date().toISOString() };
    const notes = scope === 'summary' ? { ...r.notes, summary: note } : scope === 'ui' ? { ...r.notes, ui: note } : scope.startsWith('view:') ? { ...r.notes, views: { ...r.notes.views, [scope.slice(5)]: note } } : { ...r.notes, aspects: { ...r.notes.aspects, [scope]: note } };
    this.remote.set(projectId, { ...r, notes });
    this.enqueue(p, `.research/${noteRel(scope)}`, body);
  }

  async create(projectId: string, title: string, goal: string, sample: boolean, lang: 'en' | 'zh'): Promise<ResearchDoc> {
    const p = this.project(projectId);
    const { projectId: real, dir } = parseResearchId(projectId);
    if (!p.host) return createResearch(p, title, goal, sample, lang);
    await this.ready(projectId);
    if (this.remote.get(projectId)?.doc) throw new Error(dir ? `${dir} already has a research.` : 'This project already has a research.');
    const doc = sample ? sampleResearch(lang, title, goal) : emptyResearch(title.trim(), goal.trim());
    this.saveDoc(projectId, doc);
    if (sample) for (const [scope, text] of Object.entries(sampleNotes(doc, lang))) this.saveNote(projectId, scope, text);
    const dirs = this.remoteDirs.get(real);
    if (dirs && !dirs.includes(dir ?? '')) this.remoteDirs.set(real, [...dirs, dir ?? '']);
    return doc;
  }

  /**
   * Ends a research without deleting anything: its folder is renamed (.research.dissolved-<when>), so the
   * tree, notes and views stay in the repository and a new research can be started in its place.
   */
  async dissolve(id: string): Promise<string> {
    const p = this.project(id);
    const { projectId: real, dir } = parseResearchId(id);
    const kept = `.research.dissolved-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    if (!p.host) {
      renameSync(join(p.rootPath, '.research'), join(p.rootPath, kept));
      return kept;
    }
    await this.ready(id);
    const r = await sshRun(p.host, `sh -c ${shq(`cd ${shq(p.rootPath)} && mv .research ${shq(kept)}`)}`, 60_000);
    if (r.code !== 0) throw new Error(sshError(p.host, r.stderr));
    this.remote.delete(id);
    const dirs = this.remoteDirs.get(real);
    if (dirs) this.remoteDirs.set(real, dirs.filter((d) => d !== (dir ?? '')));
    return kept;
  }

  /** One round trip: which of a host project's root and folders hold a research. */
  private list(p: Project): Promise<void> {
    const running = this.listing.get(p.projectId);
    if (running) return running;
    const script = `cd ${shq(p.rootPath)} 2>/dev/null || exit 0; [ -f .research/research.json ] && echo .; for f in */.research/research.json; do [ -f "$f" ] && echo "\${f%%/*}"; done; true`;
    const job = sshRun(p.host!, `sh -c ${shq(script)}`, 60_000)
      .then((r) => {
        if (r.code !== 0) throw new Error(sshError(p.host!, r.stderr));
        const dirs = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l === '.' || isResearchDir(l)).map((l) => (l === '.' ? '' : l));
        this.remoteDirs.set(p.projectId, dirs);
      })
      .catch((e) => this.log('research list failed', p.host, (e as Error).message))
      .finally(() => {
        this.listing.delete(p.projectId);
        this.changed();
      });
    this.listing.set(p.projectId, job);
    return job;
  }

  /** One round trip: research.json, summary.md and notes/*.md, each with its modification time. */
  private fetch(p: Project): Promise<void> {
    const running = this.fetching.get(p.projectId);
    if (running) return running;
    const script = `cd ${shq(p.rootPath)}/.research 2>/dev/null || exit 0; for f in research.json summary.md ui.json notes/*.md views/*.md; do [ -f "$f" ] || continue; t=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"); printf '\\n${MARK} %s %s\\n' "$f" "$t"; base64 < "$f"; done`;
    const job = sshRun(p.host!, `sh -c ${shq(script)}`, 60_000)
      .then((r) => {
        if (r.code !== 0) throw new Error(sshError(p.host!, r.stderr));
        this.remote.set(p.projectId, parseFetch(r.stdout));
      })
      .catch((e) => {
        this.log('research fetch failed', p.host, (e as Error).message);
        // Not cached: the next read tries again.
      })
      .finally(() => {
        this.fetching.delete(p.projectId);
        this.changed();
      });
    this.fetching.set(p.projectId, job);
    return job;
  }

  /** Written in order, each whole (to a temporary file, then moved into place). */
  private enqueue(p: Project, rel: string, text: string): void {
    const file = `${p.rootPath}/${rel}`;
    const dir = file.slice(0, file.lastIndexOf('/'));
    const prev = this.writes.get(p.projectId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const r = await sshRunInput(p.host!, `mkdir -p ${shq(dir)} && cat > ${shq(`${file}.tmp`)} && mv ${shq(`${file}.tmp`)} ${shq(file)}`, Buffer.from(text));
        if (r.code !== 0) throw new Error(sshError(p.host!, r.stderr));
      })
      .catch((e) => this.log('research write failed', p.host, rel, (e as Error).message));
    this.writes.set(p.projectId, next);
  }
}

/** The fetch's output: blocks of "MARK <file> <mtime>" then the file's base64. */
export function parseFetch(out: string): Remote {
  const r: Remote = { doc: null, notes: { aspects: {} } };
  const parts = out.split(`\n${MARK} `).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const [file, mtime] = part.slice(0, nl).split(' ');
    const text = Buffer.from(part.slice(nl + 1).replace(/\s+/g, ''), 'base64').toString('utf8');
    const updatedAt = new Date(Number(mtime) * 1000 || Date.now()).toISOString();
    if (file === 'research.json') {
      try {
        r.doc = normalizeResearch(JSON.parse(text));
      } catch {
        r.doc = null;
      }
    } else if (file === 'summary.md') r.notes.summary = { text, updatedAt };
    else if (file === 'ui.json') r.notes.ui = { text, updatedAt };
    else if (file.startsWith('notes/')) r.notes.aspects[file.slice(6).replace(/\.md$/, '')] = { text, updatedAt };
    else if (file.startsWith('views/')) (r.notes.views ??= {})[file.slice(6).replace(/\.md$/, '')] = { text, updatedAt };
  }
  return r;
}
