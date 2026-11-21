import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LimitWindow, ProviderLimits, Task } from '../../shared/types';
import { t } from '../i18n';
import { timeAgo } from '../state';
import { PROVIDER_LABEL } from './bits';

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
export function windowLabel(w: LimitWindow): string {
  const model = /opus|sonnet|haiku/i.exec(w.key)?.[0];
  const base = !w.mins ? w.key : w.mins === 10080 ? t('week') : w.mins % 1440 === 0 ? `${w.mins / 1440}d` : w.mins % 60 === 0 ? `${w.mins / 60}h` : `${w.mins}m`;
  return model ? `${base} ${model[0].toUpperCase()}${model.slice(1).toLowerCase()}` : base;
}

/** Highlighted from this share used. */
const HOT = 80;

function resetText(at: number, now: number): string {
  const mins = Math.max(0, Math.round((at - now) / 60_000));
  if (mins < 60) return t('resets in {d}', { d: `${mins}m` });
  if (mins < 24 * 60) return t('resets in {d}', { d: `${Math.floor(mins / 60)}h ${mins % 60}m` });
  return t('resets {when}', { when: new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) });
}

/** A chip in the header's info row; a click opens a small card under it (out of the row, which clips). */
function UsageChip({ testId, className, title, label, children }: { testId: string; className?: string; title: string; label: ReactNode; children: ReactNode }) {
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
    setPos({ left: Math.max(8, Math.min(b.left, window.innerWidth - width - 8)), top });
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
            <div ref={card} className="usage-pop" role="dialog" aria-label={title} data-testid={`${testId}-pop`} style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
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
export function UsageChips({ task, limits, now, only = ['tokens', 'context', 'limits'] }: { task: Task; limits?: ProviderLimits; now: number; only?: Array<'tokens' | 'context' | 'limits'> }) {
  const u = task.usage;
  const { total, cacheHit } = u ? usageTotals(u) : { total: 0, cacheHit: undefined };
  const share = u?.context && u.contextWindow ? (u.context / u.contextWindow) * 100 : undefined;
  const hot = !!limits?.windows.some((w) => w.usedPercent >= HOT);
  const age = limits ? now - Date.parse(limits.at) : 0;
  const asOf = limits && age > 90_000 ? t('as of {time}', { time: timeAgo(limits.at, now) }) : '';
  const limitsText = limits?.windows.map((w) => `${windowLabel(w)} ${w.usedPercent}%`).join(' · ') ?? '';
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
      {only.includes('limits') && limits?.windows.length ? (
        <UsageChip
          testId="usage-limits"
          className={hot ? 'hot' : undefined}
          title={asOf ? `${t('{name} account limits', { name: PROVIDER_LABEL[task.provider] })} · ${asOf}` : t('{name} account limits', { name: PROVIDER_LABEL[task.provider] })}
          label={
            <>
              <span className="chip-full">{t('Limits {list}', { list: limitsText })}</span>
              <span className="chip-short">{`${Math.max(...limits.windows.map((w) => w.usedPercent))}%`}</span>
            </>
          }
        >
          <div className="usage-pop-head">
            {t('{name} account limits', { name: PROVIDER_LABEL[task.provider] })}
            {limits.plan ? <span className="muted"> · {limits.plan}</span> : null}
          </div>
          {limits.windows.map((w) => (
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
