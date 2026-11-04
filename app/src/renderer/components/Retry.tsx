import type { AgentProvider, RetryKind, RetryState } from '../../shared/types';
import { useTick } from '../state';
import { Icon } from './bits';
import { Markdown } from './Markdown';
import { t } from '../i18n';

const REASON: Record<RetryKind, string> = { capacity: 'Model at capacity', rate_limit: 'Rate limited', error: 'Model request failed' };

/** A failed model request that will be tried again by itself: why, when, and which try. Needs nothing from the user. */
export function RetryNotice({ retry }: { retry: RetryState }) {
  const now = useTick(1000);
  const seconds = Math.max(0, Math.ceil((Date.parse(retry.at) - now) / 1000));
  const vars = { reason: t(REASON[retry.kind]), s: seconds, n: retry.attempt, max: retry.maxAttempts };
  return (
    <div className="retry-notice" role="status" data-testid="retry-notice" title={retry.error}>
      <Icon name="history" size={12} />
      {seconds ? t('{reason}, retrying in {s}s (attempt {n}/{max})', vars) : t('{reason}, retrying now (attempt {n}/{max})', vars)}
    </div>
  );
}

/** Under a turn that failed because the model was busy: what else the user can do besides Retry. */
export function SwitchModelHint({ provider }: { provider: AgentProvider }) {
  const text =
    provider === 'codex'
      ? t('The model is busy or rate limited. Retry in a moment, or switch to a different Codex model: set `model` in ~/.codex/config.toml, then click Stop and Resume session.')
      : provider === 'claude'
        ? t('The model is busy or rate limited. Retry in a moment, or switch to a different Claude model: set `model` in ~/.claude/settings.json, then click Stop and Resume session.')
        : t('The model is busy or rate limited. Retry in a moment.');
  return (
    <div className="retry-hint">
      <Markdown text={text} />
    </div>
  );
}
