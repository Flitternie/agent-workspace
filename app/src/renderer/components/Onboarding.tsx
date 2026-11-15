import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { NativeSessionInfo, ProviderCapabilities, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { timeAgo } from '../state';
import { Icon, PROVIDER_LABEL } from './bits';
import { CopyCommand, INSTALL_COMMAND, LANGUAGES, readiness, RemoteHosts } from './Settings';

type Provider = 'claude' | 'codex';
const DOCS: Record<Provider, string> = { claude: 'https://docs.claude.com/en/docs/claude-code/setup', codex: 'https://developers.openai.com/codex/cli' };

/**
 * First run, step by step, in the main area (skippable, nothing modal): connect a coding agent
 * (the only required step: sign-in happens from here), bring in the user's existing sessions on
 * this Mac, then on their SSH machines, and optionally set up voice. Steps tick themselves off.
 */
export function Onboarding({ snapshot, onSettings, now }: { snapshot: WorkspaceSnapshot; onSettings: () => void; now: number }) {
  const ob = snapshot.settings.onboarding ?? {};
  const save = (patch: Partial<NonNullable<typeof ob>>) => call('settings:update', { onboarding: { ...ob, ...patch } }).catch(() => {});
  const cap = (p: Provider) => snapshot.capabilities.find((c) => c.provider === p);
  const ready = (['claude', 'codex'] as const).filter((p) => readiness(cap(p)) === 'ready');
  const [signingIn, setSigningIn] = useState<Partial<Record<Provider, boolean>>>({});
  // This Mac's agents; another machine's count just as well (one of the two is enough).
  const local = ready.length > 0;
  const broughtIn = snapshot.projects.length > 0;

  // Machines connected and with an agent signed in: their sessions can be listed.
  const remoteReady = snapshot.remoteHosts.filter((h) => h.ssh === 'ok' && h.capabilities.some((c) => readiness(c) === 'ready')).map((h) => h.host);
  // Other machines come before bringing work in, so their sessions are picked with this Mac's.
  const remote = remoteReady.length > 0;
  const connected = local || remote;
  // Steps 1 and 2 are one requirement: an agent here or on another machine.
  const either = (mine: boolean) => (connected ? (mine ? undefined : t('Optional')) : t('This or the next step'));
  const voice = snapshot.voice.sttAvailable || !!ob.voiceSkipped;

  // Until an agent is ready here (or while signing in), look again every few seconds: installing or
  // signing in happens outside the app, and the step should tick itself off.
  const waiting = !local || Object.values(signingIn).some(Boolean);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void call('capabilities:refresh', {}).catch(() => {}), 3000);
    return () => clearInterval(id);
  }, [waiting]);

  return (
    <div className="onboarding" data-testid="onboarding">
      <div className="onboarding-inner">
        <h1>{t('Welcome to Agent Workspace')}</h1>
        <p className="muted">{t('A few steps to get going: connect a coding agent on this Mac or on another machine; the rest can wait.')}</p>

        <Step n={1} title="Language · 语言" done={!!ob.languageChosen} summary={LANGUAGES.find((l) => l.id === (snapshot.settings.language ?? 'en'))?.label}>
          <div className="segmented" role="radiogroup" aria-label="Language · 语言">
            {LANGUAGES.map((l) => {
              const on = (snapshot.settings.language ?? 'en') === l.id;
              return (
                <button
                  key={l.id}
                  role="radio"
                  aria-checked={on}
                  className={on ? 'on' : ''}
                  onClick={() => void call('settings:update', { language: l.id, onboarding: { ...ob, languageChosen: true } }).catch(() => {})}
                  data-testid={`onboarding-lang-${l.id}`}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
        </Step>

        <Step n={2} title={t('Connect a coding agent on this Mac')} done={local} summary={ready.map((p) => PROVIDER_LABEL[p]).join(' · ')} tag={either(local)}>
          <p className="muted small">{t('Agents run through Claude Code or Codex on this Mac, with the account you sign in with there. The app never sees your password or key.')}</p>
          <p className="muted small">{t('What agents do counts against that account’s plan (your Claude or ChatGPT subscription, or API usage).')}</p>
          {(['claude', 'codex'] as const).map((p) => (
            <ProviderRow key={p} provider={p} cap={cap(p)} signingIn={!!signingIn[p]} onSigningIn={(v) => setSigningIn((s) => ({ ...s, [p]: v }))} />
          ))}
          {ready.length === 2 ? <MainAgentChoice snapshot={snapshot} /> : null}
        </Step>

        <Step n={3} title={t('Connect other machines')} done={remote || (local && !!ob.remoteSkipped)} summary={remoteReady.length ? t('{n} machines', { n: remoteReady.length }) : t('Skipped')} tag={either(remote)}>
          <p className="muted small">{t('Agents can run on machines in your ~/.ssh/config, with Claude Code or Codex installed and signed in there; their sessions stay on those machines.')}</p>
          <RemoteHosts snapshot={snapshot} autoRecheck />
          {remoteReady.length || !local ? null : (
            <div className="row">
              <button className="btn btn-ghost" onClick={() => save({ remoteSkipped: true })} data-testid="onboarding-remote-skip">
                {t('Skip')}
              </button>
            </div>
          )}
        </Step>

        <Step n={4} title={t('Bring in your work')} done={broughtIn} summary={t('{n} projects', { n: snapshot.projects.length })} locked={!connected}>
          {local ? <BringIn snapshot={snapshot} now={now} /> : null}
          {remoteReady.map((host) => (
            <div key={host} className="ob-remote">
              <div className="ob-remote-head">
                <Icon name="terminal" size={12} /> <strong>{host}</strong>
              </div>
              <BringIn snapshot={snapshot} now={now} host={host} />
            </div>
          ))}
        </Step>

        <Step n={5} title={t('Voice (optional)')} done={voice} summary={snapshot.voice.sttAvailable ? t('Ready') : t('Skipped')} locked={!connected}>
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

function Step({ n, title, done, summary, tag, locked, children }: { n: number; title: string; done: boolean; summary?: string; tag?: string; locked?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!done);
  // A step that just got done folds; one that comes undone (signed out) opens again.
  useEffect(() => setOpen(!done), [done]);
  return (
    <section className={`ob-step${done ? ' done' : ''}${locked ? ' locked' : ''}`} data-testid={`onboarding-step-${n}`} data-done={done}>
      <button className="ob-step-head" onClick={() => !locked && setOpen((o) => !o)} disabled={locked} aria-expanded={open && !locked}>
        <span className="ob-step-mark">{done ? <Icon name="check" size={12} /> : n}</span>
        <span className="ob-step-title">{title}</span>
        {tag && !done ? <span className="ob-step-tag" data-testid={`onboarding-step-${n}-tag`}>{tag}</span> : null}
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
          <CopyCommand command={INSTALL_COMMAND[provider]} />
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
function BringIn({ snapshot, now, host }: { snapshot: WorkspaceSnapshot; now: number; host?: string }) {
  const [sessions, setSessions] = useState<NativeSessionInfo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [more, setMore] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    (host ? call('sessions:discoverHost', { host }) : call('sessions:discoverAll', {}))
      .then((list) => live && setSessions(list.filter((s) => !s.automated && (host ? s.host === host : !s.host))))
      .catch((e) => {
        if (!live) return;
        setSessions([]);
        setError(errorText(e));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);
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
        await call('task:importSession', { provider: s.provider as Provider, nativeSessionId: s.nativeSessionId, cwd: s.cwd, host: s.host, title: s.title.slice(0, 500) || s.nativeSessionId });
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
        <p className="muted small">{host ? t('Looking for sessions on {host}…', { host }) : t('Looking for your Claude Code and Codex sessions on this Mac…')}</p>
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
            {host ? null : (
              <button className="link small" onClick={() => void addFolder()}>
                {t('Or add a project folder')}
              </button>
            )}
          </div>
        </>
      ) : host ? (
        <p className="muted small">{t('No sessions found on {host}.', { host })}</p>
      ) : (
        <>
          <p className="muted small">{t('No sessions found yet. Add the folder of a project you work on:')}</p>
          <button className="btn btn-primary" onClick={() => void addFolder()} data-testid="onboarding-add-folder">
            <Icon name="folder" /> {t('Add a project folder')}
          </button>
        </>
      )}
      {!host && snapshot.projects.length ? (
        <p className="muted small">
          {t('Projects so far:')} {snapshot.projects.map((p) => p.name).join(', ')}
        </p>
      ) : null}
      {error ? <div className="error-text small">{error}</div> : null}
    </div>
  );
}
