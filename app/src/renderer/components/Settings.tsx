import { useState } from 'react';
import type { Language, ProviderCapabilities, WorkspaceSnapshot } from '../../shared/types';
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
        <p className="muted small">
          {t('Permissions stay with each agent: it asks before running commands or editing files, and you approve on its tile. Nothing is auto-approved.')}
        </p>
      </section>

      <section className="settings-section">
        <h3>{t('Voice')}</h3>
        <div className="settings-row">
          <div className="settings-row-main">
            <strong>{t('Speech recognition')}</strong>
            <ReadinessBadge state={snapshot.voice.sttAvailable ? 'ready' : 'missing'} method={snapshot.voice.sttModel} missing="Not configured" />
          </div>
          {!snapshot.voice.sttAvailable ? <div className="small">{t('No OpenAI key found. Put it in openai.key next to the app or set OPENAI_API_KEY, then restart. Typing still works.')}</div> : null}
        </div>
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
