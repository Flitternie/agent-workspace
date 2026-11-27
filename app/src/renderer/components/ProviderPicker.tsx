import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AgentProvider, ProviderCapabilities } from '../../shared/types';
import { CHOICE_GAP, choiceColumns, choiceControl } from '../choice-layout';
import { t } from '../i18n';
import { PROVIDER_LABEL, ProviderIcon, shortVersion } from './bits';

/** "OpenCode 2.4.2" and where it runs from: the version lives in the tooltip, not on the option. */
export function providerTooltip(p: AgentProvider, cap?: ProviderCapabilities): string {
  const head = `${PROVIDER_LABEL[p]}${cap?.version ? ` ${shortVersion(cap.version)}` : ''}`;
  return cap?.detail ? `${head}\n${cap.detail}` : head;
}

/** The width an element has, kept up to date. */
function useWidth<T extends HTMLElement>(dep: unknown): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [dep]);
  return [ref, width];
}

/**
 * Choosing a coding agent: a few as a grid of equal one-line options (mark and name), many as one
 * dropdown (choice-layout.ts). Agents that cannot be used are shown disabled, with `note` saying why.
 */
export function ProviderPicker({
  providers,
  value,
  onChange,
  capOf,
  usable,
  note = () => t('not installed'),
  name = 'provider',
  testId = 'provider-picker',
}: {
  providers: AgentProvider[];
  value: AgentProvider;
  onChange: (p: AgentProvider) => void;
  capOf: (p: AgentProvider) => ProviderCapabilities | undefined;
  usable: (p: AgentProvider) => boolean;
  note?: (p: AgentProvider) => string;
  name?: string;
  testId?: string;
}) {
  const control = choiceControl(providers.length);
  const [ref, width] = useWidth<HTMLDivElement>(control);
  if (control === 'dropdown') {
    const cap = capOf(value);
    return (
      <div className="provider-select" data-testid={testId} data-control="dropdown">
        <select className="input select" value={value} onChange={(e) => onChange(e.target.value as AgentProvider)} title={providerTooltip(value, cap)} aria-label={t('Agent')}>
          {providers.map((p) => (
            <option key={p} value={p} disabled={!usable(p)} title={providerTooltip(p, capOf(p))}>
              {usable(p) ? PROVIDER_LABEL[p] : `${PROVIDER_LABEL[p]} — ${note(p)}`}
            </option>
          ))}
        </select>
      </div>
    );
  }
  // Before the first measurement: as if the options fit side by side (corrected before paint).
  const columns = choiceColumns(providers.length, width || Number.MAX_SAFE_INTEGER);
  return (
    <div ref={ref} className="provider-grid" role="radiogroup" aria-label={t('Agent')} data-testid={testId} data-control="grid" data-columns={columns} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: CHOICE_GAP }}>
      {providers.map((p) => {
        const ok = usable(p);
        return (
          <label key={p} className={`radio${ok ? '' : ' disabled'}${value === p ? ' selected' : ''}`} title={ok ? providerTooltip(p, capOf(p)) : `${PROVIDER_LABEL[p]} — ${note(p)}`} data-provider={p}>
            <input type="radio" name={name} checked={value === p} disabled={!ok} onChange={() => onChange(p)} />
            <ProviderIcon provider={p} />
            <span className="radio-label">{PROVIDER_LABEL[p]}</span>
          </label>
        );
      })}
    </div>
  );
}
