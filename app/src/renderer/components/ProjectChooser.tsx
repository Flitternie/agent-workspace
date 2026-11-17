import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeSessionInfo, Project, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { timeAgo } from '../state';
import { Icon, PROVIDER_LABEL } from './bits';

// Where a new agent works, picked the way VS Code's "Open Recent" and Zed's project picker do it: the
// folder shows as a button (the one used last, most of the time the right one). Opening it asks first
// where: this Mac or one of the SSH machines (tabs). For that place, one searchable list: the projects
// already added there (most recently used first), the folders where Claude Code or Codex sessions
// already ran there, and a way to add any other folder (a folder dialog here, a path on a machine).
// Keyboard throughout.

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

type Item = { kind: 'project'; project: Project } | { kind: 'found'; found: Found } | { kind: 'browse' };

export function ProjectChooser({ snapshot, value, onChange }: { snapshot: WorkspaceSnapshot; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  /** Where: '' = this Mac, else an SSH host. */
  const [place, setPlace] = useState('');
  /** Folders where sessions ran, per place (null while being read). */
  const [found, setFound] = useState<Record<string, Found[] | null>>({});
  /** A path typed for the current machine. */
  const [remotePath, setRemotePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const selected = snapshot.projects.find((p) => p.projectId === value);
  const agentsIn = (p: Project) => snapshot.tasks.filter((t) => t.projectId === p.projectId).length;

  const hostInfo = snapshot.remoteHosts.find((h) => h.host === place);
  const reachable = !place || hostInfo?.ssh === 'ok';
  // Folders where sessions already ran in this place, read the first time it is shown.
  useEffect(() => {
    if (!open || place in found || !reachable) return;
    setFound((f) => ({ ...f, [place]: null }));
    const read = place ? call('sessions:discoverHost', { host: place }) : call('sessions:discoverAll', {});
    void read
      .then((all: NativeSessionInfo[]) => {
        const by = new Map<string, Found>();
        for (const s of all) {
          if (s.automated || (s.host ?? '') !== place || !s.cwd) continue;
          const f = by.get(s.cwd) ?? { cwd: s.cwd, sessions: 0, providers: [], updatedAt: 0 };
          f.sessions++;
          if (!f.providers.includes(s.provider)) f.providers.push(s.provider);
          f.updatedAt = Math.max(f.updatedAt, ms(s.updatedAt));
          by.set(s.cwd, f);
        }
        setFound((f) => ({ ...f, [place]: [...by.values()].sort((a, b) => b.updatedAt - a.updatedAt) }));
      })
      .catch(() => setFound((f) => ({ ...f, [place]: [] })));
  }, [open, place, found, reachable]);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && toggle(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const here = snapshot.projects.filter((p) => (p.host ?? '') === place);
    const known = new Set(here.map((p) => p.rootPath));
    // Agents' own worktrees are not projects to start from.
    const inWorktree = (cwd: string) => snapshot.tasks.some((t) => t.worktree && (cwd === t.worktree.path || cwd.startsWith(`${t.worktree.path}/`)));
    const projects = [...here]
      .sort((a, b) => lastUsed(snapshot, b) - lastUsed(snapshot, a))
      .filter((p) => matches(query, `${p.name} ${p.host ?? ''} ${p.rootPath}`))
      .map((project) => ({ kind: 'project' as const, project }));
    const folders = (found[place] ?? [])
      .filter((f) => !known.has(f.cwd) && !inWorktree(f.cwd) && matches(query, f.cwd))
      .slice(0, 12)
      .map((f) => ({ kind: 'found' as const, found: f }));
    // Any other folder: a folder dialog on this Mac; on a machine, the path box under the list.
    return [...projects, ...folders, ...(place ? [] : [{ kind: 'browse' as const }])];
  }, [snapshot, found, query, place]);

  useEffect(() => setActive(0), [query, open]);
  // Opened or closed: a fresh search and no half-typed remote path next time (reset right away, so
  // typing straight after opening is never appended to the previous search).
  const toggle = (next: boolean) => {
    setQuery('');
    setRemotePath('');
    setError('');
    // Opens on the place of the project chosen now.
    if (next) setPlace(selected?.host ?? '');
    setOpen(next);
  };
  const goTo = (p: string) => {
    setPlace(p);
    setQuery('');
    setRemotePath('');
    setError('');
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
        onChange((await call('project:add', { rootPath: it.found.cwd, ...(place ? { host: place } : {}) })).projectId);
      } else {
        const dir = await call('project:pickDirectory', {});
        if (!dir) return;
        setBusy(true);
        onChange((await call('project:add', { rootPath: dir })).projectId);
      }
      toggle(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const addRemote = async () => {
    if (!place || !remotePath.trim()) return;
    setError('');
    setBusy(true);
    try {
      onChange((await call('project:add', { rootPath: remotePath.trim(), host: place })).projectId);
      toggle(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const places = [{ key: '', label: t('This Mac') }, ...snapshot.remoteHosts.map((h) => ({ key: h.host, label: h.host }))];
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(items.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter') void choose(items[active]);
    else if (e.key === 'Escape') toggle(false);
    // Tab moves between this Mac and the machines.
    else if (e.key === 'Tab' && places.length > 1) {
      const i = places.findIndex((p) => p.key === place);
      goTo(places[(i + (e.shiftKey ? places.length - 1 : 1)) % places.length].key);
    } else return;
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
        {selected ? <span className="tag">{selected.host ?? t('This Mac')}</span> : null}
        <Icon name="chevron" size={11} />
      </button>
      {open ? (
        // Esc here closes this list, not the dialog around it.
        <div className="project-pop" data-own-esc data-testid="project-pop">
          {/* First: where. This Mac, or a machine turned on in Settings › Remote machines. */}
          {places.length > 1 ? (
            <div className="seg project-places" role="tablist">
              {places.map((pl) => {
                const h = snapshot.remoteHosts.find((x) => x.host === pl.key);
                return (
                  <button key={pl.key || 'local'} role="tab" type="button" aria-selected={place === pl.key} className={place === pl.key ? 'on' : ''} onClick={() => goTo(pl.key)} data-testid="project-place" data-place={pl.key || 'local'}>
                    <Icon name={pl.key ? 'globe' : 'folder'} size={12} /> {pl.label}
                    {h && h.ssh !== 'ok' ? <span className="dot-warn" aria-hidden /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          <input className="input project-search" autoFocus placeholder={place ? t('Search projects and folders on {host}…', { host: place }) : t('Search projects and folders…')} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={keys} data-testid="project-search" />
          {place && !reachable ? <div className="warn-text small">{t('{host} is not connected. Check it in Settings › Remote machines.', { host: place })}</div> : null}
          <div className="project-list" ref={list} role="listbox">
            {items.map((it, i) => (
              <div key={it.kind === 'project' ? it.project.projectId : it.kind === 'found' ? it.found.cwd : 'browse'}>
                {i === 0 && it.kind === 'project' ? <div className="project-group">{t('Recent')}</div> : null}
                {i === firstFound ? <div className="project-group">{place ? t('Found on {host} (Claude Code / Codex sessions)', { host: place }) : t('Found on this Mac (Claude Code / Codex sessions)')}</div> : null}
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
                  ) : (
                    <>
                      <Icon name="plus" />
                      <span className="project-item-name">{t('Open a folder…')}</span>
                    </>
                  )}
                </button>
              </div>
            ))}
            {reachable && found[place] === null ? <div className="muted small project-loading">{t('Looking for folders with past sessions…')}</div> : null}
            {place && reachable && !items.length && found[place] ? <div className="muted small project-loading">{t('Nothing here yet: type a path below.')}</div> : null}
          </div>
          {place && reachable ? (
            <div className="row project-remote">
              <span className="mono">{place}:</span>
              <input
                className="input grow mono"
                placeholder="~/projects/repo"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void addRemote();
                  }
                  if (e.key === 'Escape') toggle(false);
                }}
                data-testid="remote-path"
              />
              <button className="btn btn-sm" disabled={!remotePath.trim() || busy} onClick={() => void addRemote()} data-testid="remote-add">
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
