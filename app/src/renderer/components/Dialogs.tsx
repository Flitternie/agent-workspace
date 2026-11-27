import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CODING_PROVIDERS, type AgentProvider, type CodingProvider, type ForkPoint, type NativeSessionInfo, type Task, type WorkspaceSnapshot } from '../../shared/types';
import { ACP_IDS, isAcpProvider } from '../../shared/acp-agents';
import { call, errorText } from '../api';
import { setDraftText } from '../drafts';
import { timeAgo } from '../state';
import { Icon, PROVIDER_LABEL, ProviderTag } from './bits';
import { ProviderPicker } from './ProviderPicker';
import { choiceControl } from '../choice-layout';
import { t } from '../i18n';
import { defaultProject, ProjectChooser } from './ProjectChooser';

/** Open dialogs, innermost last: Esc closes only the one on top (a confirmation over a dialog). */
const openModals: object[] = [];

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const me = {};
    openModals.push(me);
    // Esc closes the dialog and only the dialog: caught first, so the app's own Esc (back to Overview) never sees it.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openModals.at(-1) !== me) return;
      // A list open inside the dialog closes itself first.
      if ((e.target as Element | null)?.closest?.('[data-own-esc]')) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('keydown', esc, true);
      openModals.splice(openModals.indexOf(me), 1);
    };
  }, []);
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

/** The app's own "are you sure?" (not the system dialog): Enter confirms, Esc or Cancel backs out. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirm" data-testid="confirm-dialog">
        {message ? <p className="confirm-message">{message}</p> : null}
        <div className="modal-foot">
          <button className="btn" onClick={onClose} data-testid="confirm-cancel">
            {t('Cancel')}
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            autoFocus
            onClick={() => {
              onClose();
              onConfirm();
            }}
            data-testid="confirm-ok"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** `onContinue`: switch to Continue a session… instead, for someone who meant to pick up an existing conversation. */
export function NewTaskDialog({ snapshot, onClose, onCreated, onContinue }: { snapshot: WorkspaceSnapshot; onClose: () => void; onCreated: (taskId: string) => void; onContinue?: () => void }) {
  // The project used most recently (most of the time the right one); the chooser lists the rest.
  const [projectId, setProjectId] = useState(() => defaultProject(snapshot));
  const [provider, setProvider] = useState<AgentProvider>(() => (['claude', 'codex', ...ACP_IDS] as AgentProvider[]).find((p) => snapshot.capabilities.find((c) => c.provider === p)?.available) ?? 'claude');
  // No title, name or instruction here: the agent opens with its reply box focused, and its first message says what it is for.
  const [isolate, setIsolate] = useState(true);
  const [mockScript, setMockScript] = useState('ask:Should I keep backwards compatibility?');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const project = snapshot.projects.find((p) => p.projectId === projectId);
  const remote = project?.host ? snapshot.remoteHosts.find((h) => h.host === project.host) : undefined;
  // On a remote folder, what counts is the CLI installed on that machine.
  const capOf = (p: AgentProvider) => (project?.host ? remote?.capabilities.find((c) => c.provider === p) : snapshot.capabilities.find((c) => c.provider === p));
  const usable = (p: AgentProvider) => !!capOf(p)?.available && (!project?.host || remote?.ssh === 'ok');
  // Claude Code and Codex always; an ACP CLI (OpenCode, Antigravity…) once it is installed where the agent would run.
  const providers: AgentProvider[] = [...CODING_PROVIDERS.filter((p) => !isAcpProvider(p) || !!capOf(p)?.available), ...(snapshot.demo ? (['mock'] as const) : [])];
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
    <Modal title={t('New agent')} onClose={onClose}>
      {/* For people who meant to pick up a conversation they already have: first, before choosing anything. */}
      {onContinue ? (
        <div className="hint new-continue" data-testid="new-continue-hint">
          {t('Continuing an earlier conversation?')}{' '}
          <button className="link" onClick={onContinue} data-testid="new-continue-session">
            {t('Continue a session…')}
          </button>
        </div>
      ) : null}
      <ProjectChooser snapshot={snapshot} value={projectId} onChange={setProjectId} />
      <div className="field">
        <label>{t('Agent')}</label>
        <ProviderPicker
          providers={providers}
          value={provider}
          onChange={setProvider}
          capOf={capOf}
          usable={usable}
          note={(p) => (project?.host && remote?.ssh !== 'ok' ? t('not connected') : capOf(p)?.available ? t('unavailable') : t('not installed'))}
        />
        {project?.host && remote?.ssh !== 'ok' ? (
          <div className="warn-text small">{t('{host} is not connected. Check it in Settings › Remote machines.', { host: project.host })}</div>
        ) : cap && !(cap.available && cap.auth?.loggedIn !== false) ? (
          <div className="muted small">
            {cap.available && cap.auth?.loggedIn === false
              ? project?.host
                ? t('{name} on {host} is not signed in. Sign in there once, then recheck in Settings.', { name: PROVIDER_LABEL[cap.provider], host: project.host })
                : t('{name} is installed but not signed in. Open Settings for how to sign in.', { name: PROVIDER_LABEL[cap.provider] })
              : project?.host
                  ? t('{name} is not installed on {host}.', { name: PROVIDER_LABEL[cap.provider], host: project.host })
                  : t('{name} CLI not found on PATH.', { name: PROVIDER_LABEL[cap.provider] })}
          </div>
        ) : null}
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
            : null}
      </label>
      {error ? <div className="error-text">{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || !projectId} onClick={() => void create()} data-testid="create-agent">
          {busy ? t('Starting…') : t('Create agent')}
        </button>
      </div>
    </Modal>
  );
}

