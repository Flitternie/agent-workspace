import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeSessionInfo, Project, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { timeAgo } from '../state';
import { Icon, PROVIDER_LABEL } from './bits';

// Where a new agent works, picked the way VS Code's "Open Recent" and Zed's project picker do it: the
// folder shows as a button (the one used last, most of the time the right one); opening it gives one
// searchable list of the projects already added (most recently used first, this Mac and SSH machines
// together), the folders on this Mac where Claude Code or Codex sessions already ran, and the actions
// for anything else (a folder dialog, a folder on a remote machine). Keyboard throughout.

const ms = (iso?: string) => (iso ? Date.parse(iso) || 0 : 0);
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
/** A home-folder path the short way (~/…). */
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^\/home\/[^/]+(?=\/|$)/, '~');

/** When a project was last used: its agents' latest activity, else when it was added. */
export function lastUsed(snapshot: WorkspaceSnapshot, p: Project): number {
  const times = snapshot.tasks.filter((t) => t.projectId === p.projectId).map((t) => Math.max(ms(t.lastUserActivityAt), ms(t.createdAt)));
  return Math.max(ms(p.createdAt), ...times, 0);
}

/** The project to offer first: the one used most recently. */
export function defaultProject(snapshot: WorkspaceSnapshot): string {
  return [...snapshot.projects].sort((a, b) => lastUsed(snapshot, b) - lastUsed(snapshot, a))[0]?.projectId ?? '';
}

/** Every word of the query somewhere in the text (case-insensitive). */
const matches = (q: string, text: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w));

interface Found {
  cwd: string;
  sessions: number;
  providers: string[];
  updatedAt: number;
}

type Item =
  | { kind: 'project'; project: Project }
  | { kind: 'found'; found: Found }
  | { kind: 'browse' }
  | { kind: 'remote'; host: string };

