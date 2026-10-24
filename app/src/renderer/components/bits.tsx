import type { ReactNode } from 'react';
import type { AgentProvider, AgentStatus, AttentionKind } from '../../shared/types';

const STATUS: Record<AgentStatus, { label: string; icon: string }> = {
  idle: { label: 'Idle', icon: '○' },
  starting: { label: 'Starting', icon: '◌' },
  running: { label: 'Working', icon: '▶' },
  waiting_for_user: { label: 'Needs you', icon: '!' },
  done: { label: 'Done', icon: '✓' },
  failed: { label: 'Failed', icon: '✕' },
  disconnected: { label: 'Not connected', icon: '⏸' },
};

/** Status is always icon + text, never color alone. */
export function StatusPill({ status, connected }: { status: AgentStatus; connected: boolean }) {
  const s = STATUS[status];
  return (
    <span className={`pill status-${status}`} title={connected ? 'Provider session connected' : 'No live provider process; resumes on demand'}>
      <span className="pill-icon" aria-hidden>
        {s.icon}
      </span>
      {s.label}
      {!connected && status !== 'disconnected' && status !== 'idle' ? <span className="pill-sub"> · offline</span> : null}
    </span>
  );
}

export const PROVIDER_LABEL: Record<AgentProvider, string> = { claude: 'Claude Code', codex: 'Codex', mock: 'Mock' };

export function ProviderBadge({ provider }: { provider: AgentProvider }) {
  return <span className={`provider provider-${provider}`}>{PROVIDER_LABEL[provider]}</span>;
}

export const KIND_LABEL: Record<AttentionKind, string> = {
  question: 'Question for you',
  approval: 'Permission request',
  review: 'Review',
  completion: 'Report',
  error: 'Error',
};

export function Alias({ alias, size = 'md' }: { alias: string; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`alias alias-${size}`}>{alias}</span>;
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
