import type { Task } from '../../shared/types';
import { t } from '../i18n';
import type { TurnChanges } from '../turn-changes';
import { Icon } from './bits';
import { DiffStat } from './Content';
import { SidePanel, type SideFrame } from './SidePanel';

/** The agent's latest turn at a glance: the files it changed, each a click from its diff; and "follow". */
export function ChangesPanel({ task, changes, follow, onFollow, onOpen, frame }: { task: Task; changes: TurnChanges; follow: boolean; onFollow: (on: boolean) => void; onOpen: (path: string, line?: number) => void; frame: SideFrame }) {
  const added = changes.files.reduce((n, f) => n + f.added, 0);
  const removed = changes.files.reduce((n, f) => n + f.removed, 0);
  const rel = (p: string) => (p.startsWith(`${task.cwd}/`) ? p.slice(task.cwd.length + 1) : p);
  return (
    <SidePanel
      title={changes.which === 'current' ? t('Changed this turn') : t('Changed last turn')}
      subtitle={
        <span className="changes-sub">
          {t('{n} files', { n: changes.files.length })} <DiffStat added={added} removed={removed} />
        </span>
      }
      label={t('Changes')}
      testId="changes-panel"
      frame={frame}
      actions={
        <label className="follow-toggle" title={t('Show each file in the preview as the agent changes it')}>
          <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} data-testid="follow-agent" />
          {t('Follow')}
        </label>
      }
    >
      {changes.files.length ? (
        <ul className="changes-list">
          {changes.files.map((f) => (
            <li key={f.path}>
              <button className="changes-item" onClick={() => onOpen(f.path, f.line)} title={f.path} data-testid="changes-item" data-path={f.path}>
                <Icon name={f.operation === 'delete' ? 'trash' : f.operation === 'add' ? 'plus' : 'file'} size={12} />
                <span className="changes-name">{rel(f.path).split('/').pop()}</span>
                <span className="changes-dir mono truncate">{rel(f.path).split('/').slice(0, -1).join('/')}</span>
                <DiffStat added={f.added} removed={f.removed} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{t('No file changes yet.')}</p>
      )}
    </SidePanel>
  );
}
