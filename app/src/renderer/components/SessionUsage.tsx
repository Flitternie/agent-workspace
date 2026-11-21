import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LimitWindow, ProviderLimits, Task } from '../../shared/types';
import { language, t } from '../i18n';
import { timeAgo } from '../state';
import { Icon, PROVIDER_LABEL } from './bits';

/** 950 · 2.3K · 24.7K · 115K · 1.2M · 1M */
export function formatTokens(n: number): string {
  const trim = (s: string) => s.replace(/\.0$/, '');
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${trim((n / 1000).toFixed(1))}K`;
  if (n < 999_500) return `${Math.round(n / 1000)}K`;
  return `${trim((n / 1_000_000).toFixed(1))}M`;
}

const pct = (n: number) => (n > 0 && n < 1 ? '<1%' : `${Math.round(n)}%`);

/** Tokens in and out; what share of the input was read from the cache. */
export function usageTotals(u: NonNullable<Task['usage']>): { total: number; cacheHit?: number } {
  const input = u.input + u.cacheWrite + u.cacheRead;
  return { total: input + u.output, cacheHit: input > 0 ? (u.cacheRead / input) * 100 : undefined };
}

/** "5h", "week", "8h", "2d": a window by its length. */
/**
 * The windows the providers report that are shown, and how they are called (close to Claude Code's own
 * /usage: "Current session", "Current week (all models)", "Current week (Sonnet only)"). The plan's own
 * windows lead; any other key a provider sends (an internal or a new one) is not shown at all.
 */
const MAIN_KEYS = ['five_hour', 'seven_day', 'primary', 'secondary'];
const EXTRA_LABELS: Record<string, string> = {
  seven_day_sonnet: 'week (Sonnet only)',
  seven_day_opus: 'week (Opus only)',
  seven_day_overage_included: 'week · included extra usage',
  seven_day_oauth_apps: 'week · other apps',
  seven_day_cowork: 'week · Cowork',
};

export function windowLabel(w: LimitWindow): string {
  if (EXTRA_LABELS[w.key]) return t(EXTRA_LABELS[w.key]);
  if (!w.mins) return '';
  return w.mins === 10080 ? t('week') : w.mins % 1440 === 0 ? `${w.mins / 1440}d` : w.mins % 60 === 0 ? `${w.mins / 60}h` : `${w.mins}m`;
}

/** The plan's own windows (5 hours, a week): what a one-line summary shows. */
export function mainWindows(windows: LimitWindow[]): LimitWindow[] {
  return windows.filter((w) => MAIN_KEYS.includes(w.key) && !!w.mins);
}

/** Every window with a name to show: the plan's own first, then the known others. */
export function shownWindows(windows: LimitWindow[]): LimitWindow[] {
  return [...mainWindows(windows), ...windows.filter((w) => EXTRA_LABELS[w.key])];
}

/** Highlighted from this share used. */
const HOT = 80;

function resetText(at: number, now: number): string {
  // In the app's language (not the system's): the duration and the weekday.
  const zh = language() === 'zh';
  const mins = Math.max(0, Math.round((at - now) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (mins < 60) return t('resets in {d}', { d: zh ? `${mins} 分钟` : `${mins}m` });
  if (mins < 24 * 60) return t('resets in {d}', { d: zh ? `${h} 小时 ${m} 分钟` : `${h}h ${m}m` });
  return t('resets {when}', { when: new Date(at).toLocaleString(zh ? 'zh-CN' : 'en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) });
}

/** A chip in the header's info row; a click opens a small card under it (out of the row, which clips). */
function UsageChip({ testId, className, popClass, title, label, children }: { testId: string; className?: string; popClass?: string; title: string; label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const b = button.current.getBoundingClientRect();
    const width = card.current?.offsetWidth ?? 280;
    const height = card.current?.offsetHeight ?? 160;
    // Below the chip, or above it when there is no room below (under the reply box).
    const top = b.bottom + 6 + height > window.innerHeight - 8 ? Math.max(8, b.top - 6 - height) : b.bottom + 6;
    // Its edge on the chip's: the left edge for a chip on the left half of the window, the right edge for
    // one on the right (the context beside the reply box), so the card hangs from the chip itself.
    const left = b.left + b.width / 2 > window.innerWidth / 2 ? b.right - width : b.left;
    setPos({ left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!button.current?.contains(n) && !card.current?.contains(n)) setOpen(false);
    };
    // Esc closes just this (before the app's Esc, which leaves the agent view).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  return (
    <>
      <button ref={button} className={`memory-chip usage-chip${className ? ` ${className}` : ''}${open ? ' open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} title={title} data-testid={testId}>
        {label}
      </button>
      {open
        ? createPortal(
            <div ref={card} className={`usage-pop${popClass ? ` ${popClass}` : ''}`} role="dialog" aria-label={title} data-testid={`${testId}-pop`} style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`usage-row${strong ? ' strong' : ''}`}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function Ring({ share }: { share: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, share / 100));
  return (
    <svg className="usage-ring" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <circle cx="6" cy="6" r={r} fill="none" strokeWidth="2" className="usage-ring-track" />
      <circle cx="6" cy="6" r={r} fill="none" strokeWidth="2" className="usage-ring-fill" strokeDasharray={`${f * c} ${c}`} transform="rotate(-90 6 6)" />
    </svg>
  );
}

/** The agent's tokens so far (header), its context now and its provider account's limits (under the reply box). */
export function UsageChips({ task, limits, now, only = ['tokens', 'context', 'limits'] }: { task: Task; limits?: ProviderLimits; now: number; only?: Array<'tokens' | 'context' | 'limits' | 'limits-if-hot'> }) {
  const u = task.usage;
  const { total, cacheHit } = u ? usageTotals(u) : { total: 0, cacheHit: undefined };
  const share = u?.context && u.contextWindow ? (u.context / u.contextWindow) * 100 : undefined;
  const hot = !!limits && mainWindows(limits.windows).some((w) => w.usedPercent >= HOT);
  const age = limits ? now - Date.parse(limits.at) : 0;
  const asOf = limits && age > 90_000 ? t('as of {time}', { time: timeAgo(limits.at, now) }) : '';
  const limitsText = limits ? mainWindows(limits.windows).map((w) => `${windowLabel(w)} ${w.usedPercent}%`).join(' · ') : '';
  return (
    <>
      {only.includes('tokens') && u && total > 0 ? (
        <UsageChip
          testId="usage-tokens"
          title={t('Tokens this agent has used')}
          label={
            <>
              <span aria-hidden>⛁</span>
              <span className="chip-full">{cacheHit !== undefined ? t('{n} tok · {p}% cached', { n: formatTokens(total), p: Math.round(cacheHit) }) : t('{n} tok', { n: formatTokens(total) })}</span>
              <span className="chip-short">{formatTokens(total)}</span>
            </>
          }
        >
          <div className="usage-pop-head">{t('Tokens this agent has used')}</div>
          <Row label={t('Total')} value={total.toLocaleString()} strong />
          {cacheHit !== undefined ? <Row label={t('Cache hit')} value={pct(cacheHit)} /> : null}
          <Row label={t('Uncached input')} value={u.input.toLocaleString()} />
          {task.provider !== 'codex' || u.cacheWrite ? <Row label={t('Cache write')} value={u.cacheWrite.toLocaleString()} /> : null}
          <Row label={t('Cache read')} value={u.cacheRead.toLocaleString()} />
          <Row label={t('Output')} value={u.output.toLocaleString()} />
          {task.provider === 'codex' || u.reasoning ? <Row label={t('of which reasoning')} value={u.reasoning.toLocaleString()} /> : null}
          <div className="usage-note">{t('Summed over all of this agent’s sessions.')}</div>
        </UsageChip>
      ) : null}
      {only.includes('context') && u?.context ? (
        <UsageChip
          testId="usage-context"
          popClass="narrow"
          title={t('Context window used')}
          label={
            <>
              {share !== undefined ? <Ring share={share} /> : null}
              <span>{share !== undefined ? pct(share) : `~${formatTokens(u.context)}`}</span>
            </>
          }
        >
          <div className="usage-pop-head">{t('Context window used')}</div>
          <div className="usage-big mono">
            ~{formatTokens(u.context)}
            {u.contextWindow ? ` / ${formatTokens(u.contextWindow)}` : ''}
          </div>
          {share !== undefined ? (
            <div className="usage-bar">
              <span style={{ width: `${Math.min(100, share)}%` }} />
            </div>
          ) : null}
          <div className="usage-note">{t('As of the latest model request.')}</div>
        </UsageChip>
      ) : null}
      {(only.includes('limits') || (only.includes('limits-if-hot') && hot)) && limits && mainWindows(limits.windows).length ? (
        <UsageChip
          testId="usage-limits"
          className={hot ? 'hot' : undefined}
          title={asOf ? `${t('{name} account limits', { name: PROVIDER_LABEL[task.provider] })} · ${asOf}` : t('{name} account limits', { name: PROVIDER_LABEL[task.provider] })}
          label={
            <>
              <span className="chip-full">{only.includes('limits-if-hot') ? t('{name} limits {list}', { name: PROVIDER_LABEL[task.provider], list: limitsText }) : t('Limits {list}', { list: limitsText })}</span>
              <span className="chip-short">{`${Math.max(...mainWindows(limits.windows).map((w) => w.usedPercent))}%`}</span>
            </>
          }
        >
          <div className="usage-pop-head">
            {t('{name} account limits', { name: PROVIDER_LABEL[task.provider] })}
            {limits.plan ? <span className="muted"> · {limits.plan}</span> : null}
          </div>
          {shownWindows(limits.windows).map((w) => (
            <div key={w.key} className={`usage-limit${w.usedPercent >= HOT ? ' hot' : ''}`} data-testid="usage-limit">
              <div className="usage-row">
                <span>{windowLabel(w)}</span>
                <span className="mono">{t('{p}% used', { p: w.usedPercent })}</span>
              </div>
              <div className="usage-bar">
                <span style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
              </div>
              {w.resetsAt ? <div className="usage-note">{resetText(w.resetsAt, now)}</div> : null}
            </div>
          ))}
          <div className="usage-note">
            {asOf || t('Updated {time}', { time: timeAgo(limits.at, now) })}
            {task.provider === 'claude' ? ` · ${t('Claude Code reports these with each turn.')}` : ''}
          </div>
        </UsageChip>
      ) : null}
    </>
  );
}

/**
 * Each provider account's limits (a provider on a machine: accounts differ between machines), one line
 * each, for the sidebar's foot: they belong to the account, not to any one agent.
 */
export function AccountLimits({ limits, now, payAsYouGo = [] }: { limits: Record<string, ProviderLimits>; now: number; payAsYouGo?: Task['provider'][] }) {
  const [open, setOpenState] = useState(() => localStorage.getItem('amw.limitsOpen') !== '0');
  const setOpen = (on: boolean) => {
    localStorage.setItem('amw.limitsOpen', on ? '1' : '0');
    setOpenState(on);
  };
  const rows = Object.entries(limits)
    .filter(([, l]) => mainWindows(l.windows).length)
    .map(([key, l]) => ({ key, l, provider: (l.provider ?? key.split('@')[0]) as Task['provider'], host: l.host ?? key.split('@')[1] }))
    .sort((a, b) => Number(!!a.host) - Number(!!b.host) || (a.host ?? '').localeCompare(b.host ?? '') || a.provider.localeCompare(b.provider));
  // Signed in with an API key (this Mac): billed by use, no plan limits to show; said so, not left blank.
  const metered = payAsYouGo.filter((p) => !rows.some((r) => r.provider === p && !r.host));
  if (!rows.length && !metered.length) return null;
  // The machine is named only when there is more than this Mac.
  const machines = rows.some((r) => r.host);
  // Folded to one line (the highest use across accounts), kept on this machine; a nearly used-up window
  // still shows on the folded line.
  const top = rows.length ? Math.max(...rows.flatMap((r) => mainWindows(r.l.windows).map((w) => w.usedPercent))) : 0;
  const anyHot = top >= HOT;
  return (
    <div className={`account-limits${open ? ' open' : ''}`} data-testid="account-limits">
      <button className={`account-limits-head${anyHot ? ' hot' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} data-testid="account-limits-head">
        <span className="team-chevron" aria-hidden>
          <Icon name="chevron" size={12} />
        </span>
        <span>{t('Limits')}</span>
        {open || !rows.length ? null : <span className="mono">{top}%</span>}
      </button>
      {open
        ? metered.map((p) => (
            <div key={`metered-${p}`} className="account-metered" data-testid="account-metered" title={t('Signed in with an API key: billed by use, with no plan limits.')}>
              <span className="account-name truncate">{`${PROVIDER_LABEL[p]}${machines ? ` · ${t('this Mac')}` : ''}`}</span>
              <span className="muted">{t('API key · billed by use')}</span>
            </div>
          ))
        : null}
      {open ? rows.map(({ key, l, provider, host }) => {
        const name = `${PROVIDER_LABEL[provider]}${machines ? ` · ${host ?? t('this Mac')}` : ''}`;
        const hot = mainWindows(l.windows).some((w) => w.usedPercent >= HOT);
        const age = now - Date.parse(l.at);
        const asOf = age > 90_000 ? t('as of {time}', { time: timeAgo(l.at, now) }) : '';
        return (
          <UsageChip
            key={key}
            testId="account-limit"
            className={`account-limit${hot ? ' hot' : ''}`}
            title={asOf ? `${t('{name} account limits', { name })} · ${asOf}` : t('{name} account limits', { name })}
            label={
              <>
                <span className="account-name truncate">{name}</span>
                <span className="account-windows">
                  {mainWindows(l.windows).map((w) => (
                    <span key={w.key} className={`lim${w.usedPercent >= HOT ? ' hot' : ''}`}>
                      <span className="lim-k">{windowLabel(w)}</span>
                      <span className="lim-bar" aria-hidden>
                        <i style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
                      </span>
                      <span className="lim-v mono">{w.usedPercent}%</span>
                    </span>
                  ))}
                </span>
              </>
            }
          >
            <div className="usage-pop-head">
              {t('{name} account limits', { name })}
              {l.plan ? <span className="muted"> · {l.plan}</span> : null}
            </div>
            {shownWindows(l.windows).map((w) => (
              <div key={w.key} className={`usage-limit${w.usedPercent >= HOT ? ' hot' : ''}`} data-testid="usage-limit">
                <div className="usage-row">
                  <span>{windowLabel(w)}</span>
                  <span className="mono">{t('{p}% used', { p: w.usedPercent })}</span>
                </div>
                <div className="usage-bar">
                  <span style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
                </div>
                {w.resetsAt ? <div className="usage-note">{resetText(w.resetsAt, now)}</div> : null}
              </div>
            ))}
            <div className="usage-note">
              {asOf || t('Updated {time}', { time: timeAgo(l.at, now) })}
              {provider === 'claude' ? ` · ${t('Claude Code reports these with each turn.')}` : ''}
            </div>
          </UsageChip>
        );
      }) : null}
    </div>
  );
}
