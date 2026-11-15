import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { NativeSessionInfo, ProviderCapabilities, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { timeAgo } from '../state';
import { Icon, PROVIDER_LABEL } from './bits';
import { readiness } from './Settings';

type Provider = 'claude' | 'codex';
const INSTALL: Record<Provider, string> = { claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex' };
const DOCS: Record<Provider, string> = { claude: 'https://docs.claude.com/en/docs/claude-code/setup', codex: 'https://developers.openai.com/codex/cli' };

/**
 * First run, step by step, in the main area (skippable, nothing modal): connect a coding agent
 * (the only required step: sign-in happens from here), bring in the user's existing sessions,
 * hand over a first task, and optionally set up voice. Steps tick themselves off from the snapshot.
 */
export function Onboarding({ snapshot, onSettings, now }: { snapshot: WorkspaceSnapshot; onSettings: () => void; now: number }) {
  const ob = snapshot.settings.onboarding ?? {};
  const save = (patch: Partial<NonNullable<typeof ob>>) => call('settings:update', { onboarding: { ...ob, ...patch } }).catch(() => {});
  const cap = (p: Provider) => snapshot.capabilities.find((c) => c.provider === p);
  const ready = (['claude', 'codex'] as const).filter((p) => readiness(cap(p)) === 'ready');
  const [signingIn, setSigningIn] = useState<Partial<Record<Provider, boolean>>>({});
  const connected = ready.length > 0;
  const broughtIn = snapshot.projects.length > 0;
  const firstTask = !!ob.firstTaskDone;
  const voice = snapshot.voice.sttAvailable || !!ob.voiceSkipped;

  // Until one agent is ready (or while signing in), look again every few seconds: installing or
  // signing in happens outside the app, and the step should tick itself off.
  const waiting = !connected || Object.values(signingIn).some(Boolean);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void call('capabilities:refresh', {}).catch(() => {}), 3000);
    return () => clearInterval(id);
  }, [waiting]);

  return (
    <div className="onboarding" data-testid="onboarding">
      <div className="onboarding-inner">
        <h1>{t('Welcome to Agent Workspace')}</h1>
        <p className="muted">{t('A few steps to get going. Only the first one is needed; the rest can wait.')}</p>

        <Step n={1} title={t('Connect a coding agent')} done={connected} summary={ready.map((p) => PROVIDER_LABEL[p]).join(' · ')} required>
          <p className="muted small">{t('Agents run through Claude Code or Codex on this Mac, with the account you sign in with there. The app never sees your password or key.')}</p>
          <p className="muted small">{t('What agents do counts against that account’s plan (your Claude or ChatGPT subscription, or API usage).')}</p>
          {(['claude', 'codex'] as const).map((p) => (
            <ProviderRow key={p} provider={p} cap={cap(p)} signingIn={!!signingIn[p]} onSigningIn={(v) => setSigningIn((s) => ({ ...s, [p]: v }))} />
          ))}
          {ready.length === 2 ? <MainAgentChoice snapshot={snapshot} /> : null}
        </Step>

        <Step n={2} title={t('Bring in your work')} done={broughtIn} summary={t('{n} projects', { n: snapshot.projects.length })} locked={!connected}>
          <BringIn snapshot={snapshot} now={now} />
        </Step>

        <Step n={3} title={t('Give an agent its first task')} done={firstTask} summary={t('Started')} locked={!connected || !broughtIn}>
          <FirstTask snapshot={snapshot} ready={ready} onDone={() => save({ firstTaskDone: true })} />
        </Step>

        <Step n={4} title={t('Voice (optional)')} done={voice} summary={snapshot.voice.sttAvailable ? t('Ready') : t('Skipped')} locked={!connected}>
          <p className="muted small">{t('Talk to your agents like on a call: say a name ("Alice, …") and it goes to that agent. An on-device speech model needs no key.')}</p>
          <div className="row">
            <button className="btn" onClick={onSettings} data-testid="onboarding-voice-settings">
              {t('Set up voice')}
            </button>
            <button className="btn btn-ghost" onClick={() => save({ voiceSkipped: true })} data-testid="onboarding-voice-skip">
              {t('Skip')}
            </button>
          </div>
        </Step>

        <div className="onboarding-foot">
          <button className="btn btn-primary" disabled={!connected} onClick={() => save({ dismissed: true })} data-testid="onboarding-done">
            {t('Go to the workspace')}
          </button>
          <button className="link small" onClick={() => save({ dismissed: true })} data-testid="onboarding-skip">
            {t('Skip the guide')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, done, summary, required, locked, children }: { n: number; title: string; done: boolean; summary?: string; required?: boolean; locked?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!done);
  // A step that just got done folds; one that comes undone (signed out) opens again.
  useEffect(() => setOpen(!done), [done]);
  return (
    <section className={`ob-step${done ? ' done' : ''}${locked ? ' locked' : ''}`} data-testid={`onboarding-step-${n}`} data-done={done}>
      <button className="ob-step-head" onClick={() => !locked && setOpen((o) => !o)} disabled={locked} aria-expanded={open && !locked}>
        <span className="ob-step-mark">{done ? <Icon name="check" size={12} /> : n}</span>
        <span className="ob-step-title">{title}</span>
        {required && !done ? <span className="ob-step-tag">{t('Needed')}</span> : null}
        {done && summary ? <span className="ob-step-summary muted small">{summary}</span> : null}
      </button>
      {open && !locked ? <div className="ob-step-body">{children}</div> : null}
    </section>
  );
}

