import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { Language, MicMode, PermissionMode, ProviderCapabilities, RemoteHostStatus, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { SkillsSettings } from './SkillsSettings';
import { defaultShortcut, MODIFIERS, recording, shortcutFrom, shortcutKeys } from '../voice/shortcut';
import { Icon, Kbd, PROVIDER_LABEL, shortVersion } from './bits';
import { ConfirmDialog } from './Dialogs';
import { INSTALL_SCRIPT } from '../../shared/install';
import { MemorySettings } from './MemorySettings';

export const LANGUAGES: Array<{ id: Language; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
];

const SIGN_IN: Record<string, string> = { claude: 'claude  →  /login', codex: 'codex login' };
/** On a machine without a browser: Claude prints a link to open here; Codex signs in with a device code. */
const REMOTE_SIGN_IN: Record<string, string> = { claude: 'claude auth login', codex: 'codex login --device-auth' };
/** How to install each CLI (also shown in the first-run guide): the official installers, no Node.js needed. */
export const INSTALL_COMMAND: Record<'claude' | 'codex', string> = INSTALL_SCRIPT;

/**
 * Getting an agent going on an SSH host, from the app: install it there (after showing the exact
 * command) and sign in without a browser on that machine. Codex shows its device code here; Claude
 * Code gives a link whose page shows a code to paste back. The terminal stays as a fallback.
 */
function HostAgentSetup({ host, provider, state }: { host: string; provider: 'claude' | 'codex'; state: 'missing' | 'signed_out' }) {
  type Phase = 'idle' | 'confirm' | 'installing' | 'signing' | 'sent';
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [link, setLink] = useState<{ url?: string; code?: string }>({});
  const [paste, setPaste] = useState('');
  const [manual, setManual] = useState(false);
  const name = PROVIDER_LABEL[provider];
  const install = () => {
    setPhase('installing');
    setError('');
    call('ssh:install', { host, provider })
      .then((r) => {
        setPhase('idle');
        if (!r.ok) setError(r.error ?? t('The installer failed.'));
      })
      .catch((e) => {
        setPhase('idle');
        setError(errorText(e));
      });
  };
  const signIn = () => {
    setError('');
    setLink({});
    setPhase('signing');
    call('ssh:login', { host, provider })
      .then((l) => {
        setLink(l);
        if (!l.url) setError(t('{host} did not give a sign-in link. Try in its terminal:', { host }));
      })
      .catch((e) => {
        setPhase('idle');
        setError(errorText(e));
      });
  };
  const cancel = () => {
    setPhase('idle');
    setLink({});
    void call('ssh:loginCancel', { host, provider }).catch(() => {});
  };
  const sendCode = () => {
    if (!paste.trim()) return;
    call('ssh:loginCode', { host, provider, code: paste.trim() })
      .then(() => setPhase('sent'))
      .catch((e) => setError(errorText(e)));
  };
  return (
    <div className="host-setup" data-testid={state === 'missing' ? 'host-install' : 'host-signin'} data-provider={provider} data-phase={phase}>
      {state === 'missing' ? (
        phase === 'installing' ? (
          <span className="host-setup-line">
            <span className="spinner" aria-hidden /> {t('Installing {provider} on {host}… (usually a minute or two)', { provider: name, host })}
          </span>
        ) : phase === 'confirm' ? (
          <div className="host-setup-confirm">
            <span>{t('This runs on {host} (installs to ~/.local/bin, no sudo):', { host })}</span>
            <CopyCommand command={INSTALL_COMMAND[provider]} />
            <span className="row">
              <button className="btn btn-sm btn-primary" onClick={install} data-testid="host-install-confirm">
                {t('Install')}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setPhase('idle')}>
                {t('Cancel')}
              </button>
            </span>
          </div>
        ) : (
          <span className="host-setup-line">
            {t('{provider} is not on {host} yet.', { provider: name, host })}
            <button className="btn btn-sm btn-primary" onClick={() => setPhase('confirm')} data-testid="host-install-start">
              {t('Install on {host}', { host })}
            </button>
            <button className="link small" onClick={() => setManual((m) => !m)}>
              {t('Install it myself')}
            </button>
          </span>
        )
      ) : phase === 'signing' || phase === 'sent' ? (
        <div className="host-setup-confirm" data-testid="host-signing">
          {provider === 'codex' && link.code ? (
            <>
              <span>{t('Open the link on this computer and enter the code:')}</span>
              <code className="device-code" data-testid="host-device-code">
                {link.code}
              </code>
            </>
          ) : null}
          {link.url ? (
            <a className="link small" href={link.url} target="_blank" rel="noreferrer" data-testid="host-signin-link">
              {t('Open the sign-in page')}
            </a>
          ) : !error ? (
            <span className="host-setup-line">
              <span className="spinner" aria-hidden /> {t('Starting the sign-in on {host}…', { host })}
            </span>
          ) : null}
          {provider === 'claude' && link.url ? (
            phase === 'sent' ? (
              <span className="muted small">{t('Code sent; this updates once {host} confirms.', { host })}</span>
            ) : (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendCode();
                }}
              >
                <input className="input" placeholder={t('Paste the code the page shows')} value={paste} onChange={(e) => setPaste(e.target.value)} data-testid="host-signin-code" />
                <button className="btn btn-sm btn-primary" type="submit" disabled={!paste.trim()}>
                  {t('Send')}
                </button>
              </form>
            )
          ) : null}
          {provider === 'codex' ? <span className="muted small">{t('If it says device-code sign-in is off, turn it on in ChatGPT settings → Security.')}</span> : null}
          <button className="link small" onClick={cancel}>
            {t('Cancel')}
          </button>
        </div>
      ) : (
        <span className="host-setup-line">
          {t('{provider} on {host} is not signed in.', { provider: name, host })}
          <button className="btn btn-sm btn-primary" onClick={signIn} data-testid="host-signin-start">
            {t('Sign in')}
          </button>
          <button className="link small" onClick={() => setManual((m) => !m)}>
            {t('Sign in myself')}
          </button>
        </span>
      )}
      {manual || error ? (
        <div className="muted small host-hint">
          {t('In a terminal on {host} (“Open in Terminal”):', { host })} <CopyCommand command={state === 'missing' ? INSTALL_COMMAND[provider] : REMOTE_SIGN_IN[provider]} />
        </div>
      ) : null}
      {error ? <div className="error-text small">{error}</div> : null}
    </div>
  );
}

