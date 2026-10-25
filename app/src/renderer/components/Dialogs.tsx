import { useEffect, useState, type ReactNode } from 'react';
import type { AgentProvider, NativeSessionInfo, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { timeAgo } from '../state';
import { Icon, PROVIDER_LABEL, ProviderTag, shortVersion } from './bits';
import { t } from '../i18n';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label={t('Close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {/* Only the body scrolls, so the title stays put and the corners stay round. */}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ProjectPicker({ snapshot, value, onChange }: { snapshot: WorkspaceSnapshot; value: string; onChange: (id: string) => void }) {
  const [error, setError] = useState('');
  const add = async () => {
    setError('');
    try {
      const dir = await call('project:pickDirectory', {});
      if (!dir) return;
      const p = await call('project:add', { rootPath: dir });
      onChange(p.projectId);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="field">
      <label>{t('Project')}</label>
      <div className="row">
        <select className="input" value={value} onChange={(e) => onChange(e.target.value)} data-testid="project-select">
          <option value="">{t('Choose…')}</option>
          {snapshot.projects.map((p) => (
            <option key={p.projectId} value={p.projectId}>
              {p.name} — {p.rootPath}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void add()}>
          {t('Add folder…')}
        </button>
      </div>
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}

export function NewTaskDialog({ snapshot, onClose, onCreated }: { snapshot: WorkspaceSnapshot; onClose: () => void; onCreated: (taskId: string) => void }) {
  const providers = snapshot.demo ? (['claude', 'codex', 'mock'] as const) : (['claude', 'codex'] as const);
  const firstAvailable = providers.find((p) => snapshot.capabilities.find((c) => c.provider === p)?.available) ?? providers[0];
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.projectId ?? '');
  const [provider, setProvider] = useState<AgentProvider>(firstAvailable);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [isolate, setIsolate] = useState(true);
  const [mockScript, setMockScript] = useState('ask:Should I keep backwards compatibility?');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const project = snapshot.projects.find((p) => p.projectId === projectId);
  const cap = snapshot.capabilities.find((c) => c.provider === provider);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const t = await call('task:create', {
        projectId,
        provider,
        title: title.trim() || instruction.trim().slice(0, 80),
        name: name.trim() || undefined,
        instruction: instruction.trim() || undefined,
        isolate,
        mockScript: provider === 'mock' ? mockScript : undefined,
      });
      onCreated(t.taskId);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('New task')} onClose={onClose}>
      <ProjectPicker snapshot={snapshot} value={projectId} onChange={setProjectId} />
      <div className="field">
        <label>{t('Agent')}</label>
        <div className="row">
          {providers.map((p) => {
            const c = snapshot.capabilities.find((x) => x.provider === p);
            return (
              <label key={p} className={`radio${c?.available ? '' : ' disabled'}${provider === p ? ' selected' : ''}`} title={c?.detail}>
                <input type="radio" name="provider" checked={provider === p} disabled={!c?.available} onChange={() => setProvider(p)} /> {PROVIDER_LABEL[p]}
                {c?.version ? <span className="muted small"> {shortVersion(c.version)}</span> : null}
              </label>
            );
          })}
        </div>
        {cap ? (
          <div className="muted small">
            {cap.available && cap.auth?.loggedIn === false
              ? t('{name} is installed but not signed in. Open Settings for how to sign in.', { name: PROVIDER_LABEL[cap.provider] })
              : cap.available
                ? t('Uses your existing {name} login. Permissions follow the mode chosen in Settings.', { name: PROVIDER_LABEL[cap.provider] })
                : t('{name} CLI not found on PATH.', { name: PROVIDER_LABEL[cap.provider] })}
          </div>
        ) : null}
      </div>
      <div className="row">
        <div className="field grow">
          <label>{t('Role (optional)')}</label>
          <input className="input" placeholder={t('e.g. database')} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field grow2">
          <label>{t('Task title')}</label>
          <input className="input" placeholder={t('e.g. Schema migration for orders')} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>{t('First instruction (optional)')}</label>
        <textarea className="input" rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t('What should the agent do?')} />
      </div>
      {provider === 'mock' ? (
        <div className="field">
          <label>{t('Mock script')}</label>
          <input className="input" value={mockScript} onChange={(e) => setMockScript(e.target.value)} />
          <div className="muted small">ask:&lt;question&gt; · approval:&lt;command&gt; · choice:&lt;question&gt; · work</div>
        </div>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={isolate} disabled={!project?.isGitRepo} onChange={(e) => setIsolate(e.target.checked)} />
        {t('Run in its own git worktree')} {project && !project.isGitRepo ? t('(not a git repo — will share the folder)') : t('(isolates edits from other tasks; not a security sandbox)')}
      </label>
      {error ? <div className="error-text">{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || !projectId || !(title.trim() || instruction.trim())} onClick={() => void create()}>
          {busy ? t('Starting…') : t('Create task')}
        </button>
      </div>
    </Modal>
  );
}

/** Recent Claude Code / Codex sessions from any folder on this Mac, newest first. */
export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (taskId: string) => void }) {
  const [sessions, setSessions] = useState<NativeSessionInfo[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<'all' | 'claude' | 'codex'>('all');
  const [importing, setImporting] = useState('');
  const now = Date.now();

  useEffect(() => {
    call('sessions:discoverAll', {})
      .then(setSessions)
      .catch((e) => setError(errorText(e)));
  }, []);

  const q = query.trim().toLowerCase();
  const shown = (sessions ?? []).filter(
    (s) => (provider === 'all' || s.provider === provider) && (!q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)),
  );
  const add = (s: NativeSessionInfo) => {
    setImporting(s.nativeSessionId);
    setError('');
    call('task:importSession', { provider: s.provider as 'claude' | 'codex', nativeSessionId: s.nativeSessionId, cwd: s.cwd, title: s.title.slice(0, 500) || s.nativeSessionId })
      .then((t) => {
        onImported(t.taskId);
        onClose();
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setImporting(''));
  };

  return (
    <Modal title={t('Continue an existing session')} onClose={onClose}>
      <p className="muted small">
        {t(
          'Conversations you had with Claude Code or Codex on this Mac, in any folder. Importing continues that conversation here with its full history. It does not take over a session that is still open in a terminal — close that one first so the two do not edit at the same time.',
        )}
      </p>
      <div className="row">
        <input className="input grow" autoFocus placeholder={t('Search by title or folder')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="session-search" />
        <div className="segmented">
          {(['all', 'claude', 'codex'] as const).map((p) => (
            <button key={p} className={provider === p ? 'on' : ''} onClick={() => setProvider(p)}>
              {p === 'all' ? t('All') : PROVIDER_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      {!sessions && !error ? <div className="muted">{t('Looking for sessions…')}</div> : null}
      {error ? <div className="error-text">{error}</div> : null}
      {sessions && shown.length === 0 ? <div className="muted">{t('No sessions found.')}</div> : null}
      <div className="session-list" data-testid="session-list">
        {shown.map((s) => (
          <div key={s.nativeSessionId} className="session-row" data-testid="session-row">
            <div className="session-main">
              <div className="session-title">
                <ProviderTag provider={s.provider} /> <span className="truncate">{s.title}</span>
              </div>
              <div className="muted small mono session-meta">
                <span className="truncate" title={s.cwd}>
                  <Icon name="folder" size={12} /> {shortPath(s.cwd)}
                </span>
                {s.updatedAt ? <span>{timeAgo(s.updatedAt, now)}</span> : null}
                {s.updatedAt && now - Date.parse(s.updatedAt) < 10 * 60_000 ? (
                  <span className="warn-text" title={t('Active in the last few minutes. If it is still open in a terminal, close it before continuing here.')}>
                    {t('may still be open')}
                  </span>
                ) : null}
              </div>
            </div>
            <button className="btn" disabled={!!importing} onClick={() => add(s)}>
              {importing === s.nativeSessionId ? t('Importing…') : t('Import')}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** "/Users/me/projects/shop/api" → "…/shop/api". */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}