function ProviderRow({ provider, cap, signingIn, onSigningIn }: { provider: Provider; cap?: ProviderCapabilities; signingIn: boolean; onSigningIn: (v: boolean) => void }) {
  const state = readiness(cap);
  const [link, setLink] = useState<{ url?: string; code?: string }>({});
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [apps, setApps] = useState<{ claude: boolean; chatgpt: boolean }>({ claude: false, chatgpt: false });
  useEffect(() => void call('apps:detect', {}).then(setApps).catch(() => {}), []);
  useEffect(() => {
    if (state === 'ready' && signingIn) onSigningIn(false);
  }, [state, signingIn, onSigningIn]);
  const fromChatGpt = provider === 'codex' && /ChatGPT\.app/.test(cap?.detail ?? '');

  const login = (method?: 'claudeai' | 'console' | 'chatgpt' | 'device') => {
    setError('');
    setLink({});
    onSigningIn(true);
    call('provider:login', { provider, method })
      .then(setLink)
      .catch((e) => {
        onSigningIn(false);
        setError(errorText(e));
      });
  };
  const cancel = () => {
    onSigningIn(false);
    setLink({});
    void call('provider:loginCancel', { provider }).catch(() => {});
  };
  const sendKey = () => {
    if (!apiKey?.trim()) return;
    setError('');
    onSigningIn(true);
    call('provider:loginApiKey', { key: apiKey.trim() })
      .then((r) => {
        onSigningIn(false);
        if (r.ok) setApiKey(null);
        else setError(r.error ?? t('Codex refused the key.'));
      })
      .catch((e) => {
        onSigningIn(false);
        setError(errorText(e));
      });
  };

  return (
    <div className={`ob-provider state-${state}`} data-testid={`onboarding-${provider}`} data-state={state}>
      <div className="ob-provider-head">
        <strong>{PROVIDER_LABEL[provider]}</strong>
        <span className="ob-provider-state">
          {state === 'ready'
            ? t('Signed in · {method}', { method: cap?.auth?.method ?? t('ready') })
            : state === 'signed_out'
              ? t('Installed, not signed in')
              : state === 'missing'
                ? t('Not installed')
                : t('Checking…')}
          {fromChatGpt ? <span className="muted"> · {t('from the ChatGPT app')}</span> : null}
        </span>
      </div>
      {cap?.available ? (
        <div className="ob-found muted small" title={cap.detail}>
          {[cap.version, /→ (\S+)/.exec(cap.detail ?? '')?.[1]?.replace(/\.$/, '')].filter(Boolean).join(' · ')}
        </div>
      ) : null}

      {state === 'signed_out' && signingIn ? (
        <div className="ob-signing" data-testid={`onboarding-${provider}-signing`}>
          <span className="spinner" aria-hidden />
          <span>{t('Finish signing in in your browser; this updates by itself.')}</span>
          {link.code ? (
            <span>
              {t('Code:')} <code>{link.code}</code>
            </span>
          ) : null}
          {link.url ? (
            <a href={link.url} target="_blank" rel="noreferrer" className="link small" data-testid={`onboarding-${provider}-link`}>
              {t('Browser did not open? Open the sign-in page')}
            </a>
          ) : null}
          <button className="link small" onClick={cancel}>
            {t('Cancel')}
          </button>
        </div>
      ) : state === 'signed_out' ? (
        <div className="ob-actions">
          {provider === 'claude' ? (
            <>
              <button className="btn btn-primary" onClick={() => login('claudeai')} data-testid="onboarding-claude-login">
                {t('Sign in with your Claude subscription')}
              </button>
              <button className="link small" onClick={() => login('console')}>
                {t('Use an Anthropic Console account (billed by usage)')}
              </button>
            </>
          ) : apiKey === null ? (
            <>
              <button className="btn btn-primary" onClick={() => login('chatgpt')} data-testid="onboarding-codex-login">
                {t('Sign in with your ChatGPT account')}
              </button>
              <button className="link small" onClick={() => setApiKey('')} data-testid="onboarding-codex-apikey">
                {t('Use an OpenAI API key')}
              </button>
            </>
          ) : (
            <form
              className="ob-apikey"
              onSubmit={(e) => {
                e.preventDefault();
                sendKey();
              }}
            >
              <input className="input" type="password" autoFocus placeholder="sk-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} data-testid="onboarding-codex-key" />
              <button className="btn btn-primary" type="submit" disabled={!apiKey.trim()}>
                {t('Sign in')}
              </button>
              <button className="link small" type="button" onClick={() => setApiKey(null)}>
                {t('Cancel')}
              </button>
              <span className="muted small">{t('Handed to Codex to keep; this app does not store it.')}</span>
            </form>
          )}
          {provider === 'claude' && apps.claude ? <p className="muted small">{t('You have the Claude desktop app: the same Claude account signs in to Claude Code.')}</p> : null}
        </div>
      ) : state === 'missing' ? (
        <div className="ob-install">
          <span className="muted small">{t('Install it in a terminal; this updates by itself:')}</span>
          <div className="ob-command">
            <code>{INSTALL[provider]}</code>
            <button
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(INSTALL[provider]);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? t('Copied') : t('Copy')}
            </button>
          </div>
          <a className="link small" href={DOCS[provider]} target="_blank" rel="noreferrer">
            {t('Installation guide')}
          </a>
          {provider === 'claude' && apps.claude ? <p className="muted small">{t('The Claude desktop app is a different tool; Claude Code installs alongside it and uses the same account.')}</p> : null}
          {provider === 'codex' && apps.chatgpt ? <p className="muted small">{t('Updating the ChatGPT app may bring its built-in Codex, which works too.')}</p> : null}
        </div>
      ) : null}
      {error ? <div className="error-text small">{error}</div> : null}
    </div>
  );
}

