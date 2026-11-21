import { useState, type MouseEvent } from 'react';
import { needsYou, visibleOrder, type Team } from '../../shared/agent-order';
import type { Task, WorkspaceSnapshot } from '../../shared/types';
import { Alias, displayName, Icon, Kbd, liveSubtasks, PROVIDER_LABEL, STATUS_LABEL, SubtaskDots, SubtaskThread } from './bits';
import { AccountLimits } from './SessionUsage';
import { useTick } from '../state';
import { t as tr } from '../i18n';
import { defaultShortcut, shortcutLabel } from '../voice/shortcut';
import { call } from '../api';
import { InlineEdit, menuAt, menuKey, useContextMenu, type MenuItem } from './ContextMenu';
import { agentMenuItems, EditableAgentName, type AgentField } from './AgentMenu';

/**
 * Always-visible participant list. In Focus it doubles as the rail that keeps
 * every other agent's pending request in view.
 */
/**
 * The row's dot: green only for a result you have not looked at (grey once seen; it stays listed),
 * hollow for an agent you set aside, as for one that is stopped.
 */
function dotStatus(t: Task): string {
  if (t.setAside && (t.status === 'done' || t.status === 'idle')) return 'idle';
  if (t.status === 'done' && !t.unread) return 'seen';
  return t.status;
}

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
  const signedOut = snapshot.capabilities.filter((c) => c.provider !== 'mock' && c.available && c.auth?.loggedIn === false);
  const openAll = snapshot.attention.filter((a) => a.state === 'open');
  const open = openAll.filter((a) => a.kind !== 'completion');
  // Agents set aside are not counted: whatever they were waiting on is hidden with them.
  const asideIds = new Set(snapshot.tasks.filter((t) => t.setAside).map((t) => t.taskId));
  const needYou = new Set(open.filter((a) => !asideIds.has(a.taskId)).map((a) => a.taskId)).size;
  const [showIdle, setShowIdle] = useState<Record<string, boolean>>({});
  // Right-click: one menu at a time; a rename edits the name where it stands.
  const menu = useContextMenu();
  const [editing, setEditing] = useState<{ taskId: string; field: AgentField; needs: boolean } | { projectId: string } | null>(null);
  const editingField = (t: Task, needs: boolean) => (editing && 'taskId' in editing && editing.taskId === t.taskId && editing.needs === needs ? editing.field : null);
  const editingProject = (id: string) => !!editing && 'projectId' in editing && editing.projectId === id;
  const projectItems = (projectId: string): MenuItem[] => [{ id: 'rename-project', label: tr('Rename project…'), icon: 'pencil', onSelect: () => setEditing({ projectId }) }];
  const projectMenu = (e: MouseEvent, projectId: string) => menu.open(menuAt(e, projectItems(projectId)));
  const projectNameEdit = (team: Team) => (
    <InlineEdit
      value={team.project.name}
      label={tr('Project name')}
      testId="rename-project-input"
      className="team-name-edit"
      onSave={(v) => call('project:rename', { projectId: team.project.projectId, name: v })}
      onDone={() => setEditing(null)}
    />
  );
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
  // Projects where nothing is going on (every agent idle for days or set aside) fold into one
  // "Archived" row at the end, so the list does not grow with every project ever used. A project
  // comes back by itself as soon as one of its agents does something, or is opened or messaged.
  const live = teamList.filter((team) => team.active);
  const archived = teamList.filter((team) => !team.active);
  const [archiveOpen, setArchiveOpenState] = useState(() => localStorage.getItem('amw.archiveOpen') === '1');
  const setArchiveOpen = (on: boolean) => {
    localStorage.setItem('amw.archiveOpen', on ? '1' : '0');
    setArchiveOpenState(on);
  };
  // The agent on screen is always visible in the list.
  const archiveShown = archiveOpen || archived.some((team) => snapshot.tasks.some((t) => t.taskId === focusId && t.projectId === team.project.projectId));
  const renderTeam = (team: Team) => {
          const open_ = expanded(team);
          const idleShown = showIdle[team.project.projectId];
          return (
            <div key={team.project.projectId} className={`team${open_ ? ' open' : ''}`} data-testid="team" data-project={team.project.name}>
              {editingProject(team.project.projectId) ? (
                <div className="team-head editing" data-testid="team-head">
                  <span className="team-chevron" aria-hidden>
                    <Icon name="chevron" size={12} />
                  </span>
                  {projectNameEdit(team)}
                </div>
              ) : (
              <button
                className="team-head"
                onClick={() => toggle(team)}
                onContextMenu={(e) => projectMenu(e, team.project.projectId)}
                onKeyDown={(e) => {
                  const m = menuKey(e, () => projectItems(team.project.projectId));
                  if (m) menu.open(m);
                }} aria-expanded={open_} data-testid="team-head">
                <span className="team-chevron" aria-hidden>
                  <Icon name="chevron" size={12} />
                </span>
                <span className="team-name truncate">{team.project.name}</span>
                <span className="team-counts">
                  {team.counts.waiting ? <span className="team-count needs" title={tr('{n} need you', { n: team.counts.waiting })}>⚑ {team.counts.waiting}</span> : null}
                  {team.counts.running ? <span className="team-count running" title={tr('{n} working', { n: team.counts.running })}>
                      <span className="count-dot" aria-hidden /> {team.counts.running}
                    </span> : null}
                  {team.counts.failed ? <span className="team-count failed" title={tr('{n} failed', { n: team.counts.failed })}>! {team.counts.failed}</span> : null}
                  {!team.members.length ? <span className="team-count idle">{tr('{n} idle', { n: team.idle.length })}</span> : null}
                </span>
              </button>
              )}
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
          };
  // In the archive every agent is idle: no second fold per project, nor an idle row; each project is a
  // label over all its agents, so opening the archive shows them.
  const renderArchived = (team: Team) => {
    const agents = [...team.members, ...team.idle];
    return (
      <div key={team.project.projectId} className="team archived open" data-testid="team" data-project={team.project.name}>
        <div className="team-head archived-head" data-testid="team-head" onContextMenu={(e) => projectMenu(e, team.project.projectId)}>
          {editingProject(team.project.projectId) ? projectNameEdit(team) : <span className="team-name truncate">{team.project.name}</span>}
          <span className="team-counts">
            <span className="team-count idle">{agents.length === 1 ? tr('1 agent') : tr('{n} agents', { n: agents.length })}</span>
          </span>
        </div>
        {agents.map((t) => row(t))}
      </div>
    );
  };
  const row = (t: Task, opts: { project?: string; needs?: boolean } = {}) => {
    const pending = open.filter((a) => a.taskId === t.taskId);
    const n = opts.needs ? undefined : number.get(t.taskId);
    const subs = opts.needs ? undefined : liveSubtasks(t);
    const unfolded = !!subs?.length && subOpen.has(t.taskId);
    const field = editingField(t, !!opts.needs);
    const items = () => agentMenuItems(t, { onRename: (f) => setEditing({ taskId: t.taskId, field: f, needs: !!opts.needs }), setAside: true, onOpen: () => onSelect(t.taskId) });
    const cls = `agent-row status-${t.status}${t.taskId === focusId ? ' active' : ''}${pending.length ? ' needs' : ''}${opts.needs ? ' compact' : ''}`;
    const inner = (
      <>
        <Alias alias={t.alias} size="sm" />
        <span className="agent-row-text">
          <span className="agent-row-name">
            <EditableAgentName task={t} tasks={snapshot.tasks} editing={field} onDone={() => setEditing(null)} />
            {n && !field ? <span className="kbd-hint">⌘{n}</span> : null}
            <span className={`status status-${dotStatus(t)}`} data-testid="row-dot" data-dot={dotStatus(t)}>
              <span className="dot" aria-label={tr(STATUS_LABEL[t.status])} />
            </span>
          </span>
          <span className="agent-row-sub">
            <SubtaskDots subtasks={subs} open={unfolded} onToggle={() => toggleSub(t.taskId)} />
            {opts.project ? <span className="row-project">{opts.project} · </span> : null}
            {/* What it is on: the last task of its session map, never its latest message (which reads as noise
                in a list). Waiting on the user, a short label; the question itself is in the agent. No map
                yet, nothing. */}
            {pending.length ? tr('Waiting on you') : snapshot.workTitles?.[t.taskId]}
          </span>
        </span>
      </>
    );
    return (
      // Unfolded, the row and its sub-agents are one card.
      <div key={`${opts.needs ? 'needs-' : ''}${t.taskId}`} className={`agent-item${unfolded ? ' unfolded' : ''}${t.taskId === focusId ? ' active' : ''}`}>
      {field ? (
        // Renamed in place: an input cannot sit in a button, so the row is a plain box meanwhile.
        <div className={`${cls} editing`} data-testid={opts.needs ? 'needs-item' : 'rail-item'} data-alias={t.alias}>
          {inner}
        </div>
      ) : (
      <button
        className={cls}
        onClick={() => onSelect(t.taskId)}
        onContextMenu={(e) => menu.open(menuAt(e, items()))}
        onKeyDown={(e) => {
          const m = menuKey(e, items);
          if (m) return menu.open(m);
          // Like a tree: → unfolds sub-agents, ← folds them.
          if (subs?.length && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
            e.preventDefault();
            toggleSub(t.taskId, e.key === 'ArrowRight');
          }
          // F2 renames, as in a file list.
          if (e.key === 'F2') {
            e.preventDefault();
            setEditing({ taskId: t.taskId, field: 'name', needs: !!opts.needs });
          }
        }}
        data-testid={opts.needs ? 'needs-item' : 'rail-item'}
        data-alias={t.alias}
        title={`${displayName(t)} · ${PROVIDER_LABEL[t.provider]} · ${tr(STATUS_LABEL[t.status])}${n ? ` (⌘${n})` : ''}`}
      >
        {inner}
      </button>
      )}
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
            {snapshot.workTitles?.[snapshot.main.taskId] ? <span className="agent-row-sub">{snapshot.workTitles[snapshot.main.taskId]}</span> : null}
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
        <span className="sidebar-section-actions">
          <button className="icon-btn" aria-label={tr('Continue a session…')} title={tr('Continue a session…')} onClick={onResume} data-testid="resume-session">
            <Icon name="history" />
          </button>
          <button className="icon-btn" aria-label={tr('New task')} title={tr('New task')} onClick={onNewTask} data-testid="sidebar-new-task">
            <Icon name="plus" />
          </button>
        </span>
      </div>
      <nav className="agent-list" aria-label="Agents" onScroll={showScrollbarAWhile} data-testid="agent-list">
        {snapshot.tasks.length === 0 ? <div className="muted small pad-x">{tr('No agents yet.')}</div> : null}
        {live.map(renderTeam)}
        {archived.length ? (
          <div className="team-archive" data-testid="team-archive">
            <button className="team-head team-archive-head" onClick={() => setArchiveOpen(!archiveShown)} aria-expanded={archiveShown} data-testid="team-archive-head" title={tr('Nothing going on for 3 days; a project comes back when one of its agents is used.')}>
              <span className="team-chevron" aria-hidden>
                <Icon name="chevron" size={12} />
              </span>
              <span className="team-name truncate">{tr('Archived')}</span>
              <span className="team-count idle">{tr('{n} projects', { n: archived.length })}</span>
            </button>
            {archiveShown ? archived.map(renderArchived) : null}
          </div>
        ) : null}
      </nav>

      <div className="sidebar-foot">
        {/* What each provider account has left (per machine): the account's, not any one agent's. */}
        <AccountLimits
          limits={snapshot.limits ?? {}}
          now={Date.now()}
          payAsYouGo={snapshot.capabilities.filter((c) => (c.provider === 'claude' || c.provider === 'codex') && c.auth?.loggedIn && /api key/i.test(c.auth.method ?? '')).map((c) => c.provider)}
        />
        {signedOut.length ? (
          // Only a CLI that is installed but signed out is flagged: its agents cannot run. A missing CLI
          // is a choice (one provider is enough), and voice says so where it is used.
          <button className="sidebar-warn" onClick={onSettings} data-testid="provider-warning">
            <Icon name="alert" size={13} /> <span className="truncate">{tr('{names} signed out', { names: signedOut.map((c) => PROVIDER_LABEL[c.provider]).join(', ') })}</span>
          </button>
        ) : null}
        <button className={`sidebar-settings${settingsOpen ? ' active' : ''}`} onClick={onSettings} title={tr('Settings')} data-testid="open-settings">
          <Icon name="gear" /> {tr('Settings')}
        </button>
        <div className="tips">
          <div>
            <Kbd>{shortcutLabel(snapshot.settings.micShortcut ?? defaultShortcut())}</Kbd>{' '}
            {tr(micMode === 'open' ? 'mute / unmute' : micMode === 'hold' ? 'hold to talk' : 'talk')}
          </div>
          <div>
            <Kbd>⌘1–9</Kbd> {tr('focus agent')} · <Kbd>Esc</Kbd> {tr('overview')}
          </div>
        </div>
      </div>
      {menu.element}
    </aside>
  );
}

/** The list's scrollbar shows while it scrolls and fades a moment after (also with "always show" on). */
const scrollTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
function showScrollbarAWhile(e: { currentTarget: Element }) {
  const el = e.currentTarget;
  el.classList.add('scrolling');
  clearTimeout(scrollTimers.get(el));
  scrollTimers.set(
    el,
    setTimeout(() => el.classList.remove('scrolling'), 900),
  );
}
