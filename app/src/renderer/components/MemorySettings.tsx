import { useEffect, useState } from 'react';
import type { MemoryCandidate, MemoryRecord, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { MemoryShare } from './MemoryShare';
import { timeAgo } from '../state';
import { Icon } from './bits';
import { Markdown } from './Markdown';

// Settings › Memory: user memory (scope `global`) and project memory, sharing user
// memory with the CLIs on linked machines (MemoryShare), and a manual import list.
// Sync never deletes or overwrites a note: a note whose source is gone is retired (and
// can be restored), and an edited note whose source changed shows both versions.

const MAX_BODY = 4000; // keep in sync with main/memory-import MAX_BODY

/** "devbox · ~/AGENTS.md › style" for an import key (`source|host|file|section`). */
export function describeImportKey(key: string): string {
  const [, host, file, section] = key.split('|');
  if (!file) return key;
  return `${host && host !== 'local' ? `${host} · ` : `${t('This Mac')} · `}${file}${section && section !== 'all' ? ` › ${section}` : ''}`;
}

/** Where a note came from, in a few words. */
export function memorySourceText(m: MemoryRecord): string {
  if (m.importKeys?.length) return m.importKeys.map(describeImportKey).join(', ');
  if (m.source === 'voice') return t('Said to the coordinator');
  if (m.source === 'main agent') return t('Saved by the main agent');
  if (m.originTaskId) return t('Kept from a conversation');
  return t('Added in the app');
}

/** A note as one line: its title, else its first line of text. */
const lineOf = (m: MemoryRecord) => (m.title || m.body.replace(/^#{1,6}\s+/, '').split('\n').find((l) => l.trim()) || '').trim();

/** One note: a line (title, state, source); opens to the rendered text and its actions. */
function NoteRow({ m, onError }: { m: MemoryRecord; onError: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const run = (p: Promise<unknown>) => p.catch((e) => onError(errorText(e)));
  const off = !m.approvedForReuse;
  return (
    <div className={`ms-note${open ? ' open' : ''}${off || m.sourceRemoved ? ' dim' : ''}`} data-testid="memory-setting-record" data-scope={m.scope}>
      <button className="ms-note-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={11} />
        <span className="ms-note-title">{lineOf(m)}</span>
        {m.sourceBody !== undefined ? <span className="ms-tag warn">{t('changed at its source')}</span> : null}
        {m.sourceRemoved ? <span className="ms-tag">{t('retired')}</span> : off ? <span className="ms-tag">{t('off')}</span> : null}
        <span className="ms-note-source truncate" title={memorySourceText(m)}>
          {memorySourceText(m)}
        </span>
      </button>
      {open ? (
        <div className="ms-note-body">
          {draft ? (
            <div className="ms-editor">
              <input className="input" value={draft.title} placeholder={t('Title')} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <textarea className="input mono" rows={Math.min(14, Math.max(4, draft.body.split('\n').length + 1))} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} autoFocus />
              <div className="ms-actions">
                <button className="btn btn-sm btn-primary" disabled={!draft.body.trim()} onClick={() => void run(call('memory:update', { id: m.id, title: draft.title.trim() || undefined, body: draft.body.trim() }).then(() => setDraft(null)))}>
                  {t('Save')}
                </button>
                <button className="btn btn-sm" onClick={() => setDraft(null)}>
                  {t('Cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="ms-text">
              <Markdown text={m.body} />
            </div>
          )}
          {m.sourceBody !== undefined ? (
            <div className="memory-conflict" data-testid="memory-conflict">
              <div className="small">{t('Changed at its source too. Its source now says:')}</div>
              <div className="ms-text">
                <Markdown text={m.sourceBody} />
              </div>
              <div className="row">
                <button className="btn btn-sm" onClick={() => void run(call('memory:resolveConflict', { id: m.id, take: 'source' }))}>
                  {t('Use this version')}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => void run(call('memory:resolveConflict', { id: m.id, take: 'mine' }))}>
                  {t('Keep mine')}
                </button>
              </div>
            </div>
          ) : null}
          {m.sourceRemoved ? (
            <div className="muted small">
              {t('Its source was deleted on its machine, so it is no longer shared or given to agents. Nothing was deleted here.')}{' '}
              <button className="link small" onClick={() => void run(call('memory:restoreNote', { id: m.id }))} data-testid="memory-restore-note">
                {t('Use it again')}
              </button>
            </div>
          ) : null}
          {draft ? null : (
            <div className="ms-actions">
              <button className="link" onClick={() => setDraft({ title: m.title ?? '', body: m.body })}>
                {t('Edit')}
              </button>
              {m.scope !== 'task' && !m.sourceRemoved ? (
                <button className="link" title={t('An off note is kept but not given to agents or shared.')} onClick={() => void run(call('memory:update', { id: m.id, approvedForReuse: off }))}>
                  {off ? t('Turn on') : t('Turn off')}
                </button>
              ) : null}
              <button className="link danger" onClick={() => void run(call('memory:delete', { id: m.id }))}>
                {t('Delete')}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A new user note, written here: title and text, saved when the user says so. */
function NewNote({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  return (
    <div className="ms-note open ms-new">
      <div className="ms-editor">
        <input className="input" value={title} placeholder={t('Title (optional)')} onChange={(e) => setTitle(e.target.value)} autoFocus data-testid="memory-new-title" />
        <textarea className="input" rows={4} value={body} placeholder={t('What every agent should know or do…')} onChange={(e) => setBody(e.target.value)} data-testid="memory-new-body" />
        <div className="ms-actions">
          <button className="btn btn-sm btn-primary" disabled={!body.trim()} data-testid="memory-new-save"
            onClick={() => void call('memory:add', { scope: 'global', scopeId: 'global', title: title.trim() || undefined, body: body.trim(), approvedForReuse: true }).then(onDone, (e) => onError(errorText(e)))}>
            {t('Save')}
          </button>
          <button className="btn btn-sm" onClick={onDone}>
            {t('Cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "~/projects/shop" for a project's folder (home shortened), with its machine. */
function where(p: WorkspaceSnapshot['projects'][number]): string {
  const path = p.rootPath.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
  return p.host ? `${p.host}:${path}` : path;
}

export function MemorySettings({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [tab, setTab] = useState<'user' | 'project'>('user');
  const [adding, setAdding] = useState(false);
  const sync = snapshot.memorySync;
  const last = sync.last;
  const hostName = (h: string) => (h === 'local' ? t('This Mac') : h);
  const user = snapshot.memory.filter((m) => m.scope === 'global');
  const projectNotes = snapshot.memory.filter((m) => m.scope === 'project');
  const groups = snapshot.projects.map((p) => ({ p, notes: projectNotes.filter((m) => m.scopeId === p.projectId) })).filter((g) => g.notes.length);

  return (
    <div className="memory-settings">
      <div className="ms-intro">
        <p className="muted small">{t('Notes every agent the app starts gets, with Claude Code or Codex, here or over SSH. They load when a session starts.')}</p>
        <button className="btn btn-sm" onClick={() => setImporting(!importing)} data-testid="memory-import-open">
          {importing ? t('Close import') : t('Import…')}
        </button>
      </div>
      {importing ? <ImportList snapshot={snapshot} onClose={() => setImporting(false)} /> : null}

      <div className="seg ms-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'user'} className={tab === 'user' ? 'on' : ''} onClick={() => setTab('user')} data-testid="memory-tab-user">
          {t('User memory')} <span className="count-muted">{user.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'project'} className={tab === 'project' ? 'on' : ''} onClick={() => setTab('project')} data-testid="memory-tab-project">
          {t('Project memory')} <span className="count-muted">{projectNotes.length}</span>
        </button>
      </div>

      {tab === 'user' ? (
        <div className="ms-list">
          <div className="ms-hint muted small">{t('For every agent, in every project, on every machine.')}</div>
          {user.map((m) => (
            <NoteRow key={m.id} m={m} onError={setError} />
          ))}
          {adding ? (
            <NewNote onDone={() => setAdding(false)} onError={setError} />
          ) : (
            <button className="ms-add" onClick={() => setAdding(true)} data-testid="memory-add-global">
              <Icon name="plus" size={12} /> {t('New note')}
            </button>
          )}
        </div>
      ) : (
        <div className="ms-list">
          <div className="ms-hint muted small">{t('For the agents in one project. Notes come from “Keep as memory” in an agent’s conversation, or from Claude Code’s own project memory with Import….')}</div>
          {groups.length === 0 ? <div className="ms-empty muted small">{t('No project notes yet.')}</div> : null}
          {groups.map(({ p, notes }) => (
            <div key={p.projectId} className="ms-group" data-testid="memory-project">
              <div className="ms-group-head">
                <strong>{p.name}</strong>
                <span className="muted small mono truncate" title={`${p.host ? `${p.host}:` : ''}${p.rootPath}`}>
                  {where(p)}
                </span>
                <span className="count-muted">{notes.length}</span>
              </div>
              {notes.map((m) => (
                <NoteRow key={m.id} m={m} onError={setError} />
              ))}
            </div>
          ))}
        </div>
      )}
      {error ? <div className="error-text">{error}</div> : null}

      <div className="ms-share">
        <MemoryShare snapshot={snapshot} />
        <div className="memory-sync-status small" data-testid="memory-sync-status">
          <span className="muted">
            {sync.running
              ? t('Syncing…')
              : last
                ? t('Last synced {time} · {machines}', { time: timeAgo(last.at), machines: last.hosts.map(hostName).join(', ') || t('no machine') })
                : t('Not synced yet')}
            {last && !sync.running && (last.added || last.updated || last.removed) ? ` · ${t('{added} added, {updated} updated, {removed} retired', { added: last.added, updated: last.updated, removed: last.removed })}` : ''}
          </span>
          <button className="btn btn-sm" disabled={sync.running} onClick={() => void call('memory:syncNow', {}).catch((e) => setError(errorText(e)))} data-testid="memory-sync-now">
            <Icon name="refresh" size={12} /> {t('Sync now')}
          </button>
        </div>
        {last?.errors.length ? (
          <ul className="memory-errors small">
            {last.errors.map((e) => (
              <li key={e.host}>
                <strong>{hostName(e.host)}</strong>: {e.error}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<MemoryCandidate['source'], string> = { 'claude-memory': 'Claude Code memory', instructions: 'Instruction files' };

/** Target value: 'global', a projectId, or '' (nothing valid picked yet). */
function defaultTarget(c: MemoryCandidate): string {
  return c.suggestedScope === 'global' ? 'global' : (c.projectId ?? '');
}

function ImportList({ snapshot, onClose }: { snapshot: WorkspaceSnapshot; onClose: () => void }) {
  const [scan, setScan] = useState<Awaited<ReturnType<typeof call<'memory:scanImports'>>> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const rescan = async () => {
    setScanning(true);
    setError('');
    try {
      const r = await call('memory:scanImports', {});
      setScan(r);
      setTarget(Object.fromEntries(r.candidates.map((c) => [c.key, defaultTarget(c)])));
      setPicked(Object.fromEntries(r.candidates.map((c) => [c.key, !c.alreadyImported && !c.dismissed && !!defaultTarget(c)])));
    } catch (e) {
      setError(errorText(e));
    }
    setScanning(false);
  };
  useEffect(() => void rescan(), []);

  const chosen = scan?.candidates.filter((c) => picked[c.key] && target[c.key]) ?? [];
  const doImport = async () => {
    setError('');
    try {
      const n = await call('memory:import', { items: chosen.map((c) => (target[c.key] === 'global' ? { key: c.key, scope: 'global' as const } : { key: c.key, scope: 'project' as const, projectId: target[c.key] })) });
      setDone(t('Imported {n} note(s).', { n }));
      await rescan();
    } catch (e) {
      setError(errorText(e));
    }
  };

  // Machine → source → candidates, in scan order.
  const groups = new Map<string, Map<string, MemoryCandidate[]>>();
  for (const c of scan?.candidates ?? []) {
    const m = groups.get(c.host ?? 'local') ?? new Map<string, MemoryCandidate[]>();
    m.set(c.source, [...(m.get(c.source) ?? []), c]);
    groups.set(c.host ?? 'local', m);
  }
  const projectsOn = (host?: string) => snapshot.projects.filter((p) => (p.host ?? undefined) === host);

  return (
    <div className="memory-import" data-testid="memory-import">
      <div className="memory-import-head">
        <strong>{t('Import from Claude Code and Codex files')}</strong>
        <button className="btn btn-sm" disabled={scanning} onClick={() => void rescan()}>
          {scanning ? t('Scanning…') : t('Scan again')}
        </button>
      </div>
      <p className="muted small">{t('Copies notes into app memory; the files themselves are not changed. Each note is at most {n} characters.', { n: MAX_BODY })}</p>
      {scan?.errors.map((e) => (
        <div key={e.host} className="error-text small">
          {e.host === 'local' ? t('This Mac') : e.host}: {e.error}
        </div>
      ))}
      {scan && scan.candidates.length === 0 ? <div className="muted small">{t('No memory or instruction files found.')}</div> : null}
      {[...groups].map(([host, bySource]) => (
        <div key={host} className="memory-import-machine">
          <div className="section-label">
            <Icon name={host === 'local' ? 'folder' : 'globe'} size={12} /> {host === 'local' ? t('This Mac') : host}
          </div>
          {[...bySource].map(([source, list]) => (
            <div key={source} className="memory-import-source">
              <div className="muted small memory-import-source-title">{t(SOURCE_LABEL[source as MemoryCandidate['source']])}</div>
              {list.map((c) => {
                const tg = target[c.key] ?? '';
                const options = c.source === 'claude-memory' && c.suggestedScope === 'project' ? snapshot.projects.filter((p) => p.projectId === c.projectId) : projectsOn(c.host);
                return (
                  <div key={c.key} className={`memory-candidate${picked[c.key] && tg ? ' on' : ''}`} data-testid="memory-candidate" data-imported={c.alreadyImported ? '1' : '0'}>
                    <div className="memory-candidate-row">
                      <input type="checkbox" aria-label={c.title} checked={!!picked[c.key] && !!tg} disabled={!tg} onChange={(e) => setPicked({ ...picked, [c.key]: e.target.checked })} />
                      <button className="memory-candidate-title" onClick={() => setOpen(open === c.key ? null : c.key)} title={t('Show the text')}>
                        <Icon name="chevron" size={11} /> <strong>{c.title}</strong>
                        <span className="muted small mono"> {c.file}</span>
                      </button>
                      <select className="input select memory-target" value={tg} onChange={(e) => {
                        setTarget({ ...target, [c.key]: e.target.value });
                        if (e.target.value) setPicked({ ...picked, [c.key]: true });
                      }} aria-label={t('Import as')}>
                        {!tg ? <option value="">{t('Not importable')}</option> : null}
                        <option value="global">{t('User memory')}</option>
                        {options.map((p) => (
                          <option key={p.projectId} value={p.projectId}>
                            {t('Project · {name}', { name: p.name })}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="memory-candidate-tags">
                      {c.memoryType ? <span className="badge memory-badge">{c.memoryType}</span> : null}
                      {c.alreadyImported ? <span className="badge badge-ready memory-badge">{t('already imported')}</span> : null}
                      {c.dismissed ? <span className="badge memory-badge">{t('deleted in the app')}</span> : null}
                      {c.truncated ? <span className="badge badge-missing memory-badge">{t('cut to {n} characters', { n: MAX_BODY })}</span> : null}
                      {c.suggestedScope === 'project' && !c.projectId ? (
                        <span className="muted small">{t('No app project for this folder ({folder}). Add the project first, or import it as user memory.', { folder: c.folderHint ?? '' })}</span>
                      ) : null}
                    </div>
                    {open === c.key ? <pre className="memory-preview">{c.body}</pre> : <div className="memory-preview-line muted small">{c.body.replace(/\s+/g, ' ').slice(0, 160)}</div>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
      <div className="memory-import-foot">
        {done ? <span className="small">{done}</span> : null}
        {error ? <span className="error-text small">{error}</span> : null}
        <button className="btn" onClick={onClose}>
          {t('Close')}
        </button>
        <button className="btn btn-primary" disabled={!chosen.length} onClick={() => void doImport()} data-testid="memory-import-run">
          {t('Import {n} selected', { n: chosen.length })}
        </button>
      </div>
    </div>
  );
}
