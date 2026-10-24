import { useEffect, useState, type ReactNode } from 'react';
import type { AgentProvider, NativeSessionInfo, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { Icon, PROVIDER_LABEL } from './bits';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ProjectPicker({ snapshot, value, onChange }: { snapshot: WorkspaceSnapshot; value: string; onChange: (id: string) => void }) {
  const [error, setError] = useState('');
  const add = async () => {
    setError('');
    try {
      const dir = await call('project:pickDirectory', {});
      if (!dir) return;
      const p = await call('project:add', { rootPath: dir });
      onChange(p.projectId);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="field">
      <label>Project</label>
      <div className="row">
        <select className="input" value={value} onChange={(e) => onChange(e.target.value)} data-testid="project-select">
          <option value="">Choose…</option>
          {snapshot.projects.map((p) => (
            <option key={p.projectId} value={p.projectId}>
              {p.name} — {p.rootPath}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void add()}>
          Add folder…
        </button>
      </div>
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}

export function NewTaskDialog({ snapshot, onClose, onCreated }: { snapshot: WorkspaceSnapshot; onClose: () => void; onCreated: (taskId: string) => void }) {
  const firstAvailable = (['claude', 'codex', 'mock'] as const).find((p) => snapshot.capabilities.find((c) => c.provider === p)?.available) ?? 'mock';
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.projectId ?? '');
  const [provider, setProvider] = useState<AgentProvider>(firstAvailable);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [isolate, setIsolate] = useState(true);
  const [mockScript, setMockScript] = useState('ask:Should I keep backwards compatibility?');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const project = snapshot.projects.find((p) => p.projectId === projectId);
  const cap = snapshot.capabilities.find((c) => c.provider === provider);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const t = await call('task:create', {
        projectId,
        provider,
        title: title.trim() || instruction.trim().slice(0, 80),
        name: name.trim() || undefined,
        instruction: instruction.trim() || undefined,
        isolate,
        mockScript: provider === 'mock' ? mockScript : undefined,
      });
      onCreated(t.taskId);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New task" onClose={onClose}>
      <ProjectPicker snapshot={snapshot} value={projectId} onChange={setProjectId} />
      <div className="field">
        <label>Agent</label>
        <div className="row">
          {(['claude', 'codex', 'mock'] as const).map((p) => {
            const c = snapshot.capabilities.find((x) => x.provider === p);
            return (
              <label key={p} className={`radio${c?.available ? '' : ' disabled'}${provider === p ? ' selected' : ''}`} title={c?.detail}>
                <input type="radio" name="provider" checked={provider === p} disabled={!c?.available} onChange={() => setProvider(p)} /> {PROVIDER_LABEL[p]}
                {c?.version ? <span className="muted small"> {c.version.split(' ')[0]}</span> : null}
              </label>
            );
          })}
        </div>
        {cap ? <div className="muted small">{cap.detail} Permissions stay with the provider; nothing is auto-approved.</div> : null}
      </div>
      <div className="row">
        <div className="field grow">
          <label>Short name (spoken handle)</label>
          <input className="input" placeholder="e.g. database" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field grow2">
          <label>Task title</label>
          <input className="input" placeholder="e.g. Schema migration for orders" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>First instruction (optional)</label>
        <textarea className="input" rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="What should the agent do?" />
      </div>
      {provider === 'mock' ? (
        <div className="field">
          <label>Mock script</label>
          <input className="input" value={mockScript} onChange={(e) => setMockScript(e.target.value)} />
          <div className="muted small">ask:&lt;question&gt; · approval:&lt;command&gt; · choice:&lt;question&gt; · work</div>
        </div>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={isolate} disabled={!project?.isGitRepo} onChange={(e) => setIsolate(e.target.checked)} />
        Run in its own git worktree {project && !project.isGitRepo ? '(not a git repo — will share the folder)' : '(isolates edits from other tasks; not a security sandbox)'}
      </label>
      {error ? <div className="error-text">{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !projectId || !(title.trim() || instruction.trim())} onClick={() => void create()}>
          {busy ? 'Starting…' : 'Create task'}
        </button>
      </div>
    </Modal>
  );
}

export function ImportDialog({ snapshot, onClose }: { snapshot: WorkspaceSnapshot; onClose: () => void }) {
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.projectId ?? '');
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const [sessions, setSessions] = useState<NativeSessionInfo[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    setSessions(null);
    setError('');
    setBusy(true);
    call('sessions:discover', { projectId, provider })
      .then(setSessions)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, [projectId, provider]);

  return (
    <Modal title="Resume an existing session" onClose={onClose}>
      <p className="muted small">
        Lists conversations the provider has saved for this project. Importing re-enters that conversation (historical resume). It does <strong>not</strong> attach to a
        session that is currently running in another terminal — close that one first to avoid two writers.
      </p>
      <ProjectPicker snapshot={snapshot} value={projectId} onChange={setProjectId} />
      <div className="field">
        <label>Provider</label>
        <div className="row">
          {(['claude', 'codex'] as const).map((p) => (
            <label key={p} className={`radio${provider === p ? ' selected' : ''}`}>
              <input type="radio" checked={provider === p} onChange={() => setProvider(p)} /> {PROVIDER_LABEL[p]}
            </label>
          ))}
        </div>
      </div>
      {busy ? <div className="muted">Looking for sessions…</div> : null}
      {error ? <div className="error-text">{error}</div> : null}
      {sessions && sessions.length === 0 ? <div className="muted">No un-imported sessions found for this folder.</div> : null}
      <div className="session-list">
        {sessions?.map((s) => (
          <div key={s.nativeSessionId} className="session-row">
            <div>
              <div>{s.title}</div>
              <div className="muted small">
                {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''} · <code>{s.nativeSessionId.slice(0, 13)}…</code>
              </div>
            </div>
            <button
              className="btn"
              onClick={() =>
                call('task:importSession', { projectId, provider, nativeSessionId: s.nativeSessionId, cwd: s.cwd, title: s.title })
                  .then(onClose)
                  .catch((e) => setError(errorText(e)))
              }
            >
              Import
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
