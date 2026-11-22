import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentProvider, AgentStatus, AttentionKind, SubtaskInfo } from '../../shared/types';
import { digestSubtasks, orderSubtasks, type SubtaskDigest } from '../../shared/subtasks';
import { t, t as tr } from '../i18n';

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

export function Alias({ alias, size = 'md' }: { alias: string; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
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

/** System notes written by the main process, shown in the UI language. */
export function systemText(text: string): string {
  const m = /^(.+?) is waiting on you \((permission|question)\): ([\s\S]*)$/.exec(text);
  if (m) return tr(m[2] === 'permission' ? '{alias} needs your permission: {what}' : '{alias} is asking you: {what}', { alias: m[1], what: m[3] });
  const settled = /^(.+?)'s request is settled: ([\s\S]*)$/.exec(text);
  return settled ? tr('{alias}’s request is settled: {what}', { alias: settled[1], what: settled[2] }) : text;
}

/** The main agent is stored like a task, with a reserved id. */
export function isMainAgent(t: { taskId?: string } | undefined): boolean {
  return !!t?.taskId?.startsWith('t-main-');
}

type Named = { name: string; alias: string; taskId?: string };

/** What the agent is working on ("订单接口迁移"), or its alias while it has no label yet. */
export function labelOf(t: Named): string {
  if (isMainAgent(t)) return tr('Main agent');
  return t.name.trim() && t.name !== t.alias ? t.name : t.alias;
}

/** The whole reference, for captions, tooltips and confirmations: "订单接口迁移 · 小王", or just "小王". */
export function displayName(t: Named): string {
  const label = labelOf(t);
  return isMainAgent(t) || label === t.alias ? label : `${label} · ${t.alias}`;
}

/** The label first, the alias (the agent's stable handle, what you say to it) small beside it. */
export function AgentName({ task }: { task: Named }) {
  const label = labelOf(task);
  return (
    <>
      <span className="truncate">{label}</span>
      {!isMainAgent(task) && label !== task.alias ? <span className="alias-tag">{task.alias}</span> : null}
    </>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

const ICONS = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5 11a7 7 0 0 0 14 0 M12 18v3',
  stop: 'M7 7h10v10H7z',
  remember: 'M7 3.5h10a1 1 0 0 1 1 1V21l-6-4-6 4V4.5a1 1 0 0 1 1-1Z M12 7.5v6 M9 10.5h6',
  send: 'M12 19V5 M6 11l6-6 6 6',
  plus: 'M12 5v14 M5 12h14',
  expand: 'M15 4h5v5 M9 20H4v-5 M20 4l-6 6 M4 20l6-6',
  collapse: 'M14 4v6h6 M10 20v-6H4 M14 10l6-6 M10 14l-6 6',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 2',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 5l12 7-12 7z',
  power: 'M12 3v8 M6.3 6.3a8 8 0 1 0 11.4 0',
  branch: 'M6 3v12 M18 9a3 3 0 1 0 0-.01 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a9 9 0 0 1-9 9',
  flask: 'M9 3h6 M10 3v6l-5 9.2A1.9 1.9 0 0 0 6.7 21h10.6a1.9 1.9 0 0 0 1.7-2.8L14 9V3 M7.3 15h9.4',
  subtasks: 'M6 4v14a2 2 0 0 0 2 2h10 M6 11h12 M14 7l4 4-4 4',
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
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v5h-5',
  tool: 'M14 6a4 4 0 0 0 5 5l-9 9a2 2 0 0 1-3-3l9-9a4 4 0 0 0-2-2Z',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M11 18h2',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  diff: 'M6 3h9l4 4v14H6z M9 10h6 M12 7v6 M9 17h6',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z',
  shield: 'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z',
  btw: 'M4 5h16v11H9l-5 4z M8 9h8 M8 12h5',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 9h.01',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

/** m:ss between two times. */
export function clock(fromIso: string, to: number): string {
  const sec = Math.max(0, Math.round((to - Date.parse(fromIso)) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** m:ss since a sub-agent started (or until it ended). */
export function elapsed(s: SubtaskInfo, now: number): string {
  return clock(s.startedAt, s.endedAt ? Date.parse(s.endedAt) : now);
}

/**
 * The sub-agents of the agent's latest turn: still marked after the turn ends (grey dots), since
 * coming back to see what an agent's helpers did is when they matter; the next turn replaces them.
 */
export function liveSubtasks(t: { status: AgentStatus; subtasks?: SubtaskInfo[] }): SubtaskInfo[] | undefined {
  return t.subtasks?.length ? t.subtasks : undefined;
}

/** Rows the hover card lists before counting the rest. */
const POP_ROWS = 8;

/** "+12 more · 3 running" for what a short list leaves out. */
function moreText(d: SubtaskDigest): string {
  return d.hidden.running ? tr('+{n} more · {r} running', { n: d.hidden.total, r: d.hidden.running }) : tr('+{n} more', { n: d.hidden.total });
}

/**
 * An agent's sub-agents as a few dots beside its status: no extra height. Running ones pulse,
 * finished ones are grey, failed ones red. Hover for what each is doing; click to unfold the thread.
 */
export function SubtaskDots({ subtasks, open, onToggle }: { subtasks?: SubtaskInfo[]; open: boolean; onToggle: () => void }) {
  // The hover card floats above everything (rows clip their text), next to the dots.
  // Below the mark, or above it when the card would run past the window's bottom (rows low in the sidebar).
  const [pop, setPop] = useState<{ left: number; top: number; above: number } | null>(null);
  if (!subtasks?.length) return null;
  const digest = digestSubtasks(subtasks, POP_ROWS);
  const running = digest.running;
  const state = subtasks.some((s) => s.status === 'failed') ? 'failed' : running ? 'running' : 'done';
  const toggle = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    setPop(null);
    onToggle();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={`subtask-dots st-${state}${open ? ' open' : ''}`}
      data-state={state}
      aria-expanded={open}
      aria-label={tr('{n} sub-agents, {r} running', { n: subtasks.length, r: running })}
      data-testid="subtask-dots"
      onClick={toggle}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggle(e)}
      onMouseEnter={(e) => {
        if (open) return;
        const r = e.currentTarget.getBoundingClientRect();
        setPop({ left: Math.min(r.left, window.innerWidth - 240), top: r.bottom + 4, above: r.top - 4 });
      }}
      onMouseLeave={() => setPop(null)}
    >
      {/* Short however many there are: a branch mark and the count (working / all while some work), coloured by state. */}
      <Icon name="subtasks" size={11} />
      <span className="subtask-count">{running && running < subtasks.length ? `${running}/${subtasks.length}` : subtasks.length}</span>
      {pop
        ? createPortal(
            <div
              className="subtask-pop"
              role="tooltip"
              style={{ left: pop.left, top: pop.top }}
              data-testid="subtask-pop"
              ref={(el) => {
                if (!el) return;
                const h = el.offsetHeight;
                el.style.top = `${pop.top + h > window.innerHeight - 8 ? Math.max(8, pop.above - h) : pop.top}px`;
              }}
            >
              {digest.shown.map((s) => (
                <div key={s.id} className="subtask-pop-row">
                  <span className={`sdot sdot-${s.status}`} />
                  <span className="subtask-pop-text">
                    <span className="truncate">{s.description}</span>
                    {s.status === 'running' && s.step ? <span className="subtask-pop-step truncate">{s.step}</span> : null}
                  </span>
                </div>
              ))}
              {digest.hidden.total ? <div className="subtask-pop-more">{moreText(digest)}</div> : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

/** Unfolded sub-agents: half-height rows on a thread line, no avatar, so they never read as sessions. */
export function SubtaskThread({
  subtasks,
  now,
  max = 3,
  steps = true,
  heading = false,
  onOpen,
}: {
  subtasks: SubtaskInfo[];
  now: number;
  max?: number;
  /** Show each one's current step (cards have the room; the sidebar shows it on hover). */
  steps?: boolean;
  /** A section label like the card's others ("Latest", "Activity"). */
  heading?: boolean;
  onOpen: (id: string) => void;
}) {
  // Working ones first, so a long list still shows what is going on; the rest unfold in place.
  const [all, setAll] = useState(false);
  const digest = digestSubtasks(subtasks, max);
  const shown = all ? orderSubtasks(subtasks) : digest.shown;
  return (
    <div className={`subtask-thread${heading ? ' with-heading' : ''}${all ? ' all' : ''}`} data-testid="subtask-thread">
      {heading ? <div className="section-label">{tr('Sub-agents {n}', { n: subtasks.length })}</div> : null}
      {shown.map((s) => (
        <button key={s.id} className={`subtask-row st-${s.status}`} data-testid="subtask-row" title={tr('See what it did')} onClick={() => onOpen(s.id)}>
          <span className={`sdot sdot-${s.status}`} />
          <span className="subtask-desc truncate">
            {s.description}
            {steps && s.status === 'running' && s.step ? <span className="subtask-step"> · {s.step}</span> : null}
          </span>
          <span className="subtask-time">{s.status === 'done' ? <StatusIcon status="completed" /> : s.status === 'failed' ? <StatusIcon status="failed" /> : elapsed(s, now)}</span>
        </button>
      ))}
      {digest.hidden.total ? (
        <button className="subtask-more" data-testid="subtask-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? tr('Show fewer') : moreText(digest)}
        </button>
      ) : null}
    </div>
  );
}

/** Workspace warnings written by the main process, in the UI language. */
export function warningText(text: string): string {
  const shares = /^Shares a writable directory with (.+) — edits are not isolated\.$/.exec(text);
  // The names come joined in English; the list separator follows the language (、 in Chinese).
  const names = (list: string) => list.split(', ').join(tr(', '));
  if (shares) return tr('Shares a writable directory with {names} — edits are not isolated.', { names: names(shares[1]) });
  const original = /^Uses its original directory, shared with (.+) — not isolated\.$/.exec(text);
  if (original) return tr('Uses its original directory, shared with {names} — not isolated.', { names: names(original[1]) });
  return text;
}

/**
 * A small drawn state mark for a step, tool call or sub-task, in the current text colour
 * (callers colour it). Drawn rather than font glyphs (… ✓ ✕ ⊘ ◼), which sit and size
 * differently in every font.
 */
export function StatusIcon({ status, size = 12 }: { status: 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'declined' | 'interrupted'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (status === 'running')
    return (
      <svg {...common} className="status-icon spin">
        <path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" />
      </svg>
    );
  if (status === 'completed')
    return (
      <svg {...common} className="status-icon">
        <path d="M2.3 6.3l2.4 2.4 5-5.2" />
      </svg>
    );
  if (status === 'failed')
    return (
      <svg {...common} className="status-icon">
        <path d="M3 3l6 6M9 3l-6 6" />
      </svg>
    );
  if (status === 'declined')
    return (
      <svg {...common} className="status-icon">
        <circle cx="6" cy="6" r="4.5" />
        <path d="M2.9 9.1l6.2-6.2" />
      </svg>
    );
  if (status === 'interrupted')
    return (
      <svg {...common} className="status-icon">
        <rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
      </svg>
    );
  return (
    <svg {...common} className="status-icon">
      <circle cx="6" cy="6" r="4.5" />
      <circle cx="6" cy="6" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
