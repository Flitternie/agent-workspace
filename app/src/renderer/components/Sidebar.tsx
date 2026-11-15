import { useState } from 'react';
import { needsYou, visibleOrder, type Team } from '../../shared/agent-order';
import type { Task, WorkspaceSnapshot } from '../../shared/types';
import { AgentName, Alias, displayName, Icon, Kbd, liveSubtasks, PROVIDER_LABEL, STATUS_LABEL, SubtaskDots, SubtaskThread } from './bits';
import { useTick } from '../state';
import { t as tr } from '../i18n';
import { defaultShortcut, shortcutLabel } from '../voice/shortcut';

/**
 * Always-visible participant list. In Focus it doubles as the rail that keeps
 * every other agent's pending request in view.
 */
export function Sidebar({
  snapshot,
  focusId,
  onSelect,
  onOverview,
  onNewTask,
  onResume,
  onSettings,
  settingsOpen,
  teamList,
  expanded,
  toggle,
  onOpenSubtask,
}: {
  snapshot: WorkspaceSnapshot;
  focusId: string | null;
  onSelect: (taskId: string) => void;
  onOverview: () => void;
  onNewTask: () => void;
  onResume: () => void;
  onSettings: () => void;
  settingsOpen?: boolean;
  /** Opens a sub-agent's read-only view. */
  onOpenSubtask: (taskId: string, subtaskId: string) => void;
  /** Project teams, in order (App computes them so ⌘1–9 match). */
  teamList: Team[];
  expanded: (team: Team) => boolean;
  toggle: (team: Team) => void;
}) {
  const micMode = snapshot.settings.micMode ?? 'open';
  const openAll = snapshot.attention.filter((a) => a.state === 'open');
  const open = openAll.filter((a) => a.kind !== 'completion');
  const needYou = new Set(open.map((a) => a.taskId)).size;
  const [showIdle, setShowIdle] = useState<Record<string, boolean>>({});
  // Agents whose sub-agents are unfolded (folded by default; the marks go when the turn ends).
  const [subOpen, setSubOpen] = useState<Set<string>>(new Set());
  const toggleSub = (id: string, open?: boolean) =>
    setSubOpen((cur) => {
      const next = new Set(cur);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  // Running sub-agents show their elapsed time.
  const now = useTick(snapshot.tasks.some((t) => t.subtasks?.some((x) => x.status === 'running')) ? 1000 : 30_000);
  const waiting = needsYou(snapshot.tasks, openAll);
  const projectName = (id: string) => snapshot.projects.find((p) => p.projectId === id)?.name ?? '';
  // ⌘1–9 numbers, as App assigns them.
  const number = new Map(visibleOrder(teamList, expanded).slice(0, 9).map((t, i) => [t.taskId, i + 1]));
  const row = (t: Task, opts: { project?: string; needs?: boolean } = {}) => {
    const pending = open.filter((a) => a.taskId === t.taskId);
    const n = opts.needs ? undefined : number.get(t.taskId);
    const subs = opts.needs ? undefined : liveSubtasks(t);
    const unfolded = !!subs?.length && subOpen.has(t.taskId);
    return (
      // Unfolded, the row and its sub-agents are one card.
      <div key={`${opts.needs ? 'needs-' : ''}${t.taskId}`} className={`agent-item${unfolded ? ' unfolded' : ''}${t.taskId === focusId ? ' active' : ''}`}>
      <button
        className={`agent-row status-${t.status}${t.taskId === focusId ? ' active' : ''}${pending.length ? ' needs' : ''}${opts.needs ? ' compact' : ''}`}
        onClick={() => onSelect(t.taskId)}
        onKeyDown={(e) => {
          // Like a tree: → unfolds sub-agents, ← folds them.
          if (subs?.length && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
            e.preventDefault();
            toggleSub(t.taskId, e.key === 'ArrowRight');
          }
        }}
        data-testid={opts.needs ? 'needs-item' : 'rail-item'}
        data-alias={t.alias}
        title={`${displayName(t)} · ${PROVIDER_LABEL[t.provider]} · ${tr(STATUS_LABEL[t.status])}${n ? ` (⌘${n})` : ''}`}
      >
        <Alias alias={t.alias} size="sm" />
        <span className="agent-row-text">
          <span className="agent-row-name">
            <AgentName task={t} />
            {n ? <span className="kbd-hint">⌘{n}</span> : null}
            <span className={`status status-${t.status}`}>
              <span className="dot" aria-label={tr(STATUS_LABEL[t.status])} />
            </span>
          </span>
          <span className="agent-row-sub">
            <SubtaskDots subtasks={subs} open={unfolded} onToggle={() => toggleSub(t.taskId)} />
            {opts.project ? <span className="row-project">{opts.project} · </span> : null}
            {pending.length ? tr('{n} waiting: {headline}', { n: pending.length, headline: pending[0].headline }) : (t.summary && tr(t.summary)) || t.title}
          </span>
        </span>
      </button>
      {unfolded ? <SubtaskThread subtasks={subs!} now={now} steps={false} onOpen={(id) => onOpenSubtask(t.taskId, id)} /> : null}
      </div>
    );
  };
  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="brand">
          Agent Workspace
          {snapshot.demo ? <span className="demo-badge" title={tr('Demo entry: mock agents, separate data (npm run demo)')}>{tr('Demo')}</span> : null}
        </span>
      </div>

      <button className={`nav-item${focusId || settingsOpen ? '' : ' active'}`} onClick={onOverview} title={tr('Overview (⌘0 / Esc)')}>
        <Icon name="grid" />
        <span>{tr('Overview')}</span>
        {needYou ? <span className="count">{needYou}</span> : null}
      </button>

      {snapshot.main ? (
        <button
          className={`agent-row main-row status-${snapshot.main.status}${snapshot.main.taskId === focusId ? ' active' : ''}`}
          onClick={() => onSelect(snapshot.main!.taskId)}
          data-testid="main-agent-row"
          title={`${tr('Main agent')} · ${PROVIDER_LABEL[snapshot.main.provider]}`}
        >
          <span className="alias alias-sm main-mark" aria-hidden>
            <Icon name="spark" size={12} />
          </span>
          <span className="agent-row-text">
            <span className="agent-row-name">
              <span className="truncate">{tr('Main agent')}</span>
              <span className={`status status-${snapshot.main.status}`}>
                <span className="dot" aria-label={tr(STATUS_LABEL[snapshot.main.status])} />
              </span>
            </span>
            <span className="agent-row-sub">{tr(snapshot.main.summary)}</span>
          </span>
        </button>
      ) : null}

      {waiting.length ? (
        <div className="needs-strip" data-testid="needs-strip">
          <div className="sidebar-section needs-head">
            <span>
              {tr('Needs you')} <span className="count">{waiting.length}</span>
            </span>
          </div>
          {waiting.map((t) => row(t, { project: projectName(t.projectId), needs: true }))}
        </div>
      ) : null}

      <div className="sidebar-section">
        <span>{tr('Agents')}</span>
        <button className="icon-btn" aria-label={tr('New task')} title={tr('New task')} onClick={onNewTask}>
          <Icon name="plus" />
        </button>
      </div>
      <nav className="agent-list" aria-label="Agents">
        {snapshot.tasks.length === 0 ? <div className="muted small pad-x">{tr('No agents yet.')}</div> : null}
        {teamList.map((team) => {
          const open_ = expanded(team);
          const idleShown = showIdle[team.project.projectId];
          return (
            <div key={team.project.projectId} className={`team${open_ ? ' open' : ''}`} data-testid="team" data-project={team.project.name}>
              <button className="team-head" onClick={() => toggle(team)} aria-expanded={open_} data-testid="team-head">
                <span className="team-chevron" aria-hidden>
                  <Icon name="chevron" size={12} />
                </span>
                <span className="team-name truncate">{team.project.name}</span>
                <span className="team-counts">
                  {team.counts.waiting ? <span className="team-count needs" title={tr('{n} need you', { n: team.counts.waiting })}>⚑ {team.counts.waiting}</span> : null}
                  {team.counts.running ? <span className="team-count running" title={tr('{n} working', { n: team.counts.running })}>● {team.counts.running}</span> : null}
                  {team.counts.failed ? <span className="team-count failed" title={tr('{n} failed', { n: team.counts.failed })}>! {team.counts.failed}</span> : null}
                  {!team.members.length ? <span className="team-count idle">{tr('{n} idle', { n: team.idle.length })}</span> : null}
                </span>
              </button>
              {open_ ? (
                <>
                  {team.members.map((t) => row(t))}
                  {team.idle.length ? (
                    <>
                      <button className="team-idle" onClick={() => setShowIdle((cur) => ({ ...cur, [team.project.projectId]: !idleShown }))} data-testid="team-idle">
                        {idleShown ? tr('Hide idle') : tr('⋯ {n} idle', { n: team.idle.length })}
                      </button>
                      {idleShown ? team.idle.map((t) => row(t)) : null}
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <button className="btn btn-block" onClick={onResume} data-testid="resume-session">
          <Icon name="history" /> {tr('Continue a session…')}
        </button>
        <button className={`conn-list${settingsOpen ? ' active' : ''}`} onClick={onSettings} title={tr('Settings')} data-testid="open-settings">
          {snapshot.capabilities
            .filter((c) => c.provider !== 'mock')
            .map((c) => (
              <span key={c.provider} className={`conn${c.available && c.auth?.loggedIn !== false ? ' on' : ''}`}>
                <span className="conn-dot" /> {PROVIDER_LABEL[c.provider]}
              </span>
            ))}
          <span className={`conn${snapshot.voice.sttAvailable ? ' on' : ''}`}>
            <span className="conn-dot" /> {tr('Voice')}
          </span>
          <span className="conn-settings">
            <Icon name="gear" /> {tr('Settings')}
          </span>
        </button>
        <div className="tips">
          <div>
            <Kbd>{shortcutLabel(snapshot.settings.micShortcut ?? defaultShortcut())}</Kbd>{' '}
            {tr(micMode === 'open' ? 'mute / unmute' : micMode === 'hold' ? 'hold to talk' : 'talk / send')}
          </div>
          <div>
            <Kbd>⌘1–9</Kbd> {tr('focus agent')} · <Kbd>Esc</Kbd> {tr('overview')}
          </div>
        </div>
      </div>
    </aside>
  );
}
