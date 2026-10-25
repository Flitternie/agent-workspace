import { useEffect, useState, type ReactNode } from 'react';
import type { Language, PermissionMode, ProviderCapabilities, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { Icon, PROVIDER_LABEL, shortVersion } from './bits';

const LANGUAGES: Array<{ id: Language; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
];

const SIGN_IN: Record<string, string> = { claude: 'claude  →  /login', codex: 'codex login' };

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
    detail: 'Like auto mode in Claude Code: the agent’s own reviewer approves routine actions and only asks you about risky ones (Codex: auto-review of sandbox escalations).',
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
// sentence is for (and names agent roles). Nothing rewrites what you said.
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
  const current = v.sttModel ?? '';
  const inUseLocal = /^local:(.+)$/.exec(current)?.[1];
  // Only offer what this key can use, once we know.
  const usable = (list: ModelOption[]) => (available ? list.filter((c) => available.includes(c.id)) : list);
  const extra = (re: RegExp, known: ModelOption[], not?: RegExp) =>
    (available ?? []).filter((id) => re.test(id) && !(not && not.test(id)) && !known.some((k) => k.id === id) && !/\d{4}-\d\d-\d\d|diarize/.test(id));

  return (
    <div className="model-picks">
      <div className="model-pick-head">
        <span>
          <strong>{t('Speech recognition model')}</strong>
          <span className="muted small">{t('Turns what you say into text. Ratings are from this app’s own tests.')}</span>
        </span>
      </div>
      <div className="model-list" role="radiogroup" aria-label={t('Speech recognition model')} data-testid="stt-list">
        <div className="model-group">{t('On this Mac')} · <span className="muted">{t('audio never leaves the computer')}</span></div>
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
                    if (window.confirm(t('Delete {name} from this Mac?', { name: m.label }))) void call('stt:delete', { id: m.id });
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
          <span className="muted small">{t('Decides which agent a sentence is for when you do not name one, and names agent roles. It does not rewrite what you said.')}</span>
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
        <div className="muted small">{t('Without an OpenAI key, a spoken message goes to the agent it names (or the one you are looking at).')}</div>
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
        ? t('Saved on this Mac, encrypted') + tail
        : info.source === 'file'
          ? t('Read from an openai.key file') + tail
          : t('No key yet');
  return (
    <div className="openai-key" data-testid="openai-key">
      <p className="muted small">
        {t('Used for cloud speech recognition and for routing messages you do not address by name. Optional: with an on-device speech model, voice works without it.')}{' '}
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
      <div className="muted small">{t('The key is checked with OpenAI, then stored encrypted (macOS Keychain) in the app’s data folder. It is never shown again or written to logs.')}</div>
    </div>
  );
}

const SECTIONS: Array<{ id: string; title: string; keywords: string[] }> = [
  { id: 'language', title: 'Language', keywords: ['English', '中文', 'locale'] },
  { id: 'agents', title: 'Coding agents', keywords: ['Claude Code', 'Codex', 'Signed in', 'login', 'Recheck', 'CLI'] },
  { id: 'permissions', title: 'Permissions', keywords: ['Decide automatically', 'Allow file edits', 'Ask every time', 'auto', 'approval'] },
  { id: 'openai', title: 'OpenAI', keywords: ['API key', 'OPENAI_API_KEY', 'key', 'Save key', 'cloud'] },
  { id: 'voice', title: 'Voice', keywords: ['Speech recognition', 'Speech recognition model', 'Routing model', 'microphone', 'Send after a pause of', 'Confirm every voice send', 'OpenAI', 'On this Mac', 'SenseVoice', 'Whisper', 'local', 'offline'] },
  { id: 'data', title: 'Data', keywords: ['Workspace data is stored in', 'demo', 'folder'] },
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
export function SettingsPage({ snapshot, onClose }: { snapshot: WorkspaceSnapshot; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const s = snapshot.settings;
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
          {SECTIONS.map((sec) => (
            <button key={sec.id} className="settings-nav-item" onClick={() => jump(sec.id)}>
              {t(sec.title)}
            </button>
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
            'Agents run through the Claude Code and Codex already installed on this Mac and use the account you are signed in with there. No extra authorization or API key is needed, and this app never reads or stores those credentials.',
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

      <Section id="permissions" query={query}>
        <p className="muted small">{t('Default for new agents. Each agent can be switched on its own page; nothing ever runs with permissions bypassed.')}</p>
        <PermissionChoice value={s.permissionMode ?? 'auto'} onChange={(m) => update({ permissionMode: m })} />
      </Section>

      <Section id="openai" query={query}>
        <OpenAiKey snapshot={snapshot} />
      </Section>

      <Section id="voice" query={query}>
        <div className="settings-row">
          <div className="settings-row-main">
            <strong>{t('Speech recognition')}</strong>
            <ReadinessBadge state={snapshot.voice.sttAvailable ? 'ready' : 'missing'} missing="Not configured" />
          </div>
          {!snapshot.voice.sttAvailable ? <div className="small">{t('Pick a model below: download one to run on this Mac, or add an OpenAI key. Typing works either way.')}</div> : null}
        </div>
        <ModelPickers snapshot={snapshot} onChange={update} />
        <label className="check">
          <input type="checkbox" checked={s.autoListen} onChange={(e) => update({ autoListen: e.target.checked })} data-testid="setting-autolisten" />
          <span>
            {t('Open the microphone when the app starts')}
            <span className="muted small"> — {t('like joining a call; macOS asks for microphone access the first time')}</span>
          </span>
        </label>
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
        <label className="check">
          <input type="checkbox" checked={s.alwaysConfirmVoice} onChange={(e) => update({ alwaysConfirmVoice: e.target.checked })} />
          <span>
            {t('Confirm every voice send')}
            <span className="muted small"> — {t('when off, commands that clearly name an agent are sent right away')}</span>
          </span>
        </label>
      </Section>

      <Section id="data" query={query}>
        <div className="small">
          {t('Workspace data is stored in')} <code>{snapshot.dataDir}</code>
        </div>
        <div className="muted small">{snapshot.demo ? t('This is the demo entry; its data is separate from your real workspace.') : t('To try mock agents without touching this workspace, run npm run demo.')}</div>
      </Section>
      {error ? <div className="error-text">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
