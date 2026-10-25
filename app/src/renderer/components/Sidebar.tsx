import type { WorkspaceSnapshot } from '../../shared/types';
import { Alias, displayName, Icon, Kbd, PROVIDER_LABEL, STATUS_LABEL } from './bits';
import { t as tr } from '../i18n';

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
}: {
  snapshot: WorkspaceSnapshot;
  focusId: string | null;
  onSelect: (taskId: string) => void;
  onOverview: () => void;
  onNewTask: () => void;
  onResume: () => void;
  onSettings: () => void;
  settingsOpen?: boolean;
}) {
  const open = snapshot.attention.filter((a) => a.state === 'open' && a.kind !== 'completion');
  const needYou = new Set(open.map((a) => a.taskId)).size;
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

      <div className="sidebar-section">
        <span>{tr('Agents')}</span>
        <button className="icon-btn" aria-label={tr('New task')} title={tr('New task')} onClick={onNewTask}>
          <Icon name="plus" />
        </button>
      </div>
      <nav className="agent-list" aria-label="Agents">
        {snapshot.tasks.length === 0 ? <div className="muted small pad-x">{tr('No agents yet.')}</div> : null}
        {snapshot.tasks.map((t, i) => {
          const pending = open.filter((a) => a.taskId === t.taskId);
          return (
            <button
              key={t.taskId}
              className={`agent-row status-${t.status}${t.taskId === focusId ? ' active' : ''}${pending.length ? ' needs' : ''}`}
              onClick={() => onSelect(t.taskId)}
              data-testid="rail-item"
              data-alias={t.alias}
              title={`${displayName(t)} · ${PROVIDER_LABEL[t.provider]} · ${tr(STATUS_LABEL[t.status])}${i < 9 ? ` (⌘${i + 1})` : ''}`}
            >
              <Alias alias={t.alias} size="sm" />
              <span className="agent-row-text">
                <span className="agent-row-name">
                  <span className="truncate">{displayName(t)}</span>
                  <span className={`status status-${t.status}`}>
                    <span className="dot" aria-label={tr(STATUS_LABEL[t.status])} />
                  </span>
                </span>
                <span className="agent-row-sub">{pending.length ? tr('{n} waiting: {headline}', { n: pending.length, headline: pending[0].headline }) : (t.summary && tr(t.summary)) || t.title}</span>
              </span>
            </button>
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
            <Kbd>⌘⇧A</Kbd> {tr('mute / unmute')}
          </div>
          <div>
            <Kbd>⌘1–9</Kbd> {tr('focus agent')} · <Kbd>Esc</Kbd> {tr('overview')}
          </div>
        </div>
      </div>
    </aside>
  );
}