/** A command with a copy button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-command">
      <code>{command}</code>
      <button
        className="btn btn-sm"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? t('Copied') : t('Copy')}
      </button>
    </span>
  );
}

type Readiness = 'ready' | 'signed_out' | 'missing' | 'checking';

export function readiness(c: ProviderCapabilities | undefined): Readiness {
  if (!c) return 'checking';
  if (!c.available) return 'missing';
  return c.auth?.loggedIn === false ? 'signed_out' : 'ready';
}

export function ReadinessBadge({ state, method, missing = 'Not installed' }: { state: Readiness; method?: string; missing?: string }) {
  const text =
    state === 'ready'
      ? method
        ? t('Signed in · {method}', { method })
        : t('Ready')
      : state === 'signed_out'
        ? t('Not signed in')
        : state === 'missing'
          ? t(missing)
          : t('Checking…');
  return (
    <span className={`badge badge-${state}`} data-testid="readiness" data-state={state}>
      {state === 'ready' ? <Icon name="check" size={12} /> : state === 'checking' ? null : <Icon name="alert" size={12} />}
      {text}
    </span>
  );
}

export const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; detail: string }> = [
  {
    id: 'auto',
    label: 'Decide automatically',
    detail: 'Routine actions go through; only risky ones ask you.',
  },
  { id: 'edits', label: 'Allow file edits', detail: 'Edits inside the workspace go ahead; commands and anything else ask you first.' },
  { id: 'ask', label: 'Ask every time', detail: 'Every action that changes something waits for your approval.' },
];

export function PermissionChoice({ value, onChange }: { value: PermissionMode; onChange: (m: PermissionMode) => void }) {
  return (
    <div className="choice-list" role="radiogroup" aria-label={t('Permissions')}>
      {PERMISSION_MODES.map((m) => (
        <label key={m.id} className={`choice${value === m.id ? ' on' : ''}`} data-testid={`perm-${m.id}`}>
          <input type="radio" name="perm" checked={value === m.id} onChange={() => onChange(m.id)} />
          <span>
            <strong>{t(m.label)}</strong>
            <span className="muted small">{t(m.detail)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

// Two separate models: one turns speech into text, the other decides which agent a
// sentence is for (and names agent roles when no Claude Code or Codex is signed in). Nothing
// rewrites what you said.
// Both are picked from scrollable card lists with 1–5 dot ratings (as in VoiceInk),
// so more models can be added without the picker getting harder to read.

interface ModelOption {
  id: string;
  label: string;
  note: string;
  accuracy?: number;
  speed?: number;
  detail?: string;
}

// Ratings come from this app's own tests (mixed Chinese/English clips, routing cases).
const CLOUD_STT: ModelOption[] = [
  { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe', note: 'Most accurate; best with mixed Chinese and English', accuracy: 5, speed: 3 },
  { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe', note: 'Faster and cheaper, slightly less accurate', accuracy: 4, speed: 4 },
  { id: 'whisper-1', label: 'whisper-1', note: 'Older Whisper model', accuracy: 3, speed: 3 },
];
const ROUTERS: ModelOption[] = [
  { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini', note: 'Recommended: accurate, about 1 s', accuracy: 5, speed: 4 },
  { id: 'gpt-5.4-nano', label: 'gpt-5.4-nano', note: 'Fastest, about 0.8 s; occasionally misroutes', accuracy: 3, speed: 5 },
  { id: 'gpt-5.5', label: 'gpt-5.5', note: 'Most capable, slower', accuracy: 5, speed: 2 },
  { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini', note: 'Previous default', accuracy: 3, speed: 4 },
];
const OTHER_STT = /^(gpt-[\w.-]*transcribe|whisper-\d)$/;
const OTHER_ROUTER = /^(gpt-(4\.1|4o|5)[\w.-]*|o\d(-mini)?)$/;
// gpt-4.1-nano is still listed by the API but deprecated for chat.
const NOT_ROUTER = /audio|realtime|search|transcribe|tts|image|codex|pro|chat-latest|diarize|\d{4}-\d\d-\d\d|^gpt-4\.1-nano$/;

/** "●●●●○": a rating out of five. */
function Dots({ label, value }: { label: string; value?: number }) {
  if (!value) return null;
  return (
    <span className="dots" title={`${label} ${value}/5`} aria-label={`${label} ${value}/5`}>
      <span className="dots-label">{label}</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? 'dot on' : 'dot'} />
      ))}
    </span>
  );
}

