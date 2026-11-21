import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MemoryRecord, Task, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { Icon, isMainAgent } from './bits';
import { Markdown } from './Markdown';
import { Modal } from './Dialogs';
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
    <button className={`memory-chip${open ? ' open' : ''}`} onClick={onToggle} aria-pressed={open} data-testid="memory-chip" title={`${isMainAgent(task) ? t('Memory: user {u}', { u: count(user) }) : t('Memory: project {p} · user {u}', { p: count(project), u: count(user) })}`}>
      <Icon name="note" size={11} />
      {/* Narrow headers show the counts only (the full words are in the tooltip). */}
      <span className="chip-full">{isMainAgent(task) ? t('Memory: user {u}', { u: count(user) }) : t('Memory: project {p} · user {u}', { p: count(project), u: count(user) })}</span>
      <span className="chip-short">{isMainAgent(task) ? count(user) : count(project) + count(user)}</span>
    </button>
  );
}

/**
 * The side column's memory view: the notes this agent works with, this project's first,
 * one title each; a note opens rendered as Markdown. Read-only (manage in Settings).
 * Same frame as the other side panels (header row, width, drag bar).
 */
export function AgentMemoryPanel({ snapshot, task, frame }: { snapshot: WorkspaceSnapshot; task: Task; frame: SideFrame }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { project, user, started } = sessionMemory(snapshot, task);
  const projectName = snapshot.projects.find((p) => p.projectId === task.projectId)?.name ?? '';
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const shownProject = isMainAgent(task) ? [] : project;
  const total = shownProject.length + user.length;
  const later = [...shownProject, ...user].filter((x) => !x.on).length;
  const list = (items: Array<{ m: MemoryRecord; on: boolean }>) =>
    items.map(({ m, on }) => (
      <div key={m.id} className={`am-note${on ? '' : ' later'}${open.has(m.id) ? ' open' : ''}`} data-testid="agent-memory-note">
        <button className="am-note-head" onClick={() => toggle(m.id)} aria-expanded={open.has(m.id)}>
          <Icon name="chevron" size={11} />
          <span className="am-note-title">{lineOf(m)}</span>
          {on ? null : (
            <span className="memory-pop-later" title={started ? t('Added or changed after this session started: it works from the next start.') : t('Loaded when the session starts.')}>
              {started ? t('next start') : t('at start')}
            </span>
          )}
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
      title={t('Memory')}
      subtitle={<bdi>{total ? (later ? t('{n} notes · {later} from the next start', { n: total, later }) : t('{n} notes · loaded at start', { n: total })) : t('No notes yet')}</bdi>}
      label={t('The memory this agent works with')}
      testId="agent-memory"
      frame={frame}
      actions={
        <button className="icon-btn" title={t('Memory settings')} aria-label={t('Memory settings')} onClick={() => openSettings('memory')}>
          <Icon name="gear" size={13} />
        </button>
      }
    >
      {total === 0 ? (
        <div className="side-empty" data-testid="agent-memory-empty">
          <span className="side-empty-icon">
            <Icon name="remember" size={18} />
          </span>
          <div className="side-empty-title">{t('No memory yet')}</div>
          <p>{t('Right-click one of your messages and choose “Keep as memory”. Notes are given to every agent from its next start.')}</p>
          <button className="btn btn-sm" onClick={() => openSettings('memory')}>
            {t('Memory settings')}
          </button>
        </div>
      ) : (
        <>
          {shownProject.length ? (
            <section className="am-section">
              <div className="section-label">
                {t('This project')} · {projectName} <span className="count-muted">{shownProject.length}</span>
              </div>
              {list(shownProject)}
            </section>
          ) : null}
          {user.length ? (
            <section className="am-section">
              <div className="section-label">
                {t('User memory')} <span className="count-muted">{user.length}</span>
              </div>
              {list(user)}
            </section>
          ) : null}
        </>
      )}
    </SidePanel>
  );
}

type Draft = Awaited<ReturnType<typeof call<'memory:distill'>>>;

/**
 * On the user's own message (hover, or right-click): keep what it says as memory. Not the
 * words as typed: a note drafted from the message and the conversation around it, which
 * the user checks, edits, files as user or project memory, and saves.
 */
export function RememberButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="remember-btn" onClick={onClick} data-testid="remember" title={t('Keep as memory')} aria-label={t('Keep as memory…')}>
      <Icon name="remember" size={13} />
    </button>
  );
}

