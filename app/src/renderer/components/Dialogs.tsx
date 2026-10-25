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
  // Machines turned on in Settings › Remote machines.
  const hosts = snapshot.remoteHosts.map((h) => h.host);
  /** Host whose folder is being entered; '' = none. */
  const [host, setHost] = useState('');
  const [path, setPath] = useState('');
  const [adding, setAdding] = useState(false);
  const addRemote = async () => {
    setError('');
    setAdding(true);
    try {
      const p = await call('project:add', { rootPath: path.trim(), host });
      onChange(p.projectId);
      setHost('');
      setPath('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAdding(false);
    }
  };
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
              {p.name} — {p.host ? `${p.host}:` : ''}
              {p.rootPath}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void add()}>
          {t('Add folder…')}
        </button>
        {hosts.length ? (
          <select className="input select" value="" onChange={(e) => setHost(e.target.value)} title={t('A folder on a machine turned on in Settings › Remote machines')} data-testid="ssh-host-select">
            <option value="">{t('Remote folder…')}</option>
            {hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {host ? (
        <div className="row">
          <span className="mono">{host}:</span>
          <input className="input grow mono" autoFocus placeholder="~/projects/repo" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path.trim() && void addRemote()} data-testid="remote-path" />
          <button className="btn" disabled={!path.trim() || adding} onClick={() => void addRemote()}>
            {adding ? t('Connecting…') : t('Add')}
          </button>
          <button className="icon-btn" aria-label={t('Cancel')} onClick={() => setHost('')}>
            <Icon name="x" />
          </button>
        </div>
      ) : null}
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
  const remote = project?.host ? snapshot.remoteHosts.find((h) => h.host === project.host) : undefined;
  // On a remote folder, what counts is the CLI installed on that machine.
  const capOf = (p: AgentProvider) => (project?.host ? remote?.capabilities.find((c) => c.provider === p) : snapshot.capabilities.find((c) => c.provider === p));
  const usable = (p: AgentProvider) => !!capOf(p)?.available && (!project?.host || remote?.ssh === 'ok');
  const cap = capOf(provider);
  useEffect(() => {
    if (!usable(provider)) {
      const next = providers.find(usable);
      if (next) setProvider(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, remote?.ssh]);

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
        isolate: isolate && !project?.host,
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
            const c = capOf(p);
            return (
              <label key={p} className={`radio${usable(p) ? '' : ' disabled'}${provider === p ? ' selected' : ''}`} title={c?.detail}>
                <input type="radio" name="provider" checked={provider === p} disabled={!usable(p)} onChange={() => setProvider(p)} /> {PROVIDER_LABEL[p]}
                {c?.version ? <span className="muted small"> {shortVersion(c.version)}</span> : null}
              </label>
            );
          })}
        </div>
        {project?.host && remote?.ssh !== 'ok' ? (
          <div className="warn-text small">{t('{host} is not connected. Check it in Settings › Remote machines.', { host: project.host })}</div>
        ) : project?.host && cap?.available && cap.auth?.loggedIn !== false ? (
          <div className="muted small">{t('Runs {name} on {host} over SSH, with the login there.', { name: PROVIDER_LABEL[cap.provider], host: project.host })}</div>
        ) : cap ? (
          <div className="muted small">
            {cap.available && cap.auth?.loggedIn === false
              ? project?.host
                ? t('{name} on {host} is not signed in. Sign in there once, then recheck in Settings.', { name: PROVIDER_LABEL[cap.provider], host: project.host })
                : t('{name} is installed but not signed in. Open Settings for how to sign in.', { name: PROVIDER_LABEL[cap.provider] })
              : cap.available
                ? t('Uses your existing {name} login. Permissions follow the mode chosen in Settings.', { name: PROVIDER_LABEL[cap.provider] })
                : project?.host
                  ? t('{name} is not installed on {host}.', { name: PROVIDER_LABEL[cap.provider], host: project.host })
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
        <input type="checkbox" checked={isolate && !project?.host} disabled={!project?.isGitRepo || !!project?.host} onChange={(e) => setIsolate(e.target.checked)} />
        {t('Run in its own git worktree')}{' '}
        {project?.host
          ? t('(not on SSH hosts yet — will share the folder)')
          : project && !project.isGitRepo
            ? t('(not a git repo — will share the folder)')
            : t('(isolates edits from other tasks; not a security sandbox)')}
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

/** Recent Claude Code / Codex sessions from any folder on this Mac (or one SSH host), newest first. */
export function ImportDialog({ snapshot, onClose, onImported }: { snapshot: WorkspaceSnapshot; onClose: () => void; onImported: (taskId: string) => void }) {
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<'all' | 'claude' | 'codex'>('all');
  const [importing, setImporting] = useState('');
  const [showAutomated, setShowAutomated] = useState(() => readPref(AUTOMATED_KEY) === '1');
  // Sources: this Mac plus the machines turned on in Settings › Remote machines.
  const hosts = snapshot.remoteHosts.map((h) => h.host);
  const [source, setSource] = useState<string>(() => {
    const saved = readSource();
    return saved === 'all' || saved === LOCAL || hosts.includes(saved) ? saved : LOCAL;
  });
  /** Per source: its sessions once loaded, or why it failed. */
  const [loaded, setLoaded] = useState<Record<string, NativeSessionInfo[] | { error: string }>>({});
  const now = Date.now();
  const wanted = source === 'all' ? [LOCAL, ...hosts] : [source];

  useEffect(() => {
    writeSource(source);
    let current = true;
    for (const src of wanted) {
      if (loaded[src]) continue;
      (src === LOCAL ? call('sessions:discoverAll', {}) : call('sessions:discoverHost', { host: src }))
        .then((list) => current && setLoaded((l) => ({ ...l, [src]: list })))
        .catch((e) => current && setLoaded((l) => ({ ...l, [src]: { error: errorText(e) } })));
    }
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const lists = wanted.map((src) => loaded[src]);
  const sessions = lists.flatMap((l) => (Array.isArray(l) ? l : [])).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  const pending = wanted.filter((src) => !loaded[src]);
  const failed = wanted.flatMap((src) => {
    const l = loaded[src];
    return l && !Array.isArray(l) ? [{ src, error: l.error }] : [];
  });
  const q = query.trim().toLowerCase();
  const matching = sessions.filter(
    (s) => (provider === 'all' || s.provider === provider) && (!q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || !!s.host?.toLowerCase().includes(q)),
  );
  // Sessions an agent started inside another task (sub-agents) are rarely ones to continue.
  const automatedCount = matching.filter((s) => s.automated).length;
  const shown = showAutomated ? matching : matching.filter((s) => !s.automated);
  const add = (s: NativeSessionInfo) => {
    setImporting(s.nativeSessionId);
    setError('');
    call('task:importSession', { provider: s.provider as 'claude' | 'codex', nativeSessionId: s.nativeSessionId, cwd: s.cwd, host: s.host, title: s.title.slice(0, 500) || s.nativeSessionId })
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
        {hosts.length ? ` ${t('Sessions on a remote machine (including ones the Claude and ChatGPT apps started there over SSH) continue on that machine.')}` : ''}
      </p>
      <div className="row">
        {hosts.length ? (
          <select className="input select" value={source} onChange={(e) => setSource(e.target.value)} title={t('Where the sessions are')} data-testid="session-host">
            <option value="all">{t('All machines')}</option>
            <option value={LOCAL}>{t('This Mac')}</option>
            {hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        ) : null}
        <input className="input grow" autoFocus placeholder={t('Search by title or folder')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="session-search" />
        <div className="segmented">
          {(['all', 'claude', 'codex'] as const).map((p) => (
            <button key={p} className={provider === p ? 'on' : ''} onClick={() => setProvider(p)}>
              {p === 'all' ? t('All') : PROVIDER_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      {automatedCount || showAutomated ? (
        <label className="check small muted" title={t('Sessions an agent started for itself while working on a task: claude -p and codex exec runs, and Codex sub-agent threads. Sessions you or an app started (terminal, IDE, desktop apps, this app) are always listed.')}>
          <input
            type="checkbox"
            checked={showAutomated}
            onChange={(e) => {
              setShowAutomated(e.target.checked);
              writePref(AUTOMATED_KEY, e.target.checked ? '1' : '0');
            }}
            data-testid="session-automated"
          />
          {t('Also show sub-agent sessions ({n})', { n: automatedCount })}
        </label>
      ) : null}
      {pending.length ? (
        <div className="muted small">{pending.length === 1 && pending[0] === LOCAL ? t('Looking for sessions…') : t('Looking for sessions on {hosts}…', { hosts: pending.map((p) => (p === LOCAL ? t('this Mac') : p)).join(', ') })}</div>
      ) : null}
      {failed.map((f) => (
        <div key={f.src} className="warn-text small">
          {f.src === LOCAL ? f.error : t('{host}: {error}', { host: f.src, error: f.error })}
        </div>
      ))}
      {error ? <div className="error-text">{error}</div> : null}
      {!pending.length && shown.length === 0 ? <div className="muted">{automatedCount ? t('Only sub-agent sessions match.') : t('No sessions found.')}</div> : null}
      <div className="session-list" data-testid="session-list">
        {shown.map((s) => (
          <div key={s.nativeSessionId} className="session-row" data-testid="session-row">
            <div className="session-main">
              <div className="session-title">
                <ProviderTag provider={s.provider} /> <span className="truncate">{s.title}</span>
                {s.automated ? (
                  <span className="badge session-auto" title={t('Started by an agent inside another task')}>
                    {t('sub-agent')}
                  </span>
                ) : null}
              </div>
              <div className="muted small mono session-meta">
                <span className="truncate" title={s.host ? `${s.host}:${s.cwd}` : s.cwd}>
                  <Icon name="folder" size={12} /> {s.host ? `${s.host}:` : ''}
                  {shortPath(s.cwd)}
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

const LOCAL = 'local';
const SOURCE_KEY = 'amw.importSource';
const AUTOMATED_KEY = 'amw.importAutomated';

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a convenience only */
  }
}

const readSource = () => readPref(SOURCE_KEY) ?? LOCAL;
const writeSource = (source: string) => writePref(SOURCE_KEY, source);

/** "/Users/me/projects/shop/api" → "…/shop/api". */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}