/** One selectable model: name, tags, ratings, a short note, and optional actions (download…). */
function ModelCard({ m, selected, disabled, tags, actions, onSelect, testId, children }: { m: ModelOption; selected: boolean; disabled?: boolean; tags?: ReactNode; actions?: ReactNode; onSelect?: () => void; testId: string; children?: ReactNode }) {
  return (
    <div
      className={`model-card${selected ? ' on' : ''}${disabled ? ' disabled' : ''}${onSelect && !disabled ? ' clickable' : ''}`}
      role="radio"
      aria-checked={selected}
      tabIndex={onSelect && !disabled ? 0 : -1}
      data-testid={testId}
      onClick={() => !disabled && onSelect?.()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !disabled && onSelect?.()}
    >
      <span className="model-radio" aria-hidden />
      <div className="model-card-main">
        <div className="model-card-title">
          <strong>{m.label}</strong>
          {tags}
        </div>
        {m.accuracy || m.speed ? (
          <div className="model-ratings">
            <Dots label={t('Accuracy')} value={m.accuracy} />
            <Dots label={t('Speed')} value={m.speed} />
          </div>
        ) : null}
        <div className="muted small">
          {m.detail ? `${m.detail} · ` : ''}
          {t(m.note)}
        </div>
        {children}
      </div>
      {actions ? (
        <div className="model-card-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** Models this key can use (cached per page view). */
function useOpenAiModels(enabled: boolean): string[] | null {
  const [available, setAvailable] = useState<string[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    call('models:list', {})
      .then(setAvailable)
      .catch(() => setAvailable(null));
  }, [enabled]);
  return available;
}

function ModelPickers({ snapshot, onChange }: { snapshot: WorkspaceSnapshot; onChange: (p: { sttModel?: string; routerModel?: string }) => void }) {
  const v = snapshot.voice;
  const available = useOpenAiModels(v.cloudAvailable);
  const [moreStt, setMoreStt] = useState(false);
  const [moreRouter, setMoreRouter] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; label: string } | null>(null);
  const current = v.sttModel ?? '';
  const inUseLocal = /^local:(.+)$/.exec(current)?.[1];
  // Only offer what this key can use, once we know.
  const usable = (list: ModelOption[]) => (available ? list.filter((c) => available.includes(c.id)) : list);
  const extra = (re: RegExp, known: ModelOption[], not?: RegExp) =>
    (available ?? []).filter((id) => re.test(id) && !(not && not.test(id)) && !known.some((k) => k.id === id) && !/\d{4}-\d\d-\d\d|diarize/.test(id));

  return (
    <div className="model-picks">
      {deleting ? (
        <ConfirmDialog
          title={t('Delete {name} from this computer?', { name: deleting.label })}
          confirmLabel={t('Delete')}
          danger
          onConfirm={() => void call('stt:delete', { id: deleting.id })}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      <div className="model-pick-head">
        <span>
          <strong>{t('Speech recognition model')}</strong>
          <span className="muted small">{t('Turns what you say into text.')}</span>
        </span>
      </div>
      <div className="model-list" role="radiogroup" aria-label={t('Speech recognition model')} data-testid="stt-list">
        <div className="model-group">{t('On this computer')} · <span className="muted">{t('audio never leaves the computer')}</span></div>
        {v.localModels.map((m, i) => (
          <ModelCard
            key={m.id}
            m={{ id: m.id, label: m.label, note: m.note, accuracy: m.accuracy, speed: m.speed, detail: `${t(m.languages)} · ${m.sizeMb} MB` }}
            selected={inUseLocal === m.id}
            disabled={!m.installed}
            onSelect={() => onChange({ sttModel: `local:${m.id}` })}
            testId={`local-model-${m.id}`}
            tags={i === 0 ? <span className="tag">{t('Recommended')}</span> : null}
            actions={
              m.progress !== undefined ? (
                <>
                  <span className="muted small">{Math.round(m.progress * 100)}%</span>
                  <button className="btn btn-sm" onClick={() => void call('stt:cancel', { id: m.id })}>
                    {t('Cancel')}
                  </button>
                </>
              ) : m.installed ? (
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setDeleting({ id: m.id, label: m.label });
                  }}
                >
                  {t('Delete')}
                </button>
              ) : (
                <button className="btn btn-sm" onClick={() => void call('stt:download', { id: m.id })} data-testid={`download-${m.id}`}>
                  {t('Download')}
                </button>
              )
            }
          >
            {m.progress !== undefined ? (
              <div className="progress" aria-label={t('Downloading')}>
                <span style={{ width: `${Math.round(m.progress * 100)}%` }} />
              </div>
            ) : null}
            {m.error ? <div className="error-text small">{m.error}</div> : null}
          </ModelCard>
        ))}
        <div className="model-group">{t('Cloud')} · <span className="muted">OpenAI</span></div>
        {v.cloudAvailable ? (
          <>
            {usable(CLOUD_STT).map((m) => (
              <ModelCard key={m.id} m={m} selected={current === m.id} onSelect={() => onChange({ sttModel: m.id })} testId={`stt-${m.id}`} />
            ))}
            {moreStt
              ? extra(OTHER_STT, CLOUD_STT).map((id) => (
                  <ModelCard key={id} m={{ id, label: id, note: 'Not rated' }} selected={current === id} onSelect={() => onChange({ sttModel: id })} testId={`stt-${id}`} />
                ))
              : extra(OTHER_STT, CLOUD_STT).length ? (
                  <button className="link small model-more" onClick={() => setMoreStt(true)}>
                    {t('Show {n} more models on your key', { n: extra(OTHER_STT, CLOUD_STT).length })}
                  </button>
                ) : null}
          </>
        ) : (
          <div className="muted small model-empty">{t('No OpenAI key found. Put it in openai.key next to the app or set OPENAI_API_KEY, then restart.')}</div>
        )}
      </div>

      <div className="model-pick-head">
        <span>
          <strong>{t('Routing model')}</strong>
          <span className="muted small">{t('Picks the agent when you do not name one.')}</span>
        </span>
      </div>
      {v.cloudAvailable ? (
        <div className="model-list short" role="radiogroup" aria-label={t('Routing model')} data-testid="router-list">
          {usable(ROUTERS).map((m) => (
            <ModelCard key={m.id} m={m} selected={v.routerModel === m.id} onSelect={() => onChange({ routerModel: m.id })} testId={`router-${m.id}`} />
          ))}
          {moreRouter
            ? extra(OTHER_ROUTER, ROUTERS, NOT_ROUTER).map((id) => (
                <ModelCard key={id} m={{ id, label: id, note: 'Not rated' }} selected={v.routerModel === id} onSelect={() => onChange({ routerModel: id })} testId={`router-${id}`} />
              ))
            : extra(OTHER_ROUTER, ROUTERS, NOT_ROUTER).length ? (
                <button className="link small model-more" onClick={() => setMoreRouter(true)}>
                  {t('Show {n} more models on your key', { n: extra(OTHER_ROUTER, ROUTERS, NOT_ROUTER).length })}
                </button>
              ) : null}
        </div>
      ) : (
        <div className="muted small">{t('Without an OpenAI key, a message goes to the agent it names, or the one on screen.')}</div>
      )}
    </div>
  );
}

/**
 * The OpenAI key for cloud speech recognition and routing. It is checked against
 * the API, then stored encrypted by the main process; this page never sees it again.
 */
function OpenAiKey({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const info = snapshot.voice.openaiKey;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await call('openai:setKey', { key: draft.trim() });
      if (!r.ok) setError(r.error ?? t('The key was not saved.'));
      else {
        setDraft('');
        setNote(r.overriddenByEnv ? t('Saved, but OPENAI_API_KEY in the environment is used while it is set.') : t('Saved and in use.'));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const tail = info.last4 ? ` (…${info.last4})` : '';
  const status =
    info.source === 'env'
      ? t('Using OPENAI_API_KEY from the environment') + tail
      : info.source === 'saved'
        ? t('Saved on this computer, encrypted') + tail
        : info.source === 'file'
          ? t('Read from an openai.key file') + tail
          : t('No key yet');
  return (
    <div className="openai-key" data-testid="openai-key">
      <p className="muted small">
        {t('Optional: for cloud speech recognition and routing.')}{' '}
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
          {t('Get a key')}
        </a>
      </p>
      <div className="settings-row">
        <div className="settings-row-main">
          <strong>{t('API key')}</strong>
          <span className="small" data-testid="openai-key-status">
            {status}
          </span>
          <span className={`badge ${info.source ? 'badge-ready' : 'badge-missing'}`}>{info.source ? t('Ready') : t('Not configured')}</span>
        </div>
      </div>
      <div className="row key-row">
        <input
          className="input grow"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={info.source ? t('Paste a new key to replace it') : 'sk-…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && draft.trim() && void save()}
          data-testid="openai-key-input"
        />
        <button className="btn btn-primary" disabled={busy || draft.trim().length < 20} onClick={() => void save()} data-testid="openai-key-save">
          {busy ? t('Checking…') : t('Save key')}
        </button>
        {info.source === 'saved' ? (
          <button className="btn" onClick={() => void call('openai:clearKey', {})} data-testid="openai-key-remove">
            {t('Remove')}
          </button>
        ) : null}
      </div>
      {error ? <div className="error-text small">{error}</div> : null}
      {note ? <div className="small ok-text">{note}</div> : null}
      <div className="muted small">{t('Stored encrypted in the Keychain; never shown again.')}</div>
    </div>
  );
}

const SSH_STATE: Record<RemoteHostStatus['ssh'], { label: string; action?: string; hint?: string }> = {
  checking: { label: 'Checking…' },
  ok: { label: 'Connected' },
  needs_key: { label: 'Key locked', action: 'Unlock key…', hint: 'Your SSH key has a passphrase and is not in the SSH agent. Unlock it once; macOS Keychain keeps the passphrase, so it is not asked again.' },
  needs_login: { label: 'Needs login', action: 'Log in…', hint: 'This server asks for a password or a second factor. Log in once; the connection is reused for a few hours. Setting up key login (ssh-copy-id) avoids this.' },
  unknown_host_key: { label: 'Unknown host key', action: 'Check and trust…', hint: 'This app has not connected to this server before. Confirm its fingerprint once.' },
  unreachable: { label: 'Unreachable' },
};

type HostEntry = { host: string; hostName?: string; user?: string };
const address = (e?: HostEntry) => (e?.hostName ? `${e.user ? `${e.user}@` : ''}${e.hostName}` : undefined);

/**
 * Machines added from ~/.ssh/config, one line each; the rest stay behind "Add machine"
 * (a searchable list), so a long config does not fill the page.
 */
export function RemoteHosts({ snapshot, autoRecheck = false }: { snapshot: WorkspaceSnapshot; autoRecheck?: boolean }) {
  const [hosts, setHosts] = useState<HostEntry[] | null>(null);
  // While a connected machine still lacks an agent (installing or signing in over there), look again
  // now and then so it ticks off by itself (first-run guide).
  const incomplete = snapshot.remoteHosts
    .filter((h) => h.ssh === 'ok' && !(['claude', 'codex'] as const).some((p) => readiness(h.capabilities.find((x) => x.provider === p)) === 'ready'))
    .map((h) => h.host)
    .join(',');
  useEffect(() => {
    if (!autoRecheck || !incomplete) return;
    const id = setInterval(() => {
      // Quiet: the row keeps showing the last result while it looks (no "Checking…" flicker).
      for (const host of incomplete.split(',')) void call('ssh:check', { host, quiet: true }).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, [autoRecheck, incomplete]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<{ host: string; text: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    call('ssh:hosts', {})
      .then(setHosts)
      .catch(() => setHosts([]));
  }, []);
  const act = async (host: string, f: () => Promise<unknown>) => {
    setBusy(host);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError({ host, text: errorText(e) });
    } finally {
      setBusy('');
    }
  };
  if (!hosts) return null;
  if (!hosts.length) return <div className="muted small">{t('No hosts in ~/.ssh/config yet. Add one there (Host, HostName, User), then reopen Settings.')}</div>;
  const available = hosts.filter((e) => !snapshot.remoteHosts.some((h) => h.host === e.host));
  const q = query.trim().toLowerCase();
  const matches = available.filter((e) => !q || [e.host, e.hostName, e.user].some((v) => v?.toLowerCase().includes(q)));
  const closePicker = () => {
    setPicking(false);
    setQuery('');
  };
  const add = (host: string) => {
    closePicker();
    void act(host, () => call('ssh:setEnabled', { host, enabled: true }));
  };
  return (
    <div className="host-list">
      {snapshot.remoteHosts.map((status) => {
        const host = status.host;
        const state = SSH_STATE[status.ssh];
        const addr = address(hosts.find((e) => e.host === host));
        const signedOut = status.ssh === 'ok' ? (['claude', 'codex'] as const).filter((p) => readiness(status.capabilities.find((x) => x.provider === p)) === 'signed_out') : [];
        const missing = status.ssh === 'ok' ? (['claude', 'codex'] as const).filter((p) => readiness(status.capabilities.find((x) => x.provider === p)) === 'missing') : [];
        // Nothing usable there yet: say how to install, and offer a terminal on that machine.
        const noAgent = status.ssh === 'ok' && !(['claude', 'codex'] as const).some((p) => readiness(status.capabilities.find((x) => x.provider === p)) === 'ready');
        return (
          <div key={host} className="settings-row" data-testid={`host-${host}`}>
            <div className="settings-row-main">
              <strong className="mono">{host}</strong>
              {addr ? <span className="muted small mono host-addr">{addr}</span> : null}
              <span className="host-actions">
                {status.ssh === 'ok' ? (
                  (['claude', 'codex'] as const).map((p) => {
                    const c = status.capabilities.find((x) => x.provider === p);
                    const r = readiness(c);
                    const detail = r === 'ready' ? (c?.auth?.method ? t('Signed in · {method}', { method: c.auth.method }) : t('Ready')) : r === 'signed_out' ? t('Not signed in') : t('Not installed');
                    return (
                      <span key={p} className={`badge badge-${r}`} title={detail} data-testid="readiness" data-provider={p} data-state={r}>
                        <Icon name={r === 'ready' ? 'check' : 'alert'} size={12} />
                        {PROVIDER_LABEL[p]}
                        {r === 'ready' && c?.version ? <span className="mono host-version">{shortVersion(c.version)}</span> : null}
                        {r !== 'ready' ? <span className="host-version">· {detail}</span> : null}
                      </span>
                    );
                  })
                ) : (
                  <span className={`badge badge-${status.ssh === 'checking' ? 'checking' : 'signed_out'}`} data-testid="host-state" data-state={status.ssh}>
                    {t(state.label)}
                  </span>
                )}
                {state.action ? (
                  <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void act(host, () => call('ssh:connect', { host }))} data-testid="host-connect">
                    {busy === host ? t('Waiting for you…') : t(state.action)}
                  </button>
                ) : null}
                {(status.ssh !== 'ok' && status.ssh !== 'checking') || noAgent || signedOut.length ? (
                  <button className="btn btn-sm" onClick={() => void act(host, () => call('ssh:terminal', { host }))} title={t('Opens Terminal with ssh {host}, for anything the app cannot handle', { host })}>
                    {t('Open in Terminal')}
                  </button>
                ) : null}
                <button className="btn btn-sm btn-ghost" disabled={!!busy || status.ssh === 'checking'} onClick={() => void act(host, () => call('ssh:check', { host }))}>
                  {t('Recheck')}
                </button>
                <button className="icon-btn" disabled={busy === host} title={t('Remove from this list (nothing changes on the machine)')} aria-label={t('Remove')} onClick={() => void act(host, () => call('ssh:setEnabled', { host, enabled: false }))} data-testid="host-remove">
                  <Icon name="x" size={14} />
                </button>
              </span>
            </div>
            {signedOut.map((p) => (
              <HostAgentSetup key={p} host={host} provider={p} state="signed_out" />
            ))}
            {noAgent ? missing.map((p) => <HostAgentSetup key={p} host={host} provider={p} state="missing" />) : null}
            {state.hint ? <div className="muted small">{t(state.hint)}</div> : null}
            {status.ssh === 'unreachable' && status.error ? <div className="muted small">{status.error}</div> : null}
            {error?.host === host ? <div className="error-text small">{error.text}</div> : null}
          </div>
        );
      })}
      {picking ? (
        <div className="host-picker" data-testid="host-picker">
          <div className="row">
            <input
              className="input grow"
              autoFocus
              placeholder={t('Search {n} hosts in ~/.ssh/config', { n: available.length })}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  closePicker();
                } else if (e.key === 'Enter' && matches[0]) add(matches[0].host);
              }}
              data-testid="host-search"
            />
            <button className="btn" onClick={closePicker}>
              {t('Cancel')}
            </button>
          </div>
          <div className="host-options">
            {matches.map((e) => (
              <button key={e.host} className="host-option" onClick={() => add(e.host)} data-testid="host-option">
                <span className="mono">{e.host}</span>
                {address(e) ? <span className="muted small mono">{address(e)}</span> : null}
              </button>
            ))}
            {!matches.length ? <div className="muted small host-options-empty">{available.length ? t('No matching host.') : t('Every host in ~/.ssh/config is already added.')}</div> : null}
          </div>
        </div>
      ) : (
        <div className="host-add-row">
          <button className="btn btn-sm" onClick={() => setPicking(true)} disabled={!available.length} data-testid="host-add">
            <Icon name="plus" size={14} />
            {t('Add machine')}
          </button>
          {!snapshot.remoteHosts.length ? <span className="muted small">{t('{n} hosts found in ~/.ssh/config.', { n: hosts.length })}</span> : null}
        </div>
      )}
      {error && !snapshot.remoteHosts.some((h) => h.host === error.host) ? <div className="error-text small">{error.text}</div> : null}
    </div>
  );
}

const MIC_MODES: Array<{ id: MicMode; label: string; detail: string }> = [
  { id: 'open', label: 'Always on', detail: 'Always listening; a short pause sends. The shortcut mutes.' },
  { id: 'toggle', label: 'Press to toggle', detail: 'Press the shortcut to talk and again to stop; what you said waits in the box. The mic is off the rest of the time.' },
  { id: 'hold', label: 'Hold to talk', detail: 'Hold the shortcut while you talk; what you said waits in the box. The mic is off the rest of the time.' },
  { id: 'both', label: 'Tap or hold', detail: 'Tap to start and again to stop, or hold while you talk; what you said waits in the box.' },
];

/** Shows the microphone shortcut; click it and press new keys to change it. */
function ShortcutField({ value, onChange }: { value: string; onChange: (shortcut: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [error, setError] = useState('');
  const stop = () => {
    recording.active = false;
    setCapturing(false);
    setHeld([]);
  };
  useEffect(() => () => void (recording.active = false), []);
  const modifiers = (e: React.KeyboardEvent) => shortcutKeys(`${MODIFIERS.filter((m) => ({ Meta: e.metaKey, Control: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey })[m]).join('+')}+`).filter(Boolean);
  return (
    <span className="shortcut-field">
      {error ? <span className="error-text small">{t(error)}</span> : capturing ? <span className="muted small">{t('Esc to cancel')}</span> : null}
      {!capturing && value !== defaultShortcut() ? (
        <button className="link small" onClick={() => onChange(defaultShortcut())}>
          {t('Reset')}
        </button>
      ) : null}
      <button
        className={`shortcut-btn${capturing ? ' capturing' : ''}`}
        data-testid="mic-shortcut"
        title={t('Click, then press the new keys')}
        onClick={() => {
          recording.active = true;
          setCapturing(true);
          setError('');
        }}
        onBlur={stop}
        onKeyDown={(e) => {
          if (!capturing) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          if (e.key === 'Escape') return stop();
          if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return setHeld(modifiers(e));
          const r = shortcutFrom(e.nativeEvent);
          if (!r.shortcut) return setError(r.error ?? '');
          setError('');
          onChange(r.shortcut);
          stop();
        }}
        onKeyUp={(e) => capturing && setHeld(modifiers(e))}
      >
        {capturing ? (held.length ? held.map((k) => <Kbd key={k}>{k}</Kbd>) : t('Press keys…')) : shortcutKeys(value).map((k) => <Kbd key={k}>{k}</Kbd>)}
      </button>
    </span>
  );
}

// The settings, grouped: general first (language), then connecting the CLIs, how agents work, what they know, voice.
const SECTIONS: Array<{ id: string; group: string; title: string; keywords: string[] }> = [
  { id: 'language', group: 'General', title: 'Language', keywords: ['English', '中文', 'locale'] },
  { id: 'guide', group: 'General', title: 'Setup guide', keywords: ['guide', 'onboarding', 'first run', 'setup', 'Open the guide'] },
  { id: 'sleep', group: 'General', title: 'Sleep', keywords: ['Keep the computer awake while agents work', 'sleep', 'awake', 'caffeinate', 'lid'] },
  { id: 'data', group: 'General', title: 'Data', keywords: ['Workspace data is stored in', 'demo', 'folder'] },
  { id: 'agents', group: 'Connect', title: 'Coding agents', keywords: ['Claude Code', 'Codex', 'Signed in', 'login', 'Recheck', 'CLI'] },
  { id: 'remote', group: 'Connect', title: 'Remote machines (SSH)', keywords: ['SSH', 'server', 'remote', 'host', '~/.ssh/config', 'password', 'key', 'Claude Code', 'Codex'] },
  { id: 'main', group: 'How agents work', title: 'Main agent', keywords: ['Claude Code', 'Codex', 'Off', 'coordinator', 'dispatch', 'routing'] },
  { id: 'permissions', group: 'How agents work', title: 'Permissions', keywords: ['Decide automatically', 'Allow file edits', 'Ask every time', 'auto', 'approval', 'Chrome', 'browser', 'Artifact'] },
  { id: 'memory', group: 'Memory and skills', title: 'Memory', keywords: ['User memory', 'Project memory', 'Keep user memory in sync', 'Import…', 'CLAUDE.md', 'AGENTS.md', 'notes'] },
  { id: 'skills', group: 'Memory and skills', title: 'Skills', keywords: ['skill', 'SKILL.md', 'library', 'import', 'Claude Code', 'Codex', '~/.claude/skills', '~/.codex/skills'] },
  { id: 'voice', group: 'Voice and OpenAI', title: 'Voice', keywords: ['Microphone', 'Always on', 'Press to toggle', 'Hold to talk', 'Tap or hold', 'push to talk', 'Shortcut', 'hotkey', 'Speech recognition', 'Speech recognition model', 'Routing model', 'microphone', 'Send after a pause of', 'Confirm every voice send', 'OpenAI', 'On this computer', 'SenseVoice', 'Whisper', 'local', 'offline'] },
  { id: 'openai', group: 'Voice and OpenAI', title: 'OpenAI', keywords: ['API key', 'OPENAI_API_KEY', 'key', 'Save key', 'cloud'] },
  { id: 'advanced', group: 'Advanced', title: 'Advanced', keywords: ['Latest turns shown in full', 'Tool call details', 'Move an agent to idle after', 'Main agent', 'Tool calls per message', 'Forks per message', 'Timeout for commands run with !', 'Restore defaults', 'fold', 'idle', 'timeout'] },
];

/** Settings › Advanced: rarely changed, so each a quiet dropdown; unset = `def`. */
const ADVANCED: Array<{ key: 'openTurns' | 'toolsOpen' | 'idleAfterDays' | 'mainCallsPerTurn' | 'mainForksPerTurn' | 'commandTimeoutMin'; label: string; def: number | string; options: Array<{ v: number | string; label: () => string }> }> = [
  { key: 'openTurns', label: 'Latest turns shown in full', def: 1, options: [...[1, 2, 3, 4, 5].map((n) => ({ v: n, label: () => (n === 1 ? t('1 turn') : t('{n} turns', { n })) })), { v: 0, label: () => t('All') }] },
  { key: 'toolsOpen', label: 'Tool call details', def: 'folded', options: [{ v: 'folded', label: () => t('All folded') }, { v: 'failed', label: () => t('Only failed open') }, { v: 'all', label: () => t('All open') }] },
  { key: 'idleAfterDays', label: 'Move an agent to idle after', def: 3, options: [...[1, 3, 7, 14].map((n) => ({ v: n, label: () => (n === 1 ? t('1 day') : t('{n} days', { n })) })), { v: 0, label: () => t('Never') }] },
  { key: 'mainCallsPerTurn', label: 'Main agent: tool calls per message', def: 30, options: [10, 20, 30, 50].map((n) => ({ v: n, label: () => t('{n} calls', { n }) })) },
  { key: 'mainForksPerTurn', label: 'Main agent: forks per message', def: 3, options: [1, 2, 3, 4, 5].map((n) => ({ v: n, label: () => (n === 1 ? t('1 agent') : t('{n} agents', { n })) })) },
  { key: 'commandTimeoutMin', label: 'Timeout for commands run with !', def: 10, options: [5, 10, 30, 60].map((n) => ({ v: n, label: () => t('{n} min', { n }) })) },
];

/** A settings group; hidden when the search does not match its title or contents. */
function Section({ id, query, actions, children }: { id: string; query: string; actions?: ReactNode; children: ReactNode }) {
  const meta = SECTIONS.find((x) => x.id === id)!;
  const q = query.trim().toLowerCase();
  const haystack = [meta.title, t(meta.title), ...meta.keywords, ...meta.keywords.map((k) => t(k))].join(' ').toLowerCase();
  if (q && !haystack.includes(q)) return null;
  return (
    <section className="settings-section" id={`settings-${id}`} data-testid={`settings-${id}`}>
      <div className="settings-head">
        <h2>{t(meta.title)}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * Settings as a page in the main area (like VS Code): a fixed header with search,
 * a section index on the left, and the settings themselves scrolling on the right.
 */
export function SettingsPage({ snapshot, section, onClose }: { snapshot: WorkspaceSnapshot; section?: string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' });
  }, [section]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const s = snapshot.settings;
  const micMode = s.micMode ?? 'open';
  const update = (patch: Parameters<typeof call<'settings:update'>>[1]) => void call('settings:update', patch).catch((e) => setError(errorText(e)));
  const recheck = async () => {
    setChecking(true);
    setError('');
    await call('capabilities:refresh', {}).catch((e) => setError(errorText(e)));
    setChecking(false);
  };

  const jump = (id: string) => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="settings-page" data-testid="settings-page">
      <header className="stage-head drag">
        <h1>{t('Settings')}</h1>
        <input className="input settings-search" placeholder={t('Search settings')} value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc clears the search first, then closes the page.
            if (e.key !== 'Escape') return;
            if (query) setQuery('');
            else onClose();
          }}
          data-testid="settings-search"
        />
        <div className="stage-actions">
          <button className="icon-btn" aria-label={t('Close')} title={t('Close (Esc)')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('Settings')}>
          {SECTIONS.filter((sec) => !(snapshot.demo && sec.id === 'guide')).map((sec, i, list) => (
            <Fragment key={sec.id}>
              {sec.group !== list[i - 1]?.group ? <div className="settings-nav-group">{t(sec.group)}</div> : null}
              <button className="settings-nav-item" onClick={() => jump(sec.id)}>
                {t(sec.title)}
              </button>
            </Fragment>
          ))}
        </nav>
        <div className="settings-content">
      <Section id="language" query={query}>
        <div className="segmented" role="radiogroup" aria-label={t('Language')}>
          {LANGUAGES.map((l) => (
            <button key={l.id} role="radio" aria-checked={s.language === l.id} className={s.language === l.id ? 'on' : ''} onClick={() => update({ language: l.id })} data-testid={`lang-${l.id}`}>
              {l.label}
            </button>
          ))}
        </div>
      </Section>
      {snapshot.demo ? null : (
        <Section id="guide" query={query}>
          <div className="settings-row-inline">
            <span className="muted small">{t('Connect Claude Code and Codex, machines and voice, step by step.')}</span>
            <button
              className="btn btn-sm"
              onClick={() => {
                // The guide lives where the Overview is: back there, with the guide reopened.
                void call('settings:update', { onboarding: { ...s.onboarding, started: true, dismissed: false } });
                window.dispatchEvent(new CustomEvent('amw:open-guide'));
              }}
              data-testid="reopen-onboarding"
            >
              {t('Open the guide')}
            </button>
          </div>
        </Section>
      )}
      <Section id="sleep" query={query}>
        <label className="check">
          <input type="checkbox" checked={s.keepAwake !== false} onChange={(e) => update({ keepAwake: e.target.checked })} data-testid="keep-awake" />
          <span>
            {t('Keep the computer awake while agents work')}
            <span className="muted small"> — {t('closing the lid still sleeps')}</span>
          </span>
        </label>
      </Section>
      <Section id="data" query={query}>
        <div className="small">
          {t('Workspace data is stored in')} <code>{snapshot.dataDir}</code>
        </div>
        <div className="muted small">{snapshot.demo ? t('This is the demo entry; its data is separate from your real workspace.') : t('To try mock agents without touching this workspace, run npm run demo.')}</div>
      </Section>
      <Section
        id="agents"
        query={query}
        actions={
          <button className="btn btn-sm" disabled={checking} onClick={() => void recheck()}>
            {checking ? t('Checking…') : t('Recheck')}
          </button>
        }
      >
        <p className="muted small">
          {t(
            'Uses the Claude Code and Codex already signed in on this computer. The app never reads their credentials.',
          )}
        </p>
        {(['claude', 'codex'] as const).map((p) => {
          const c = snapshot.capabilities.find((x) => x.provider === p);
          const state = readiness(c);
          return (
            <div key={p} className="settings-row" data-testid={`provider-${p}`}>
              <div className="settings-row-main">
                <strong>{PROVIDER_LABEL[p]}</strong>
                {c?.version ? <span className="muted small mono"> {shortVersion(c.version)}</span> : null}
                <ReadinessBadge state={state} method={c?.auth?.method} />
              </div>
              {state === 'signed_out' ? (
                <div className="small">
                  {t('Sign in once in a terminal, then click Recheck:')} <code>{SIGN_IN[p]}</code>
                </div>
              ) : null}
              {state === 'missing' ? <div className="small">{t('Install the {name} CLI so it is on your PATH, then click Recheck.', { name: PROVIDER_LABEL[p] })}</div> : null}
            </div>
          );
        })}
      </Section>
      <Section id="remote" query={query}>
        <p className="muted small">
          {t(
            'Run agents on machines from your ~/.ssh/config, with the Claude Code and Codex signed in there.',
          )}
        </p>
        <RemoteHosts snapshot={snapshot} />
      </Section>
      <Section id="main" query={query}>
        <p className="muted small">
          {t('Who you talk to when no agent is selected: it passes instructions on, starts agents and answers status questions.')}
        </p>
        <div className="segmented" role="radiogroup" aria-label={t('Main agent')}>
          {(['claude', 'codex', 'off'] as const).map((p) => {
            const on = (s.mainAgent ?? (snapshot.main?.provider as 'claude' | 'codex' | undefined) ?? 'off') === p;
            const c = snapshot.capabilities.find((x) => x.provider === p);
            const usable = p === 'off' || readiness(c) === 'ready';
            return (
              <button key={p} role="radio" aria-checked={on} className={on ? 'on' : ''} disabled={!usable} onClick={() => update({ mainAgent: p })} data-testid={`main-${p}`} title={usable ? undefined : t('Not installed or not signed in')}>
                {p === 'off' ? t('Off') : PROVIDER_LABEL[p]}
              </button>
            );
          })}
        </div>
        <div className="muted small">
          {snapshot.main
            ? t('Changing it starts a new main-agent conversation.')
            : t('Off: messages are routed by name and the routing model instead.')}
        </div>
        {snapshot.main ? (
          <label className="check">
            <input type="checkbox" checked={s.mainChapters !== 'off'} onChange={(e) => update({ mainChapters: e.target.checked ? 'auto' : 'off' })} data-testid="setting-main-chapters" />
            <span>
              {t('Start a new chapter by itself')}
              <span className="muted small"> — {t('after a night away, or a long stretch')}</span>
            </span>
          </label>
        ) : null}
      </Section>
      <Section id="permissions" query={query}>
        <p className="muted small">{t('Default for new agents; each agent can change its own.')}</p>
        <PermissionChoice value={s.permissionMode ?? 'auto'} onChange={(m) => update({ permissionMode: m })} />
        <label className="check">
          <input type="checkbox" checked={s.claudeChrome !== false} onChange={(e) => update({ claudeChrome: e.target.checked })} data-testid="setting-claude-chrome" />
          <span>
            {t('Claude Code agents can use Chrome')}
            <span className="muted small"> — {t('through the Claude in Chrome extension, on this Mac; from their next start')}</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.claudeArtifacts !== false} onChange={(e) => update({ claudeArtifacts: e.target.checked })} data-testid="setting-claude-artifacts" />
          <span>
            {t('Claude Code agents can publish Artifacts')}
            <span className="muted small"> — {t('private pages on claude.ai, each publish asks first; needs a claude.ai login')}</span>
          </span>
        </label>
      </Section>
      <Section id="memory" query={query}>
        <MemorySettings snapshot={snapshot} />
      </Section>
      <Section id="skills" query={query}>
        <SkillsSettings />
      </Section>
      <Section id="voice" query={query}>
        <div className="settings-row">
          <div className="settings-row-main">
            <strong>{t('Speech recognition')}</strong>
            <ReadinessBadge state={snapshot.voice.sttAvailable ? 'ready' : 'missing'} missing="Not configured" />
          </div>
          {!snapshot.voice.sttAvailable ? <div className="small">{t('Pick a model below or add an OpenAI key. Typing always works.')}</div> : null}
        </div>
        <div className="settings-field">
          <strong>{t('Microphone')}</strong>
          <div className="segmented" role="radiogroup" aria-label={t('Microphone')}>
            {MIC_MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={micMode === m.id} className={micMode === m.id ? 'on' : ''} onClick={() => update({ micMode: m.id })} data-testid={`mic-mode-${m.id}`}>
                {t(m.label)}
              </button>
            ))}
          </div>
          <div className="muted small">{t(MIC_MODES.find((m) => m.id === micMode)!.detail)}</div>
        </div>
        <div className="settings-inline">
          <span>
            {t('Shortcut')}
            <span className="muted small"> — {t('works while this app is in front')}</span>
          </span>
          <ShortcutField value={s.micShortcut ?? defaultShortcut()} onChange={(micShortcut) => update({ micShortcut })} />
        </div>
        <ModelPickers snapshot={snapshot} onChange={update} />
        {micMode === 'open' ? (
          <label className="check">
            <input type="checkbox" checked={s.autoListen} onChange={(e) => update({ autoListen: e.target.checked })} data-testid="setting-autolisten" />
            <span>
              {t('Open the microphone when the app starts')}
            </span>
          </label>
        ) : null}
        {micMode === 'open' ? (
        <div className="settings-inline">
          <span>
            {t('Send after a pause of')}
            <span className="muted small"> — {t('shorter pauses keep adding to the same message')}</span>
          </span>
          <div className="segmented" role="radiogroup" aria-label={t('Send after a pause of')}>
            {[1500, 2500, 4000].map((ms) => {
              const on = (s.voicePauseMs ?? 2500) === ms;
              return (
                <button key={ms} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => update({ voicePauseMs: ms })} data-testid={`pause-${ms}`}>
                  {t('{n} s', { n: ms / 1000 })}
                </button>
              );
            })}
          </div>
        </div>
        ) : null}
        <label className="check">
          <input type="checkbox" checked={s.alwaysConfirmVoice} onChange={(e) => update({ alwaysConfirmVoice: e.target.checked })} />
          <span>
            {t('Confirm every voice send')}
            <span className="muted small"> — {t('off: messages that name an agent go right away')}</span>
          </span>
        </label>
      </Section>
      <Section id="openai" query={query}>
        <OpenAiKey snapshot={snapshot} />
      </Section>
      <Section
        id="advanced"
        query={query}
        actions={
          <button className="btn small" disabled={ADVANCED.every((a) => (s[a.key] ?? a.def) === a.def)} onClick={() => update(Object.fromEntries(ADVANCED.map((a) => [a.key, a.def])))} data-testid="advanced-reset">
            {t('Restore defaults')}
          </button>
        }
      >
        {ADVANCED.map((a) => (
          <div className="settings-inline advanced-row" key={a.key}>
            <span>{t(a.label)}</span>
            <select
              className="input select"
              aria-label={t(a.label)}
              value={String(s[a.key] ?? a.def)}
              onChange={(e) => update({ [a.key]: a.options.find((o) => String(o.v) === e.target.value)!.v })}
              data-testid={`adv-${a.key}`}
            >
              {a.options.map((o) => (
                <option key={String(o.v)} value={String(o.v)}>
                  {o.label()}
                </option>
              ))}
            </select>
          </div>
        ))}
      </Section>
      {error ? <div className="error-text">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
