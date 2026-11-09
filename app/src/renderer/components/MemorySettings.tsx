import { useEffect, useState } from 'react';
import type { MemoryCandidate, MemoryRecord, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { timeAgo } from '../state';
import { Icon } from './bits';

// Settings › Memory: user memory (scope `global`) and project memory, the automatic
// sync of user-level notes from the CLIs' native files, and a manual import list for
// everything else (project notes). Nothing here writes to the CLIs' own files.

const MAX_BODY = 4000; // keep in sync with main/memory-import MAX_BODY

/** "devbox · ~/AGENTS.md › style" for an import key (`source|host|file|section`). */
export function describeImportKey(key: string): string {
  const [, host, file, section] = key.split('|');
  if (!file) return key;
  return `${host && host !== 'local' ? `${host} · ` : `${t('This Mac')} · `}${file}${section && section !== 'all' ? ` › ${section}` : ''}`;
}

/** Where a record came from, for its meta line. */
export function memorySourceText(m: MemoryRecord): string {
  return m.importKeys?.length ? m.importKeys.map(describeImportKey).join(', ') : m.source;
}

function RecordRow({ m, onError }: { m: MemoryRecord; onError: (e: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.catch((e) => onError(errorText(e)));
  return (
    <div className="memory-record" data-testid="memory-setting-record" data-scope={m.scope}>
      {draft === null ? (
        <>
          {/* Instruction sections already start with their heading. */}
          {m.title && !m.body.startsWith(`#`) ? <div className="memory-title">{m.title}</div> : null}
          <div className="memory-body">{m.body}</div>
        </>
      ) : (
        <textarea className="input" rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
      )}
      <div className="memory-meta">
        {memorySourceText(m)}
        {m.sourceRemoved ? <span className="badge badge-missing memory-badge">{t('source removed')}</span> : null}
        {!m.approvedForReuse ? <span className="badge memory-badge">{t('not loaded (not approved)')}</span> : null}
      </div>
      <div className="memory-actions">
        {draft === null ? (
          <>
            <button className="link" onClick={() => setDraft(m.body)}>
              {t('Edit')}
            </button>
            {m.scope !== 'task' ? (
              <label className="small check">
                <input type="checkbox" checked={m.approvedForReuse} onChange={(e) => void run(call('memory:update', { id: m.id, approvedForReuse: e.target.checked }))} /> {t('approved for reuse')}
              </label>
            ) : null}
            <button className="link danger" onClick={() => void run(call('memory:delete', { id: m.id }))}>
              {t('Delete')}
            </button>
          </>
        ) : (
          <>
            <button className="link" disabled={!draft.trim()} onClick={() => void run(call('memory:update', { id: m.id, body: draft.trim() }).then(() => setDraft(null)))}>
              {t('Save')}
            </button>
            <button className="link" onClick={() => setDraft(null)}>
              {t('Cancel')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AddNote({ scope, scopeId, onError }: { scope: 'global' | 'project'; scopeId: string; onError: (e: string) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <div className="memory-add-row">
      <input className="input" placeholder={scope === 'global' ? t('Add a user note…') : t('Add a project note…')} value={draft} onChange={(e) => setDraft(e.target.value)} data-testid={`memory-add-${scope}`}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !draft.trim()) return;
          void call('memory:add', { scope, scopeId, body: draft.trim(), approvedForReuse: true }).then(() => setDraft(''), (err) => onError(errorText(err)));
        }}
      />
    </div>
  );
}

export function MemorySettings({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const sync = snapshot.memorySync;
  const on = snapshot.settings.memorySync !== false;
  const user = snapshot.memory.filter((m) => m.scope === 'global');
  const last = sync.last;
  const hostName = (h: string) => (h === 'local' ? t('This Mac') : h);

  return (
    <div className="memory-settings">
      <p className="muted small">
        {t('Notes the app gives to every agent it starts, with Claude Code or Codex, here or over SSH. They load when a session starts or resumes. The CLIs’ own memory files are only read, never changed.')}
      </p>

      <div className="settings-row" data-testid="memory-sync">
        <label className="check">
          <input type="checkbox" checked={on} onChange={(e) => void call('settings:update', { memorySync: e.target.checked }).catch((err) => setError(errorText(err)))} data-testid="memory-sync-toggle" />
          <span>
            <strong>{t('Keep user memory in sync')}</strong>
            <span className="muted small">
              {' '}
              — {t('imports user-level notes from Claude Code memory (user and feedback) and ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/AGENTS.md on this Mac and every connected SSH machine: at start, when a machine connects, and every 10 minutes. Your edits and deletions here are kept.')}
            </span>
          </span>
        </label>
        {on ? (
          <div className="memory-sync-status small" data-testid="memory-sync-status">
            <span className="muted">
              {sync.running
                ? t('Syncing…')
                : last
                  ? t('Last synced {time} · {machines}', { time: timeAgo(last.at), machines: last.hosts.map(hostName).join(', ') || t('no machine') })
                  : t('Not synced yet')}
            </span>
            {last && !sync.running ? (
              <span>{last.added || last.updated || last.removed ? t('{added} added, {updated} updated, {removed} source removed', { added: last.added, updated: last.updated, removed: last.removed }) : t('no changes')}</span>
            ) : null}
            <button className="btn btn-sm" disabled={sync.running} onClick={() => void call('memory:syncNow', {}).catch((e) => setError(errorText(e)))} data-testid="memory-sync-now">
              <Icon name="refresh" size={12} /> {t('Sync now')}
            </button>
          </div>
        ) : null}
        {on && last?.errors.length ? (
          <ul className="memory-errors small">
            {last.errors.map((e) => (
              <li key={e.host}>
                <strong>{hostName(e.host)}</strong>: {e.error}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="memory-settings-head">
        <h3>
          {t('User memory')} <span className="count-muted">{user.length}</span>
        </h3>
        <button className="btn btn-sm" onClick={() => setImporting(!importing)} data-testid="memory-import-open">
          {importing ? t('Close import') : t('Import…')}
        </button>
      </div>
      {importing ? <ImportList snapshot={snapshot} onClose={() => setImporting(false)} /> : null}
      <p className="muted small">{t('Applies to every agent the app starts, on every machine.')}</p>
      <AddNote scope="global" scopeId="global" onError={setError} />
      {user.map((m) => (
        <RecordRow key={m.id} m={m} onError={setError} />
      ))}

      <h3>{t('Project memory')}</h3>
      <p className="muted small">{t('Applies to every agent in that project. Import Claude Code project notes with Import….')}</p>
      {snapshot.projects.length === 0 ? <div className="muted small">{t('No projects yet.')}</div> : null}
      {snapshot.projects.map((p) => {
        const records = snapshot.memory.filter((m) => m.scope === 'project' && m.scopeId === p.projectId);
        return (
          <div key={p.projectId} className="memory-group" data-testid="memory-project">
            <div className="section-label">
              {p.name}
              <span className="muted small mono memory-project-path">
                {p.host ? `${p.host}:` : ''}
                {p.rootPath}
              </span>
              <span className="count-muted">{records.length}</span>
            </div>
            {records.map((m) => (
              <RecordRow key={m.id} m={m} onError={setError} />
            ))}
            <AddNote scope="project" scopeId={p.projectId} onError={setError} />
          </div>
        );
      })}
      {error ? <div className="error-text">{error}</div> : null}
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
