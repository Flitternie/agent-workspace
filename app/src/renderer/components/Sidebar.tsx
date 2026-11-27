import { useState, type MouseEvent } from 'react';
import { needsYou, visibleOrder, type Team } from '../../shared/agent-order';
import type { Task, WorkspaceSnapshot } from '../../shared/types';
import { Alias, displayName, Icon, Kbd, liveSubtasks, PROVIDER_LABEL, STATUS_LABEL, SubtaskDots, SubtaskThread } from './bits';
import { AccountLimits } from './SessionUsage';
import { useTick } from '../state';
import { t as tr } from '../i18n';
import { defaultShortcut, shortcutLabel } from '../voice/shortcut';
import { call, errorText } from '../api';
import { RESEARCH_COLORS, researchColor, type ResearchDoc, type ResearchSummary } from '../../shared/research';
import { Modal } from './Dialogs';
import { InlineEdit, menuAt, menuKey, useContextMenu, type MenuItem } from './ContextMenu';
import { agentMenuItems, canFork, EditableAgentName, type AgentField } from './AgentMenu';
import { ForkDialog } from './Dialogs';

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
  researchOpen,
  onOpenResearch,
  onNewResearch,
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
  /** The research whose page is open (its id), and opening one; starting one ('' = the project is chosen in the dialog). */
  researchOpen?: string | null;
  onOpenResearch: (researchId: string) => void;
  onNewResearch: (projectId: string) => void;
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
  // Forking from a row's menu (the dialog asks from where and on which CLI).
  const [forking, setForking] = useState<Task | null>(null);
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
  // Agents picked to act on together (⌘/⇧-click), and the dialog a research's menu leads to.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [dlg, setDlg] = useState<ResearchDlg | null>(null);
  const changeResearch = async (id: string, change: (d: ResearchDoc) => ResearchDoc) => {
    const d = await call('research:get', { researchId: id });
    if (d) await call('research:save', { researchId: id, doc: { ...change(d), updatedAt: new Date().toISOString() } });
  };
  /** For an agent's menu: what is picked (if it is among them), else itself, within its project, into a research. */
  const researchItems = (t: Task): Array<MenuItem | '-'> => {
    const ids = (picked.has(t.taskId) ? [...picked] : [t.taskId]).filter((id) => snapshot.tasks.find((x) => x.taskId === id)?.projectId === t.projectId);
    return [
      '-',
      { id: 'merge', label: ids.length === 1 ? tr('Make a research from this conversation…') : tr('Merge {n} conversations into a research…', { n: ids.length }), icon: 'flask', onSelect: () => setDlg({ kind: 'merge', projectId: t.projectId, taskIds: ids }) },
      ...snapshot.research
        .filter((r) => r.projectId === t.projectId)
        .map((r): MenuItem => ({
          id: 'add',
          label: tr('Add to "{title}"', { title: r.title }),
          onSelect: () =>
            void call('research:addTasks', { researchId: r.id, taskIds: ids })
              .then(() => (setPicked(new Set()), onOpenResearch(r.id)))
              .catch(() => {}),
        })),
    ];
  };
  const researchMenuItems = (r: ResearchSummary): Array<MenuItem | '-'> => [
    { id: 'rename', label: tr('Rename…'), icon: 'pencil', onSelect: () => setDlg({ kind: 'rename', research: r }) },
    { id: 'colour', label: tr('Colour…'), onSelect: () => setDlg({ kind: 'colour', research: r }) },
    ...(r.atRoot
      ? [{ id: 'move-agents', label: tr('Move its agents into its folder ({n})', { n: r.atRoot }), onSelect: () => void call('research:moveAgents', { researchId: r.id }).catch(() => {}) } satisfies MenuItem]
      : []),
    '-',
    { id: 'dissolve', label: tr('Dissolve…'), icon: 'trash', onSelect: () => setDlg({ kind: 'dissolve', research: r }) },
  ];
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
  const inResearch = new Set(snapshot.research.flatMap((r) => r.taskIds));
  const waitingAgents = waiting.filter((t) => !inResearch.has(t.taskId));
  const waitingResearch = snapshot.research.filter((r) => waiting.some((t) => r.taskIds.includes(t.taskId)));
  const projectName = (id: string) => snapshot.projects.find((p) => p.projectId === id)?.name ?? '';
  // ⌘1–9 numbers, as App assigns them.
  const number = new Map(visibleOrder(teamList, expanded).slice(0, 9).map((t, i) => [t.taskId, i + 1]));
  // Projects where nothing is going on (every agent idle for days or set aside) fold into one
  // "Archived" row at the end, so the list does not grow with every project ever used. A project
  // comes back by itself as soon as one of its agents does something, or is opened or messaged.
  // A research is one row in its project's team (its agents are on its page), above the members; a
  // project holding several repositories may have one per repository (kept in its folder).
  const researchesOf = (projectId: string) => snapshot.research.filter((r) => r.projectId === projectId);
  const researchOf = (projectId: string) => researchesOf(projectId)[0];
  const researchRows = (projectId: string) => researchesOf(projectId).map(researchRow);
  const researchRow = (r: (typeof snapshot.research)[number]) => {
    const ids = new Set(r.taskIds);
    const running = snapshot.tasks.filter((x) => ids.has(x.taskId) && (x.status === 'running' || x.status === 'starting')).length;
    const waiting = new Set(snapshot.attention.filter((a) => a.state === 'open' && a.kind !== 'completion' && ids.has(a.taskId)).map((a) => a.taskId)).size;
    const on = researchOpen === r.id;
    return (
      <div key={`research-${r.id}`} className={`agent-item${on ? ' active' : ''}`}>
        <button className={`agent-row research-row${on ? ' active' : ''}${waiting ? ' needs' : ''}`} onClick={() => onOpenResearch(r.id)} onContextMenu={(e) => menu.open(menuAt(e, researchMenuItems(r)))} data-testid="research-row" title={tr('Research: {title}', { title: r.title })}>
          <span className="alias alias-sm research-mark" style={{ background: researchColor(r) }} aria-hidden>
            <Icon name="flask" size={12} />
          </span>
          <span className="agent-row-text">
            <span className="agent-row-name">
              <span className="truncate">{r.title}</span>
              {waiting ? <span className="team-count needs">⚑ {waiting}</span> : null}
            </span>
            <span className="agent-row-sub">
              {tr('Research')}
              {r.dir ? ` · ${r.dir}` : ''}
              {r.taskIds.length ? ` · ${r.taskIds.length === 1 ? tr('1 agent') : tr('{n} agents', { n: r.taskIds.length })}` : ''}
              {running ? ` · ${tr('{n} working', { n: running })}` : ''}
            </span>
          </span>
        </button>
      </div>
    );
  };
  // A project whose agents are all in its research has no team of its own: its research still shows.
  const teamless = [...new Set(snapshot.research.map((r) => r.projectId))].filter((id) => !teamList.some((team) => team.project.projectId === id) && snapshot.projects.some((p) => p.projectId === id));
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
                  {researchRows(team.project.projectId)}
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
    const items = () => [
      ...agentMenuItems(t, { onRename: (f) => setEditing({ taskId: t.taskId, field: f, needs: !!opts.needs }), setAside: true, onOpen: () => onSelect(t.taskId), onFork: canFork(snapshot, t) ? () => setForking(t) : undefined }),
      ...researchItems(t),
    ];
    const cls = `agent-row status-${t.status}${t.taskId === focusId ? ' active' : ''}${pending.length ? ' needs' : ''}${opts.needs ? ' compact' : ''}${picked.has(t.taskId) ? ' picked' : ''}`;
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
        aria-selected={picked.has(t.taskId) || undefined}
        onClick={(e) => {
          // ⌘/⇧-click picks agents to act on together (their menu: merge into a research); a plain click opens one.
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            setPicked((cur) => {
              const next = new Set(cur);
              if (next.has(t.taskId)) next.delete(t.taskId);
              else next.add(t.taskId);
              return next;
            });
            return;
          }
          if (picked.size) setPicked(new Set());
          onSelect(t.taskId);
        }}
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

      <button className={`nav-item${focusId || settingsOpen || researchOpen ? '' : ' active'}`} onClick={onOverview} title={tr('Overview (⌘0 / Esc)')}>
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
              {tr('Needs you')} <span className="count">{waitingAgents.length + waitingResearch.length}</span>
            </span>
          </div>
          {/* A research's agents are on its page, not each in the list: one row for the research. */}
          {waitingResearch.map(researchRow)}
          {waitingAgents.map((t) => row(t, { project: projectName(t.projectId), needs: true }))}
        </div>
      ) : null}

      <div className="sidebar-section">
        <span>{tr('Agents')}</span>
        <span className="sidebar-section-actions">
          <button className="icon-btn" aria-label={tr('Continue a session…')} title={tr('Continue a session…')} onClick={onResume} data-testid="resume-session">
            <Icon name="history" />
          </button>
          {/* New: an agent, or a research (its project is chosen in the dialog). */}
          <button
            className="icon-btn"
            aria-label={tr('New')}
            title={tr('New agent or research')}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              menu.open({
                x: r.left,
                y: r.bottom + 4,
                items: [
                  { id: 'new-agent', label: tr('New agent'), icon: 'plus', onSelect: onNewTask },
                  { id: 'new-research', label: tr('New research'), icon: 'flask', onSelect: () => onNewResearch('') },
                ],
              });
            }}
            data-testid="sidebar-new-task"
          >
            <Icon name="plus" />
          </button>
        </span>
      </div>
      <nav className="agent-list" aria-label="Agents" onScroll={showScrollbarAWhile} data-testid="agent-list">
        {snapshot.tasks.length === 0 ? <div className="muted small pad-x">{tr('No agents yet.')}</div> : null}
        {live.map(renderTeam)}
        {teamless.map((projectId) => (
          <div key={projectId} className="team open" data-testid="team" data-project={snapshot.projects.find((p) => p.projectId === projectId)?.name}>
            <div className="team-head archived-head">
              <span className="team-name truncate">{snapshot.projects.find((p) => p.projectId === projectId)?.name}</span>
            </div>
            {researchRows(projectId)}
          </div>
        ))}
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
        <AccountLimits limits={snapshot.limits ?? {}} now={Date.now()} />
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
      {dlg ? (
        <ResearchDialog
          dlg={dlg}
          snapshot={snapshot}
          onClose={() => setDlg(null)}
          onDone={(openId) => {
            setDlg(null);
            setPicked(new Set());
            if (openId) onOpenResearch(openId);
          }}
          changeResearch={changeResearch}
        />
      ) : null}
      {forking ? <ForkDialog snapshot={snapshot} task={forking} onClose={() => setForking(null)} onForked={(id) => onSelect(id)} /> : null}
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