export function RememberDialog({ task, itemId, snapshot, onClose }: { task: Task; itemId: string; snapshot: WorkspaceSnapshot; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<'update' | 'new'>('update');
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  /** Saved: who it reaches from their next message, and telling the idle ones now. */
  const [saved, setSaved] = useState<{ id: string; reach: Array<{ taskId: string; alias: string; idle: boolean }>; told?: number } | null>(null);
  const canProject = !isMainAgent(task) && !!task.projectId;
  const projectName = snapshot.projects.find((p) => p.projectId === task.projectId)?.name ?? '';
  useEffect(() => {
    let live = true;
    setDraft(null);
    setError('');
    call('memory:distill', { taskId: task.taskId, itemId }).then(
      (d) => {
        if (!live) return;
        setDraft(d);
        setTitle(d.title);
        setBody(d.body);
        setScope(d.scope === 'project' && canProject ? 'project' : 'global');
        setTarget(d.similar ? 'update' : 'new');
        setEditing(!!d.fallback);
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [task.taskId, itemId, round]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      let id: string;
      if (draft?.similar && target === 'update') {
        await call('memory:update', { id: draft.similar.id, title: title.trim() || undefined, body: body.trim() });
        id = draft.similar.id;
      } else id = (await call('memory:add', { scope, scopeId: scope === 'project' ? task.projectId : 'global', title: title.trim() || undefined, body: body.trim(), originTaskId: isMainAgent(task) ? undefined : task.taskId, approvedForReuse: true })).id;
      // Where it takes effect: the agents it reaches with their next message (this one included).
      const reach = await call('memory:reach', { id }).catch(() => []);
      if (reach.length) {
        setSaved({ id, reach });
        setBusy(false);
      } else onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return createPortal(
    <Modal title={t('Keep as memory')} onClose={onClose}>
      <div className="remember-dialog" data-testid="remember-dialog">
        {saved ? (
          <div className="remember-saved" data-testid="remember-saved">
            <p>
              <Icon name="check" size={13} /> {t('Kept. It reaches {names} with their next message.', { names: saved.reach.map((r) => r.alias).join(t(', ')) })}
            </p>
            {saved.told !== undefined ? <p className="muted small">{t('Told {n} idle agents now.', { n: saved.told })}</p> : null}
            <div className="row">
              {saved.told === undefined && saved.reach.some((r) => r.idle) ? (
                <button
                  className="btn"
                  disabled={busy}
                  data-testid="remember-tell-now"
                  title={t('Each idle agent gets a short message now (it starts a turn)')}
                  onClick={() => {
                    setBusy(true);
                    void call('memory:tellNow', { id: saved.id })
                      .then((n) => setSaved({ ...saved, told: n }))
                      .catch((e) => setError(errorText(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t('Tell the idle ones now')}
                </button>
              ) : null}
              <button className="btn btn-primary" onClick={onClose} data-testid="remember-done">
                {t('Got it')}
              </button>
            </div>
          </div>
        ) : null}
        {saved ? null : !draft && !error ? (
          <div className="remember-loading" data-testid="remember-loading">
            <div className="skeleton w60" />
            <div className="skeleton" />
            <div className="skeleton w80" />
            <div className="muted small">
              <Icon name="spark" size={12} /> {t('Reading your message and the conversation around it…')}
            </div>
          </div>
        ) : null}
        {draft && !saved ? (
          <>
            {draft.fallback ? <div className="warn-text small">{t(draft.fallback)}</div> : null}
            {!draft.worth && !draft.fallback ? (
              <div className="remember-note small">
                <Icon name="alert" size={12} /> {t('This looks like a one-off instruction for this task, not something to keep:')} {draft.reason}
              </div>
            ) : null}

            <div className="scope-cards" role="radiogroup" aria-label={t('Where to keep it')}>
              <button role="radio" aria-checked={scope === 'global'} className={scope === 'global' ? 'on' : ''} onClick={() => setScope('global')} data-testid="remember-scope-user">
                <strong>{t('User memory')}</strong>
                <span>{t('every project, every agent')}</span>
              </button>
              <button role="radio" aria-checked={scope === 'project'} disabled={!canProject} className={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')} data-testid="remember-scope-project">
                <strong>{t('Project memory')}</strong>
                <span>{canProject ? projectName : t('not for the main agent')}</span>
              </button>
            </div>

            <input className="input remember-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('A short title')} data-testid="remember-title" />

            <div className="remember-body">
              <div className="remember-body-head">
                <span className="section-label">{t('The note')}</span>
                <button className="link small" onClick={() => setEditing(!editing)} data-testid="remember-edit">
                  {editing ? t('Preview') : t('Edit')}
                </button>
              </div>
              {editing ? (
                <textarea className="input" rows={Math.min(14, Math.max(5, body.split('\n').length + 1))} value={body} onChange={(e) => setBody(e.target.value)} data-testid="remember-body" />
              ) : (
                <div className="remember-preview" onDoubleClick={() => setEditing(true)} data-testid="remember-preview">
                  <Markdown text={body} />
                </div>
              )}
            </div>

            {draft.reason && draft.worth ? (
              <div className="remember-why small">
                <Icon name="spark" size={12} /> {draft.reason}
              </div>
            ) : null}

            {draft.similar ? (
              <div className="remember-similar" data-testid="remember-similar">
                <div className="small">
                  {t('Close to a note you already have:')} <strong>{draft.similar.title}</strong>
                </div>
                <div className="segmented small-seg" role="radiogroup">
                  <button role="radio" aria-checked={target === 'update'} className={target === 'update' ? 'on' : ''} onClick={() => setTarget('update')} data-testid="remember-update">
                    {t('Update that note')}
                  </button>
                  <button role="radio" aria-checked={target === 'new'} className={target === 'new' ? 'on' : ''} onClick={() => setTarget('new')} data-testid="remember-new">
                    {t('Keep as a new note')}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {error ? <div className="error-text small">{error}</div> : null}
        <div className="modal-foot remember-foot">
          <button className="btn btn-ghost" disabled={!draft || busy} onClick={() => setRound((n) => n + 1)} data-testid="remember-redo">
            <Icon name="refresh" size={12} /> {t('Draft again')}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn btn-primary" disabled={!draft || busy || !body.trim()} onClick={() => void save()} data-testid="remember-save">
            {draft?.similar && target === 'update' ? t('Update note') : t('Save')}
          </button>
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
