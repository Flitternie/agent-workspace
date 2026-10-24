import type { WorkspaceSnapshot } from '../../shared/types';
import { call } from '../api';
import { Alias, displayName, Icon, Kbd, PROVIDER_LABEL, STATUS_LABEL } from './bits';

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
}: {
  snapshot: WorkspaceSnapshot;
  focusId: string | null;
  onSelect: (taskId: string) => void;
  onOverview: () => void;
  onNewTask: () => void;
  onResume: () => void;
}) {
  const open = snapshot.attention.filter((a) => a.state === 'open' && a.kind !== 'completion');
  const needYou = new Set(open.map((a) => a.taskId)).size;
  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="brand">
          <span className="brand-mark" aria-hidden>
            <Icon name="grid" size={13} />
          </span>
          Agent Meeting
          {snapshot.demo ? <span className="demo-badge" title="Demo entry: mock agents, separate data (npm run demo)">Demo</span> : null}
        </span>
      </div>

      <button className={`nav-item${focusId ? '' : ' active'}`} onClick={onOverview} title="Overview (⌘0 / Esc)">
        <Icon name="grid" />
        <span>Overview</span>
        {needYou ? <span className="count">{needYou}</span> : null}
      </button>

      <div className="sidebar-section">
        <span>Agents</span>
        <button className="icon-btn" aria-label="New task" title="New task" onClick={onNewTask}>
          <Icon name="plus" />
        </button>
      </div>
      <nav className="agent-list" aria-label="Agents">
        {snapshot.tasks.length === 0 ? <div className="muted small pad-x">No agents yet.</div> : null}
        {snapshot.tasks.map((t, i) => {
          const pending = open.filter((a) => a.taskId === t.taskId);
          return (
            <button
              key={t.taskId}
              className={`agent-row status-${t.status}${t.taskId === focusId ? ' active' : ''}${pending.length ? ' needs' : ''}`}
              onClick={() => onSelect(t.taskId)}
              data-testid="rail-item"
              data-alias={t.alias}
              title={`${displayName(t)} · ${PROVIDER_LABEL[t.provider]} · ${STATUS_LABEL[t.status]}${i < 9 ? ` (⌘${i + 1})` : ''}`}
            >
              <Alias alias={t.alias} size="sm" />
              <span className="agent-row-text">
                <span className="agent-row-name">
                  <span className="truncate">{displayName(t)}</span>
                  <span className={`status status-${t.status}`}>
                    <span className="dot" aria-label={STATUS_LABEL[t.status]} />
                  </span>
                </span>
                <span className="agent-row-sub">{pending.length ? `${pending.length} waiting: ${pending[0].headline}` : t.summary || t.title}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <button className="btn btn-block" onClick={onResume} disabled={!snapshot.projects.length}>
          <Icon name="history" /> Resume session…
        </button>
        <div className="sidebar-section">
          <span>Connections</span>
        </div>
        <div className="conn-list">
          {snapshot.capabilities.map((c) => (
            <span key={c.provider} className={`conn${c.available ? ' on' : ''}`} title={c.detail}>
              <span className="conn-dot" /> {PROVIDER_LABEL[c.provider]}
              {c.version ? <span className="muted"> {c.version.split(' ')[0]}</span> : null}
            </span>
          ))}
          <span className={`conn${snapshot.voice.sttAvailable ? ' on' : ''}`} title={snapshot.voice.sttModel ? `STT ${snapshot.voice.sttModel}, router ${snapshot.voice.routerModel}` : 'No OpenAI key found'}>
            <span className="conn-dot" /> Voice
            {snapshot.voice.sttModel ? <span className="muted"> {snapshot.voice.sttModel}</span> : null}
          </span>
        </div>
        <label className="toggle" title="When off, voice commands that clearly name an agent are sent immediately">
          <input type="checkbox" checked={snapshot.settings.alwaysConfirmVoice} onChange={(e) => void call('settings:update', { alwaysConfirmVoice: e.target.checked })} />
          <span>Confirm every voice send</span>
        </label>
        <div className="tips">
          <div>
            <Kbd>⌘⇧A</Kbd> mute / unmute
          </div>
          <div>
            <Kbd>⌘1–9</Kbd> focus agent · <Kbd>Esc</Kbd> overview
          </div>
        </div>
      </div>
    </aside>
  );
}