function MainAgentChoice({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const current = snapshot.settings.mainAgent && snapshot.settings.mainAgent !== 'off' ? snapshot.settings.mainAgent : 'claude';
  return (
    <div className="ob-main-agent">
      <span className="muted small">{t('Your main agent (the one you talk to by default) runs on:')}</span>
      <div className="segmented">
        {(['claude', 'codex'] as const).map((p) => (
          <button key={p} className={current === p ? 'on' : ''} onClick={() => void call('settings:update', { mainAgent: p }).catch(() => {})}>
            {PROVIDER_LABEL[p]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The user's own recent sessions, by folder; they pick what to bring in (nothing preselected). */
function BringIn({ snapshot, now }: { snapshot: WorkspaceSnapshot; now: number }) {
  const [sessions, setSessions] = useState<NativeSessionInfo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [more, setMore] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    call('sessions:discoverAll', {})
      .then((list) => live && setSessions(list.filter((s) => !s.automated && !s.host)))
      .catch((e) => {
        if (!live) return;
        setSessions([]);
        setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, []);
  const folders = useMemo(() => {
    const by = new Map<string, NativeSessionInfo[]>();
    for (const s of sessions ?? []) by.set(s.cwd, [...(by.get(s.cwd) ?? []), s]);
    return [...by.entries()]
      .map(([cwd, list]) => ({ cwd, list: list.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')) }))
      .sort((a, b) => (b.list[0].updatedAt ?? '').localeCompare(a.list[0].updatedAt ?? ''))
      .slice(0, 8);
  }, [sessions]);
  const key = (s: NativeSessionInfo) => `${s.provider}:${s.nativeSessionId}`;
  const toggle = (s: NativeSessionInfo) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(key(s))) next.delete(key(s));
      else next.add(key(s));
      return next;
    });
  const bringIn = async () => {
    setError('');
    const chosen = (sessions ?? []).filter((s) => picked.has(key(s)));
    for (const [i, s] of chosen.entries()) {
      setBusy(t('Bringing in {i} of {n}…', { i: i + 1, n: chosen.length }));
      try {
        await call('task:importSession', { provider: s.provider as Provider, nativeSessionId: s.nativeSessionId, cwd: s.cwd, title: s.title.slice(0, 500) || s.nativeSessionId });
      } catch (e) {
        setError(errorText(e));
      }
    }
    setBusy('');
    setPicked(new Set());
  };
  const addFolder = async () => {
    setError('');
    try {
      const path = await call('project:pickDirectory', {});
      if (path) await call('project:add', { rootPath: path });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="ob-bring" data-testid="onboarding-bring">
      {sessions === null ? (
        <p className="muted small">{t('Looking for your Claude Code and Codex sessions on this Mac…')}</p>
      ) : folders.length ? (
        <>
          <p className="muted small">{t('Pick the conversations to continue here. Each folder becomes a project team; each conversation an agent, named by its work.')}</p>
          {folders.map((f) => {
            const shown = more.has(f.cwd) ? f.list : f.list.slice(0, 4);
            const all = f.list.every((s) => picked.has(key(s)));
            return (
              <div key={f.cwd} className="ob-folder" data-testid="onboarding-folder">
                <label className="ob-folder-head">
                  <input
                    type="checkbox"
                    checked={all}
                    onChange={() =>
                      setPicked((cur) => {
                        const next = new Set(cur);
                        for (const s of f.list) (all ? next.delete(key(s)) : next.add(key(s)));
                        return next;
                      })
                    }
                  />
                  <strong>{f.cwd.split('/').filter(Boolean).pop()}</strong>
                  <span className="muted small truncate">{f.cwd}</span>
                  <span className="muted small">{t('{n} conversations', { n: f.list.length })}</span>
                </label>
                {shown.map((s) => (
                  <label key={key(s)} className="ob-session" data-testid="onboarding-session">
                    <input type="checkbox" checked={picked.has(key(s))} onChange={() => toggle(s)} />
                    <span className="truncate">{s.title}</span>
                    <span className="ob-session-meta muted small">
                      {PROVIDER_LABEL[s.provider]} · {s.updatedAt ? timeAgo(s.updatedAt, now) : ''}
                    </span>
                  </label>
                ))}
                {f.list.length > shown.length ? (
                  <button className="link small ob-more" onClick={() => setMore((m) => new Set(m).add(f.cwd))}>
                    {t('{n} more', { n: f.list.length - shown.length })}
                  </button>
                ) : null}
              </div>
            );
          })}
          <div className="row">
            <button className="btn btn-primary" disabled={!picked.size || !!busy} onClick={() => void bringIn()} data-testid="onboarding-bring-in">
              {busy || t('Bring in {n} conversations', { n: picked.size })}
            </button>
            <button className="link small" onClick={() => void addFolder()}>
              {t('Or add a project folder')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">{t('No sessions found yet. Add the folder of a project you work on:')}</p>
          <button className="btn btn-primary" onClick={() => void addFolder()} data-testid="onboarding-add-folder">
            <Icon name="folder" /> {t('Add a project folder')}
          </button>
        </>
      )}
      {snapshot.projects.length ? (
        <p className="muted small">
          {t('Projects so far:')} {snapshot.projects.map((p) => p.name).join(', ')}
        </p>
      ) : null}
      {error ? <div className="error-text small">{error}</div> : null}
    </div>
  );
}

/** First tasks that work on any project and show what an agent does (suggested, as in Claude's own Code tab). */
const SUGGESTIONS = ['Explain how this project is organised', 'Find a TODO in the code and fix it', 'Add a test for an untested function', 'Write a CLAUDE.md for this project'];

function FirstTask({ snapshot, ready, onDone }: { snapshot: WorkspaceSnapshot; ready: Provider[]; onDone: () => void }) {
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState(snapshot.projects.at(-1)?.projectId ?? '');
  const [provider, setProvider] = useState<Provider>(ready[0] ?? 'claude');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!projectId && snapshot.projects.length) setProjectId(snapshot.projects.at(-1)!.projectId);
  }, [snapshot.projects, projectId]);
  const project = snapshot.projects.find((p) => p.projectId === projectId);
  const start = () => {
    if (!text.trim() || !project) return;
    setBusy(true);
    setError('');
    call('task:create', { projectId: project.projectId, provider, title: text.trim().split('\n')[0].slice(0, 80), instruction: text.trim(), isolate: project.isGitRepo })
      .then(() => onDone())
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="ob-first" data-testid="onboarding-first">
      <div className="ob-suggest">
        {SUGGESTIONS.map((x) => (
          <button key={x} className="chip" onClick={() => setText(t(x))} data-testid="onboarding-suggestion">
            {t(x)}
          </button>
        ))}
      </div>
      <textarea className="input" rows={3} placeholder={t('What should an agent do? e.g. “Find why the login page is slow and fix it.”')} value={text} onChange={(e) => setText(e.target.value)} data-testid="onboarding-first-text" />
      <div className="row">
        <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {snapshot.projects.map((p) => (
            <option key={p.projectId} value={p.projectId}>
              {p.name}
            </option>
          ))}
        </select>
        {ready.length > 1 ? (
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            {ready.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        ) : null}
        <button className="btn btn-primary" disabled={!text.trim() || !project || busy} onClick={start} data-testid="onboarding-first-start">
          {t('Hand it over')}
        </button>
        <button className="link small" onClick={onDone}>
          {t('Later')}
        </button>
      </div>
      <p className="muted small">
        {project?.isGitRepo
          ? t('It works in its own git worktree, so your checkout stays as it is. Permissions: Decide automatically (change in Settings).')
          : t('This folder is not a git repository, so the agent edits it directly. Permissions: Decide automatically (change in Settings).')}
      </p>
      {error ? <div className="error-text small">{error}</div> : null}
    </div>
  );
}