type ResearchDlg = { kind: 'merge'; projectId: string; taskIds: string[] } | { kind: 'rename'; research: ResearchSummary } | { kind: 'colour'; research: ResearchSummary } | { kind: 'dissolve'; research: ResearchSummary };

/** The dialogs a research's menu leads to: conversations into a new research, a new name, dissolving it. */
function ResearchDialog({
  dlg,
  snapshot,
  onClose,
  onDone,
  changeResearch,
}: {
  dlg: ResearchDlg;
  snapshot: WorkspaceSnapshot;
  onClose: () => void;
  onDone: (openId?: string) => void;
  changeResearch: (id: string, change: (d: ResearchDoc) => ResearchDoc) => Promise<void>;
}) {
  const tasks = dlg.kind === 'merge' ? dlg.taskIds.map((id) => snapshot.tasks.find((t) => t.taskId === id)).filter((t): t is Task => !!t) : [];
  const [title, setTitle] = useState(dlg.kind === 'merge' ? (tasks[0]?.title ?? '') : dlg.research.title);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = (fn: () => Promise<string | undefined | void>) => {
    setBusy(true);
    setError('');
    fn()
      .then((id) => onDone(id || undefined))
      .catch((e) => (setError(errorText(e)), setBusy(false)));
  };
  if (dlg.kind === 'dissolve')
    return (
      <Modal title={tr('Dissolve "{title}"?', { title: dlg.research.title })} onClose={onClose}>
        <div className="rs-text" data-testid="research-dissolve">
          {tr('Its agents go back to the project’s list as ordinary agents. Nothing is deleted: the tree, notes and views stay in the repository, in a renamed folder (.research.dissolved-…).')}
        </div>
        {error ? <div className="error-text">{error}</div> : null}
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={() => run(() => call('research:dissolve', { researchId: dlg.research.id }).then(() => undefined))} data-testid="research-dissolve-ok">
            {tr('Dissolve')}
          </button>
        </div>
      </Modal>
    );
  if (dlg.kind === 'colour') {
    const now = RESEARCH_COLORS.indexOf(researchColor(dlg.research) as (typeof RESEARCH_COLORS)[number]);
    return (
      <Modal title={tr('Colour of "{title}"', { title: dlg.research.title })} onClose={onClose}>
        <div className="research-swatches" data-testid="research-colours">
          {RESEARCH_COLORS.map((c, i) => (
            <button key={c} className={`research-swatch${now === i ? ' on' : ''}`} style={{ background: c }} aria-label={`${tr('Colour')} ${i + 1}`} aria-pressed={now === i} disabled={busy} onClick={() => run(() => changeResearch(dlg.research.id, (d) => ({ ...d, color: i })))} data-testid="research-swatch" />
          ))}
        </div>
        {error ? <div className="error-text">{error}</div> : null}
      </Modal>
    );
  }
  if (dlg.kind === 'rename')
    return (
      <Modal title={tr('Rename the research')} onClose={onClose}>
        <div className="field">
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && run(() => changeResearch(dlg.research.id, (d) => ({ ...d, title: title.trim() })))} data-testid="research-rename-input" />
        </div>
        {error ? <div className="error-text">{error}</div> : null}
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            {tr('Cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={() => run(() => changeResearch(dlg.research.id, (d) => ({ ...d, title: title.trim() })))} data-testid="research-rename-ok">
            {tr('Rename')}
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal title={tasks.length === 1 ? tr('A research from this conversation') : tr('A research from {n} conversations', { n: tasks.length })} onClose={onClose}>
      <div className="muted small" data-testid="research-merge">
        {tasks.map((t) => t.alias).join(', ')}
      </div>
      <div className="field">
        <label>{tr('Title')}</label>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} data-testid="research-merge-title" />
      </div>
      <div className="field">
        <label>{tr('Folder (optional)')}</label>
        <input className="input" value={dir} onChange={(e) => setDir(e.target.value)} placeholder={tr('A folder of the project, e.g. the repository it is about')} data-testid="research-merge-dir" />
      </div>
      <div className="muted small">{tr('A research lead is started: it reads these conversations, lays out the tree and attaches them. They move from this list to the research’s page.')}</div>
      {error ? <div className="error-text">{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {tr('Cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={() => run(() => call('research:fromTasks', { projectId: dlg.projectId, taskIds: dlg.taskIds, title: title.trim(), ...(dir.trim() ? { dir: dir.trim() } : {}) }).then((r) => r.researchId))} data-testid="research-merge-ok">
          {tr('Create')}
        </button>
      </div>
    </Modal>
  );
}
