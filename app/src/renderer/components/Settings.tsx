import { useEffect, useState } from 'react';
import type { Language, PermissionMode, ProviderCapabilities, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { Icon, PROVIDER_LABEL, shortVersion } from './bits';
import { Modal } from './Dialogs';

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
const STT_CHOICES: Array<{ id: string; note: string }> = [
  { id: 'gpt-4o-transcribe', note: 'Most accurate; best with mixed Chinese and English' },
  { id: 'gpt-4o-mini-transcribe', note: 'Faster and cheaper, slightly less accurate' },
  { id: 'whisper-1', note: 'Older Whisper model' },
];
const ROUTER_CHOICES: Array<{ id: string; note: string }> = [
  { id: 'gpt-5.4-mini', note: 'Recommended: accurate, about 1 s' },
  { id: 'gpt-5.4-nano', note: 'Fastest, about 0.8 s; occasionally misroutes' },
  { id: 'gpt-5.5', note: 'Most capable, slower' },
  { id: 'gpt-4.1-mini', note: 'Previous default' },
];
const OTHER_STT = /^(gpt-[\w.-]*transcribe|whisper-\d)$/;
const OTHER_ROUTER = /^(gpt-(4\.1|4o|5)[\w.-]*|o\d(-mini)?)$/;
// gpt-4.1-nano is still listed by the API but deprecated for chat.
const NOT_ROUTER = /audio|realtime|search|transcribe|tts|image|codex|pro|chat-latest|diarize|\d{4}-\d\d-\d\d|^gpt-4\.1-nano$/;

function ModelSelect({ label, hint, value, choices, other, testId, onChange }: { label: string; hint: string; value: string; choices: Array<{ id: string; note: string }>; other: string[]; testId: string; onChange: (id: string) => void }) {
  const known = new Set(choices.map((c) => c.id));
  return (
    <label className="model-pick">
      <span>
        <strong>{label}</strong>
        <span className="muted small">{hint}</span>
      </span>
      <select className="input select" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id} — {t(c.note)}
          </option>
        ))}
        {other.filter((id) => !known.has(id)).length ? (
          <optgroup label={t('Other models on your key')}>
            {other
              .filter((id) => !known.has(id))
              .map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}

function ModelPickers({ snapshot, onChange }: { snapshot: WorkspaceSnapshot; onChange: (p: { sttModel?: string; routerModel?: string }) => void }) {
  const [available, setAvailable] = useState<string[] | null>(null);
  useEffect(() => {
    call('models:list', {})
      .then(setAvailable)
      .catch(() => setAvailable(null));
  }, []);
  // Only offer what this key can use, once we know.
  const usable = (list: Array<{ id: string; note: string }>) => (available ? list.filter((c) => available.includes(c.id)) : list);
  return (
    <div className="model-picks">
      <ModelSelect
        label={t('Speech recognition model')}
        hint={t('Turns what you say into text.')}
        value={snapshot.voice.sttModel ?? ''}
        choices={usable(STT_CHOICES)}
        other={(available ?? []).filter((id) => OTHER_STT.test(id) && !/\d{4}-\d\d-\d\d|diarize/.test(id))}
        testId="stt-model"
        onChange={(id) => onChange({ sttModel: id })}
      />
      <ModelSelect
        label={t('Routing model')}
        hint={t('Decides which agent a sentence is for when you do not name one, and names agent roles. It does not rewrite what you said.')}
        value={snapshot.voice.routerModel ?? ''}
        choices={usable(ROUTER_CHOICES)}
        other={(available ?? []).filter((id) => OTHER_ROUTER.test(id) && !NOT_ROUTER.test(id))}
        testId="router-model"
        onChange={(id) => onChange({ routerModel: id })}
      />
    </div>
  );
}

export function SettingsDialog({ snapshot, onClose }: { snapshot: WorkspaceSnapshot; onClose: () => void }) {
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

  return (
    <Modal title={t('Settings')} onClose={onClose}>
      <section className="settings-section">
        <h3>{t('Language')}</h3>
        <div className="segmented" role="radiogroup" aria-label={t('Language')}>
          {LANGUAGES.map((l) => (
            <button key={l.id} role="radio" aria-checked={s.language === l.id} className={s.language === l.id ? 'on' : ''} onClick={() => update({ language: l.id })} data-testid={`lang-${l.id}`}>
              {l.label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-head">
          <h3>{t('Coding agents')}</h3>
          <button className="btn btn-sm" disabled={checking} onClick={() => void recheck()}>
            {checking ? t('Checking…') : t('Recheck')}
          </button>
        </div>
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
      </section>

      <section className="settings-section">
        <h3>{t('Permissions')}</h3>
        <p className="muted small">{t('Default for new agents. Each agent can be switched on its own page; nothing ever runs with permissions bypassed.')}</p>
        <PermissionChoice value={s.permissionMode ?? 'auto'} onChange={(m) => update({ permissionMode: m })} />
      </section>

      <section className="settings-section">
        <h3>{t('Voice')}</h3>
        <div className="settings-row">
          <div className="settings-row-main">
            <strong>{t('Speech recognition')}</strong>
            <ReadinessBadge state={snapshot.voice.sttAvailable ? 'ready' : 'missing'} missing="Not configured" />
          </div>
          {!snapshot.voice.sttAvailable ? <div className="small">{t('No OpenAI key found. Put it in openai.key next to the app or set OPENAI_API_KEY, then restart. Typing still works.')}</div> : null}
        </div>
        {snapshot.voice.sttAvailable ? <ModelPickers snapshot={snapshot} onChange={update} /> : null}
        <label className="check">
          <input type="checkbox" checked={s.autoListen} onChange={(e) => update({ autoListen: e.target.checked })} data-testid="setting-autolisten" />
          <span>
            {t('Open the microphone when the app starts')}
            <span className="muted small"> — {t('like joining a call; macOS asks for microphone access the first time')}</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.alwaysConfirmVoice} onChange={(e) => update({ alwaysConfirmVoice: e.target.checked })} />
          <span>
            {t('Confirm every voice send')}
            <span className="muted small"> — {t('when off, commands that clearly name an agent are sent right away')}</span>
          </span>
        </label>
      </section>

      <section className="settings-section">
        <h3>{t('Data')}</h3>
        <div className="small">
          {t('Workspace data is stored in')} <code>{snapshot.dataDir}</code>
        </div>
        <div className="muted small">{snapshot.demo ? t('This is the demo entry; its data is separate from your real workspace.') : t('To try mock agents without touching this workspace, run npm run demo.')}</div>
      </section>
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  );
}
