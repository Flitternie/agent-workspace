// Where a project's research lives: its repository's .research/ folder, on this Mac or on an SSH host.
// Local files are read each time (a hand edit shows at once). A host's are fetched once into memory
// (tree and notes in one round trip) and written back in order; readers wait for pending writes.
import type { Project } from '../shared/types';
import { normalizeResearch, type ResearchDoc, type ResearchNotes } from '../shared/research';
import { createResearch, readNotes, readResearch, sampleNotes, sampleResearch, writeNote, writeResearch } from './research';
import { emptyResearch } from '../shared/research';
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

  constructor(
    private project: (projectId: string) => Project,
    /** A host's research arrived or failed to: the snapshot should show it. */
    private changed: () => void,
    private log: (...args: unknown[]) => void = () => {},
  ) {}

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
    if (scope !== 'summary' && !/^[A-Za-z0-9_-]{1,80}$/.test(scope)) throw new Error('Not a note name.');
    const body = text.endsWith('\n') ? text : `${text}\n`;
    const r = this.remote.get(projectId) ?? { doc: null, notes: { aspects: {} } };
    const note = { text: body, updatedAt: new Date().toISOString() };
    this.remote.set(projectId, { ...r, notes: scope === 'summary' ? { ...r.notes, summary: note } : { ...r.notes, aspects: { ...r.notes.aspects, [scope]: note } } });
    this.enqueue(p, scope === 'summary' ? '.research/summary.md' : `.research/notes/${scope}.md`, body);
  }

  async create(projectId: string, title: string, goal: string, sample: boolean, lang: 'en' | 'zh'): Promise<ResearchDoc> {
    const p = this.project(projectId);
    if (!p.host) return createResearch(p, title, goal, sample, lang);
    await this.ready(projectId);
    if (this.remote.get(projectId)?.doc) throw new Error('This project already has a research.');
    const doc = sample ? sampleResearch(lang, title, goal) : emptyResearch(title.trim(), goal.trim());
    this.saveDoc(projectId, doc);
    if (sample) for (const [scope, text] of Object.entries(sampleNotes(doc, lang))) this.saveNote(projectId, scope, text);
    return doc;
  }

  /** One round trip: research.json, summary.md and notes/*.md, each with its modification time. */
  private fetch(p: Project): Promise<void> {
    const running = this.fetching.get(p.projectId);
    if (running) return running;
    const script = `cd ${shq(p.rootPath)}/.research 2>/dev/null || exit 0; for f in research.json summary.md notes/*.md; do [ -f "$f" ] || continue; t=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"); printf '\\n${MARK} %s %s\\n' "$f" "$t"; base64 < "$f"; done`;
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
    else if (file.startsWith('notes/')) r.notes.aspects[file.slice(6).replace(/\.md$/, '')] = { text, updatedAt };
  }
  return r;
}