/** Recent sessions of the coding agents (Claude Code, Codex, the ACP CLIs) from any folder on this computer (or one SSH host), newest first. */
export function ImportDialog({ snapshot, onClose, onImported }: { snapshot: WorkspaceSnapshot; onClose: () => void; onImported: (taskId: string) => void }) {
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<'all' | CodingProvider>('all');
  // The CLIs installed here (Claude Code and Codex always offered, as before).
  const offered = CODING_PROVIDERS.filter((p) => !isAcpProvider(p) || snapshot.capabilities.find((c) => c.provider === p)?.available);
  const [importing, setImporting] = useState('');
  const [showAutomated, setShowAutomated] = useState(() => readPref(AUTOMATED_KEY) === '1');
  // Sources: this computer plus the machines turned on in Settings › Remote machines.
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
    call('task:importSession', { provider: s.provider as CodingProvider, nativeSessionId: s.nativeSessionId, cwd: s.cwd, host: s.host, title: s.title.slice(0, 500) || s.nativeSessionId })
      .then((t) => {
        onImported(t.taskId);
        onClose();
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setImporting(''));
  };

  return (
    <Modal title={t('Continue an existing session')} onClose={onClose}>
      <p className="muted small">{t('Continues a conversation from one of your coding agents here, with its history. Close it in the terminal first.')}</p>
      <div className="row">
        {hosts.length ? (
          <select className="input select" value={source} onChange={(e) => setSource(e.target.value)} title={t('Where the sessions are')} data-testid="session-host">
            <option value="all">{t('All machines')}</option>
            <option value={LOCAL}>{t('Local')}</option>
            {hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        ) : null}
        <input className="input grow" autoFocus placeholder={t('Search by title or folder')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="session-search" />
        {choiceControl(offered.length + 1) === 'grid' ? (
          <div className="segmented">
            {(['all', ...offered] as const).map((p) => (
              <button key={p} className={provider === p ? 'on' : ''} onClick={() => setProvider(p)}>
                {p === 'all' ? t('All') : PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
        ) : (
          <select className="input select" value={provider} onChange={(e) => setProvider(e.target.value as 'all' | CodingProvider)} title={t('Coding agent')} data-testid="session-provider">
            <option value="all">{t('All agents')}</option>
            {offered.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        )}
      </div>
      {automatedCount || showAutomated ? (
        <label className="check small muted" title={t('Started by an agent for itself: claude -p, codex exec, Codex sub-agents.')}>
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
        <div className="muted small">{pending.length === 1 && pending[0] === LOCAL ? t('Looking for sessions…') : t('Looking for sessions on {hosts}…', { hosts: pending.map((p) => (p === LOCAL ? t('Local') : p)).join(', ') })}</div>
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

/** Fork an agent's conversation, as it is now or from just before one of the user's earlier prompts. */
export function ForkDialog({ snapshot, task, onClose, onForked }: { snapshot: WorkspaceSnapshot; task: Task; onClose: () => void; onForked: (taskId: string) => void }) {
  const project = snapshot.projects.find((p) => p.projectId === task.projectId);
  const [points, setPoints] = useState<ForkPoint[] | null>(null);
  /** '' = the whole conversation as it is now. */
  const [upTo, setUpTo] = useState('');
  const [isolate, setIsolate] = useState(!!project?.isGitRepo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Which CLI continues it: its own, or another one installed here (given the conversation as text).
  const [onto, setOnto] = useState<AgentProvider>(task.provider);
  const capOf = (p: AgentProvider) => snapshot.capabilities.find((c) => c.provider === p);
  const usable = (p: AgentProvider) => (p === task.provider ? capOf(p)?.fork !== false : !!capOf(p)?.available);
  const ontoChoices: AgentProvider[] = capOf(task.provider)?.forkElsewhere
    ? [...new Set<AgentProvider>([...CODING_PROVIDERS.filter((p) => !isAcpProvider(p) || !!capOf(p)?.available), ...(snapshot.demo ? (['mock'] as const) : []), task.provider])]
    : [];
  useEffect(() => {
    call('task:forkPoints', { taskId: task.taskId })
      .then((p) => setPoints([...p].reverse()))
      .catch((e) => {
        setPoints([]);
        setError(errorText(e));
      });
  }, [task.taskId]);
  const pick = (id: string) => setUpTo(id);
  const fork = async () => {
    setBusy(true);
    setError('');
    try {
      const t = await call('task:fork', { taskId: task.taskId, upToMessageId: upTo || undefined, isolate: isolate && !!project?.isGitRepo, provider: onto !== task.provider ? onto : undefined });
      // Forked back to before a message: that message waits in the new agent's reply box, to edit and send.
      const prompt = upTo ? points?.find((p) => p.upToMessageId === upTo)?.prompt : undefined;
      if (prompt) setDraftText(t.taskId, prompt);
      onForked(t.taskId);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Fork {name}', { name: task.alias })} onClose={onClose}>
      <div className="muted small">{t('A new agent continues from a copy; {name} stays as it is.', { name: task.alias })}</div>
      {ontoChoices.length > 1 ? (
        <div className="field">
          <label>{t('Continue in')}</label>
          <ProviderPicker providers={ontoChoices} value={onto} onChange={setOnto} capOf={capOf} usable={usable} name="fork-onto" testId="fork-onto" />
        </div>
      ) : null}
      <div className="field">
        <label>{t('Fork from')}</label>
        <div className="fork-points" data-testid="fork-points">
          <label className={`radio${upTo === '' ? ' selected' : ''}`}>
            <input type="radio" name="fork-point" checked={upTo === ''} onChange={() => pick('')} /> {t('Now (the whole conversation)')}
          </label>
          {points === null ? <div className="muted small">{t('Loading…')}</div> : null}
          {points?.map((p) => (
            <label key={p.upToMessageId} className={`radio${upTo === p.upToMessageId ? ' selected' : ''}`} title={p.prompt}>
              <input type="radio" name="fork-point" checked={upTo === p.upToMessageId} onChange={() => pick(p.upToMessageId)} /> <span className="muted">{t('Before:')}</span>{' '}
              <span className="truncate">{p.prompt}</span>
            </label>
          ))}
        </div>
        <div className="muted small">{t('Only the conversation goes back; files stay as they are now.')}</div>
      </div>
      <label className="check">
        <input type="checkbox" checked={isolate && !!project?.isGitRepo} disabled={!project?.isGitRepo} onChange={(e) => setIsolate(e.target.checked)} data-testid="fork-isolate" />
        {t('Run in its own git worktree')}{' '}
        {project?.isGitRepo ? t('(with {name}’s files as they are now, uncommitted changes included)', { name: task.alias }) : t('(not a git repo — will share the folder)')}
      </label>
      {error ? <div className="error-text">{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || points === null} onClick={() => void fork()} data-testid="fork-confirm">
          {busy ? t('Forking…') : t('Fork')}
        </button>
      </div>
    </Modal>
  );
}
