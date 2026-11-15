import { useEffect, useRef, useState } from 'react';
import type { MemoryRecord, Task, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { Icon, isMainAgent } from './bits';
import { Markdown } from './Markdown';
import { SidePanel, type SideFrame } from './SidePanel';

// Memory where it matters in an agent's view: which notes this agent works with (a chip
// in its header; this project's notes first, one line each), and saving something the
// user just told it ("Remember" on their message). Managing memory lives in Settings › Memory.

/** Opens Settings at a section (App listens). */
export function openSettings(section?: string): void {
  window.dispatchEvent(new CustomEvent('amw:open-settings', { detail: { section } }));
}

/** A note as one scannable line: its title, else its first line of text. */
const lineOf = (m: MemoryRecord) => (m.title || m.body.replace(/^#{1,6}\s+/, '').split('\n').find((l) => l.trim()) || '').trim();

/**
 * The notes behind this agent, split into this project's and user memory, each marked as
 * working now (loaded when the session started) or from the next start (added or changed
 * since). On a machine whose CLIs share user memory, the CLI reads user memory from its
 * own files at start; those count too.
 */
export function sessionMemory(snapshot: WorkspaceSnapshot, task: Task) {
  const ids = new Set(task.injectedMemoryIds ?? []);
  const started = snapshot.sessions.find((x) => x.localId === task.sessionLocalId)?.createdAt;
  const link = snapshot.memoryShare?.[task.host ?? 'local'];
  const viaFiles = !!link && !link.unlinking;
  const live = (m: MemoryRecord) => m.approvedForReuse && !m.sourceRemoved;
  const isOn = (m: MemoryRecord) => ids.has(m.id) || (viaFiles && m.scope === 'global' && !!started && m.updatedAt <= started);
  const project = snapshot.memory.filter((m) => (m.scope === 'project' && m.scopeId === task.projectId && live(m)) || (m.scope === 'task' && m.scopeId === task.taskId));
  const user = snapshot.memory.filter((m) => m.scope === 'global' && live(m));
  const mark = (list: MemoryRecord[]) => list.map((m) => ({ m, on: isOn(m) })).sort((x, y) => Number(y.on) - Number(x.on));
  return { project: mark(project), user: mark(user), started: !!started };
}

/** In the agent's header: how many notes it works with; opens them in the side column. */
export function MemoryChip({ snapshot, task, open, onToggle }: { snapshot: WorkspaceSnapshot; task: Task; open: boolean; onToggle: () => void }) {
  const { project, user } = sessionMemory(snapshot, task);
  const count = (l: Array<{ on: boolean }>) => l.filter((x) => x.on).length;
  return (
    <button className={`memory-chip${open ? ' open' : ''}`} onClick={onToggle} aria-pressed={open} data-testid="memory-chip" title={t('The memory this agent works with')}>
      <Icon name="note" size={11} /> {isMainAgent(task) ? t('Memory: user {u}', { u: count(user) }) : t('Memory: project {p} · user {u}', { p: count(project), u: count(user) })}
    </button>
  );
}

/**
 * The side column's memory view: the notes this agent works with, this project's first,
 * one title each; a note opens rendered as Markdown. Read-only (manage in Settings).
 */
export function AgentMemoryPanel({ snapshot, task, frame }: { snapshot: WorkspaceSnapshot; task: Task; frame: SideFrame }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { project, user, started } = sessionMemory(snapshot, task);
  const projectName = snapshot.projects.find((p) => p.projectId === task.projectId)?.name ?? '';
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const list = (items: Array<{ m: MemoryRecord; on: boolean }>) =>
    items.map(({ m, on }) => (
      <div key={m.id} className={`am-note${on ? '' : ' later'}${open.has(m.id) ? ' open' : ''}`} data-testid="agent-memory-note">
        <button className="am-note-head" onClick={() => toggle(m.id)} aria-expanded={open.has(m.id)}>
          <Icon name="chevron" size={11} />
          <span className="am-note-title">{lineOf(m)}</span>
          {on ? null : <span className="memory-pop-later">{started ? t('from the next start') : t('when it starts')}</span>}
        </button>
        {open.has(m.id) ? (
          <div className="am-note-body">
            <Markdown text={m.body} />
          </div>
        ) : null}
      </div>
    ));
  return (
    <SidePanel
      label={t('The memory this agent works with')}
      testId="agent-memory"
      frame={frame}
      title={t('This agent’s memory')}
    >
      <p className="muted small">{t('Loaded when the session starts or resumes. Notes added or changed since then work from the next start.')}</p>
      {isMainAgent(task) ? null : (
        <section className="am-section">
          <div className="section-label">
            {t('This project')} · {projectName} <span className="count-muted">{project.length}</span>
          </div>
          {project.length ? list(project) : <div className="muted small">{t('No notes for this project yet. To add one, use “Remember › For this project” on one of your messages.')}</div>}
        </section>
      )}
      <section className="am-section">
        <div className="section-label">
          {t('User memory')} · {t('every project')} <span className="count-muted">{user.length}</span>
        </div>
        {user.length ? list(user) : <div className="muted small">{t('None yet.')}</div>}
      </section>
      <button className="link small am-manage" onClick={() => openSettings('memory')}>
        {t('Manage in Settings')}
      </button>
    </SidePanel>
  );
}

/**
 * On the user's own message: keep it as memory, for every agent (user memory) or for
 * this project. The moment to remember something is when the user just said it.
 */
export function RememberButton({ text, task }: { text: string; task: Task }) {
  const [menu, setMenu] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [menu]);
  const body = text.trim().slice(0, 4000);
  if (!body) return null;
  const save = (scope: 'global' | 'project') => {
    setMenu(false);
    setError('');
    call('memory:add', { scope, scopeId: scope === 'project' ? task.projectId : 'global', body, originTaskId: isMainAgent(task) ? undefined : task.taskId, approvedForReuse: true }).then(
      () => {
        setDone(scope === 'project' ? t('Remembered for this project') : t('Remembered for every agent'));
        setTimeout(() => setDone(null), 2500);
      },
      (e) => setError(errorText(e)),
    );
  };
  return (
    <span className={`remember${menu || done || error ? ' shown' : ''}`} ref={ref}>
      {done ? (
        <span className="remember-done" data-testid="remember-done">
          <Icon name="check" size={11} /> {done}
        </span>
      ) : (
        <button className="link small remember-btn" onClick={() => setMenu(!menu)} data-testid="remember" title={t('Keep this as memory for future agents')}>
          <Icon name="note" size={11} /> {t('Remember')}
        </button>
      )}
      {menu ? (
        <span className="remember-menu" data-testid="remember-menu">
          {isMainAgent(task) || !task.projectId ? null : (
            <button onClick={() => save('project')} data-testid="remember-project">
              <strong>{t('For this project')}</strong>
              <span className="muted small">{t('Project memory: agents working in this project')}</span>
            </button>
          )}
          <button onClick={() => save('global')} data-testid="remember-user">
            <strong>{t('For every agent')}</strong>
            <span className="muted small">{t('User memory: all projects, Claude Code and Codex, every machine')}</span>
          </button>
        </span>
      ) : null}
      {error ? <span className="error-text small">{error}</span> : null}
    </span>
  );
}
