import type { ReactNode } from 'react';
import type { AgentProvider, AgentStatus, AttentionKind } from '../../shared/types';
import { t } from '../i18n';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Working',
  waiting_for_user: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  disconnected: 'Not connected',
};

/**
 * Status is a dot plus text, never colour alone. Colour is reserved for what
 * needs attention (needs you, failed); routine states stay neutral.
 */
export function StatusDot({ status, connected, label = true }: { status: AgentStatus; connected: boolean; label?: boolean }) {
  const offline = !connected && status !== 'disconnected' && status !== 'idle';
  return (
    <span className={`status status-${status}`} title={connected ? t('Provider session connected') : t('No live provider process; resumes on demand')}>
      <span className="dot" aria-hidden />
      {label ? (
        <span className="status-text">
          {t(STATUS_LABEL[status])}
          {offline ? <span className="status-sub"> · {t('offline')}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

export const PROVIDER_LABEL: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex', mock: 'Mock' };

/** "2.1.310 (Claude Code)" / "codex-cli 0.162.1" → the version number. */
export function shortVersion(v: string): string {
  return /\d+\.\d+[\w.-]*/.exec(v)?.[0] ?? v;
}

export function ProviderTag({ provider }: { provider: AgentProvider }) {
  return <span className={`tag provider-${provider}`}>{PROVIDER_LABEL[provider]}</span>;
}

export const KIND_LABEL: Record<AttentionKind, string> = {
  question: 'Question for you',
  approval: 'Permission request',
  review: 'Review',
  completion: 'Report',
  error: 'Error',
};

export function Alias({ alias, size = 'md' }: { alias: string; size?: 'sm' | 'md' | 'lg' }) {
  const hue = ([...alias].reduce((n, c) => n + c.charCodeAt(0), 0) * 67) % 360;
  return (
    <span className={`alias alias-${size}`} style={{ ['--hue' as string]: hue }} title={alias}>
      {initial(alias)}
    </span>
  );
}

/** Avatar letter: "Alice" → A, "小王" → 王, legacy "AB" stays. */
function initial(alias: string): string {
  if (/[㐀-鿿]/.test(alias)) return alias.replace(/^[小老阿]/, '').charAt(0);
  return alias.length <= 2 ? alias : alias.charAt(0).toUpperCase();
}

export function displayName(t: { name: string; alias: string }): string {
  if (t.name === t.alias || !t.name.trim()) return t.alias;
  // Role first, like a job title: "Database Charlie", "数据库小张".
  if (/[㐀-鿿]/.test(t.alias)) return `${t.name}${t.alias}`;
  return `${t.name.charAt(0).toUpperCase()}${t.name.slice(1)} ${t.alias}`;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

const ICONS = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5 11a7 7 0 0 0 14 0 M12 18v3',
  stop: 'M7 7h10v10H7z',
  send: 'M12 19V5 M6 11l6-6 6 6',
  plus: 'M12 5v14 M5 12h14',
  expand: 'M15 4h5v5 M9 20H4v-5 M20 4l-6 6 M4 20l6-6',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 2',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 5l12 7-12 7z',
  power: 'M12 3v8 M6.3 6.3a8 8 0 1 0 11.4 0',
  branch: 'M6 3v12 M18 9a3 3 0 1 0 0-.01 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a9 9 0 0 1-9 9',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12 M18 6L6 18',
  spark: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l2.5 2.5 M15.5 15.5 18 18 M6 18l2.5-2.5 M15.5 8.5 18 6',
  note: 'M5 4h10l4 4v12H5z M15 4v4h4 M8 12h8 M8 16h5',
  reply: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 6 6v5',
  alert: 'M12 4l9 16H3z M12 10v4 M12 17.5v.01',
  chevron: 'M9 6l6 6-6 6',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  terminal: 'M4 17l6-5-6-5 M12 19h8',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18',
  pencil: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
  bulb: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3Z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  list: 'M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  tool: 'M14 6a4 4 0 0 0 5 5l-9 9a2 2 0 0 1-3-3l9-9a4 4 0 0 0-2-2Z',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Minimal Markdown: fenced code, inline code, bold. Text is rendered as text (no HTML injection). */
export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <div className="md">
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const body = part.replace(/^[^\n]*\n/, (first) => (/^\s*[\w+-]*\s*\n$/.test(first) ? '' : first));
          return (
            <pre key={i}>
              <code>{body}</code>
            </pre>
          );
        }
        return part
          .split(/\n{2,}/)
          .filter((p) => p.trim())
          .map((p, j) => <p key={`${i}-${j}`}>{inline(p)}</p>);
      })}
    </div>
  );
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('`') ? <code key={m.index}>{tok.slice(1, -1)}</code> : <strong key={m.index}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
