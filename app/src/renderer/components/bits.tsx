import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentProvider, AgentStatus, AttentionKind, SubtaskInfo } from '../../shared/types';
import { digestSubtasks, orderSubtasks, type SubtaskDigest } from '../../shared/subtasks';
import { t, t as tr } from '../i18n';
import { ACP_AGENTS, acpAgent } from '../../shared/acp-agents';
import { AGENT_MARK_VIEWBOX, AgentMark } from './agent-marks';

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

export const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex', mock: 'Mock', ...Object.fromEntries(ACP_AGENTS.map((a) => [a.id, a.label])) } as Record<AgentProvider, string>;

/** "2.1.310 (Claude Code)" / "codex-cli 0.162.1" → the version number. */
export function shortVersion(v: string): string {
  return /\d+\.\d+[\w.-]*/.exec(v)?.[0] ?? v;
}

export function ProviderTag({ provider }: { provider: AgentProvider }) {
  return <span className={`tag provider-${provider}`}>{PROVIDER_LABEL[provider]}</span>;
}

/** The providers' own marks, from Simple Icons (CC0 data; the marks are their owners' trademarks). */
const CLAUDE_MARK = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';
const OPENAI_MARK = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

/**
 * A provider as its mark where its name would be too long (the sidebar's limits): Claude Code the Claude
 * mark in its orange, Codex the OpenAI mark, OpenCode and Antigravity their own marks in their colours; the name is the label.
 */
export function ProviderIcon({ provider, size = 14 }: { provider: AgentProvider; size?: number }) {
  const acp = acpAgent(provider);
  return (
    <svg className={`provider-icon provider-icon-${provider}`} width={size} height={size} viewBox={AGENT_MARK_VIEWBOX[provider] ?? '0 0 24 24'} role="img" aria-label={PROVIDER_LABEL[provider]}>
      {provider === 'claude' ? (
        <path d={CLAUDE_MARK} fill="currentColor" />
      ) : provider === 'codex' ? (
        <path d={OPENAI_MARK} fill="currentColor" />
      ) : AGENT_MARK_VIEWBOX[provider] ? (
        <AgentMark provider={provider} />
      ) : acp ? (
        // An ACP agent without a mark of its own: a neutral badge with its letter.
        <g>
          <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
          <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor" fontFamily="system-ui, sans-serif">
            {acp.mark}
          </text>
        </g>
      ) : (
        // The mock agent (demo and tests): a small terminal, a rounded box with a prompt.
        <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="4" width="19" height="16" rx="3.5" />
          <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" />
        </g>
      )}
    </svg>
  );
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

type Named = { name: string; alias: string; taskId?: string; title?: string; nameSource?: 'auto' | 'user' };

/** What the agent is working on ("订单接口迁移"), or its alias while it has no label yet. */
export function labelOf(t: Named): string {
  if (isMainAgent(t)) return tr('Main agent');
  const name = t.name.trim() && t.name !== t.alias ? t.name : t.alias;
  // A stopgap label is the first message cut short ("读一下 README.md 和 …") until a model names the work:
  // the whole first line then, so a wider column shows more of it (it is cut by the width, not the text).
  if (t.nameSource !== 'user' && name.endsWith('…') && t.title) {
    const line = (t.title.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
    const head = name.slice(0, -1).trim();
    if (head && line.length > head.length && line.includes(head)) return line.slice(line.indexOf(head));
  }
  return name;
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