export function ProjectChooser({ snapshot, value, onChange }: { snapshot: WorkspaceSnapshot; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<Found[] | null>(null);
  const [remote, setRemote] = useState<{ host: string; path: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const selected = snapshot.projects.find((p) => p.projectId === value);
  const agentsIn = (p: Project) => snapshot.tasks.filter((t) => t.projectId === p.projectId).length;

  // Folders where sessions already ran on this Mac, read once the list first opens.
  useEffect(() => {
    if (!open || found) return;
    void call('sessions:discoverAll', {})
      .then((all: NativeSessionInfo[]) => {
        const by = new Map<string, Found>();
        for (const s of all) {
          if (s.automated || s.host || !s.cwd) continue;
          const f = by.get(s.cwd) ?? { cwd: s.cwd, sessions: 0, providers: [], updatedAt: 0 };
          f.sessions++;
          if (!f.providers.includes(s.provider)) f.providers.push(s.provider);
          f.updatedAt = Math.max(f.updatedAt, ms(s.updatedAt));
          by.set(s.cwd, f);
        }
        setFound([...by.values()].sort((a, b) => b.updatedAt - a.updatedAt));
      })
      .catch(() => setFound([]));
  }, [open, found]);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && toggle(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const known = new Set(snapshot.projects.filter((p) => !p.host).map((p) => p.rootPath));
    // Agents' own worktrees are not projects to start from.
    const inWorktree = (cwd: string) => snapshot.tasks.some((t) => t.worktree && (cwd === t.worktree.path || cwd.startsWith(`${t.worktree.path}/`)));
    const projects = [...snapshot.projects]
      .sort((a, b) => lastUsed(snapshot, b) - lastUsed(snapshot, a))
      .filter((p) => matches(query, `${p.name} ${p.host ?? ''} ${p.rootPath}`))
      .map((project) => ({ kind: 'project' as const, project }));
    const folders = (found ?? [])
      .filter((f) => !known.has(f.cwd) && !inWorktree(f.cwd) && matches(query, f.cwd))
      .slice(0, 12)
      .map((f) => ({ kind: 'found' as const, found: f }));
    const hosts = snapshot.remoteHosts.map((h) => ({ kind: 'remote' as const, host: h.host }));
    return [...projects, ...folders, { kind: 'browse' as const }, ...hosts];
  }, [snapshot, found, query]);

  useEffect(() => setActive(0), [query, open]);
  // Opened or closed: a fresh search and no half-typed remote path next time (reset right away, so
  // typing straight after opening is never appended to the previous search).
  const toggle = (next: boolean) => {
    setQuery('');
    setRemote(null);
    setError('');
    setOpen(next);
  };
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = async (it: Item) => {
    setError('');
    try {
      if (it.kind === 'project') onChange(it.project.projectId);
      else if (it.kind === 'found') {
        setBusy(true);
        onChange((await call('project:add', { rootPath: it.found.cwd })).projectId);
      } else if (it.kind === 'browse') {
        const dir = await call('project:pickDirectory', {});
        if (!dir) return;
        setBusy(true);
        onChange((await call('project:add', { rootPath: dir })).projectId);
      } else {
        setRemote({ host: it.host, path: '' });
        return;
      }
      toggle(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const addRemote = async () => {
    if (!remote?.path.trim()) return;
    setError('');
    setBusy(true);
    try {
      onChange((await call('project:add', { rootPath: remote.path.trim(), host: remote.host })).projectId);
      toggle(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(items.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter') void choose(items[active]);
    else if (e.key === 'Escape') toggle(false);
    else return;
    e.preventDefault();
  };

  const firstFound = items.findIndex((i) => i.kind === 'found');
  const firstAction = items.findIndex((i) => i.kind === 'browse');
  const where = (p: Project) => `${p.host ? `${p.host}:` : ''}${tilde(p.rootPath)}`;

  return (
    <div className="field project-chooser" ref={box}>
      <label>{t('Project')}</label>
      <button type="button" className={`project-current${open ? ' open' : ''}`} onClick={() => toggle(!open)} aria-expanded={open} data-testid="project-current">
        <Icon name="folder" />
        {selected ? (
          <span className="project-current-text">
            <span className="project-current-name">{selected.name}</span>
            <span className="project-current-path mono truncate">{where(selected)}</span>
          </span>
        ) : (
          <span className="muted">{t('Choose a project…')}</span>
        )}
        {selected?.host ? <span className="tag">{selected.host}</span> : null}
        <Icon name="chevron" size={11} />
      </button>
      {open ? (
        // Esc here closes this list, not the dialog around it.
        <div className="project-pop" data-own-esc data-testid="project-pop">
          <input className="input project-search" autoFocus placeholder={t('Search projects and folders…')} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={keys} data-testid="project-search" />
          <div className="project-list" ref={list} role="listbox">
            {items.map((it, i) => (
              <div key={it.kind === 'project' ? it.project.projectId : it.kind === 'found' ? it.found.cwd : it.kind === 'remote' ? `r:${it.host}` : 'browse'}>
                {i === 0 && it.kind === 'project' ? <div className="project-group">{t('Recent')}</div> : null}
                {i === firstFound ? <div className="project-group">{t('Found on this Mac (Claude Code / Codex sessions)')}</div> : null}
                {i === firstAction ? <div className="project-group">{t('Other folders')}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`project-item${i === active ? ' active' : ''}${it.kind === 'project' && it.project.projectId === value ? ' current' : ''}`}
                  data-index={i}
                  data-kind={it.kind}
                  data-testid="project-item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void choose(it)}
                  disabled={busy}
                >
                  {it.kind === 'project' ? (
                    <>
                      <Icon name="folder" />
                      <span className="project-item-text">
                        <span className="project-item-name">
                          {it.project.name}
                          {it.project.host ? <span className="tag">{it.project.host}</span> : null}
                        </span>
                        <span className="project-item-path mono truncate">{where(it.project)}</span>
                      </span>
                      <span className="muted small">{agentsIn(it.project) === 1 ? t('1 agent') : t('{n} agents', { n: agentsIn(it.project) })}</span>
                      {it.project.projectId === value ? <Icon name="check" size={12} /> : null}
                    </>
                  ) : it.kind === 'found' ? (
                    <>
                      <Icon name="history" />
                      <span className="project-item-text">
                        <span className="project-item-name">{base(it.found.cwd)}</span>
                        <span className="project-item-path mono truncate">{tilde(it.found.cwd)}</span>
                      </span>
                      <span className="muted small">
                        {it.found.providers.map((p) => PROVIDER_LABEL[p as keyof typeof PROVIDER_LABEL] ?? p).join(' · ')} · {it.found.sessions === 1 ? t('1 session') : t('{n} sessions', { n: it.found.sessions })}
                        {it.found.updatedAt ? ` · ${timeAgo(new Date(it.found.updatedAt).toISOString(), now)}` : ''}
                      </span>
                    </>
                  ) : it.kind === 'browse' ? (
                    <>
                      <Icon name="plus" />
                      <span className="project-item-name">{t('Open a folder…')}</span>
                    </>
                  ) : (
                    <>
                      <Icon name="globe" />
                      <span className="project-item-name">{t('A folder on {host}…', { host: it.host })}</span>
                    </>
                  )}
                </button>
              </div>
            ))}
            {found === null ? <div className="muted small project-loading">{t('Looking for folders with past sessions…')}</div> : null}
          </div>
          {remote ? (
            <div className="row project-remote">
              <span className="mono">{remote.host}:</span>
              <input
                className="input grow mono"
                autoFocus
                placeholder="~/projects/repo"
                value={remote.path}
                onChange={(e) => setRemote({ ...remote, path: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addRemote();
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setRemote(null);
                  }
                }}
                data-testid="remote-path"
              />
              <button className="btn btn-sm" disabled={!remote.path.trim() || busy} onClick={() => void addRemote()}>
                {busy ? t('Connecting…') : t('Add')}
              </button>
            </div>
          ) : null}
          {error ? <div className="error-text small">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
