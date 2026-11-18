import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeSessionInfo, Project, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { timeAgo } from '../state';
import { Icon, PROVIDER_LABEL } from './bits';

// Where a new agent works, in two steps, the way VS Code's "Open Recent" and Zed's project picker
// feel: the project shows as a button (the one used last, most of the time the right one). Opening it
// asks first where: this Mac or one of the machines turned on in Settings › Remote machines (a
// searchable list, however many there are). Then, for that place, the folder: its projects (most
// recently used first), the folders where Claude Code or Codex sessions already ran there, or any
// folder by typing its path (~/… or /…) with completion, listed on that machine over SSH as typed.
// Keyboard throughout; Backspace in an empty box goes back to the places.

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

/**
 * A Chinese input method in its own punctuation mode types ～ for ~ and 、 for /: a path typed that way
 * is still a path (only when it starts like one; 、 inside a search for words stays as typed).
 */
export function asPath(q: string): string {
  return /^[～~、/]/.test(q) ? q.replace(/^～/, '~').replace(/、/g, '/') : q;
}

/** A typed path (~… or /…): the folder to list and the start of the name being typed. */
export function splitTyped(raw: string): { parent: string; prefix: string } | null {
  const q = asPath(raw);
  if (!/^[~/]/.test(q)) return null;
  if (q === '~') return { parent: '~/', prefix: '' };
  const cut = q.lastIndexOf('/') + 1;
  return { parent: q.slice(0, cut), prefix: q.slice(cut) };
}

interface Found {
  cwd: string;
  sessions: number;
  providers: string[];
  updatedAt: number;
}

type Item =
  | { kind: 'place'; key: string }
  | { kind: 'project'; project: Project }
  | { kind: 'found'; found: Found }
  | { kind: 'browse' }
  | { kind: 'dir'; path: string; name: string }
  | { kind: 'use'; path: string };

export function ProjectChooser({ snapshot, value, onChange }: { snapshot: WorkspaceSnapshot; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'place' | 'folder'>('place');
  /** Where: '' = this Mac, else an SSH host. */
  const [place, setPlace] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  /** Folders where sessions ran, per place (null while being read). */
  const [found, setFound] = useState<Record<string, Found[] | null>>({});
  /** Subfolder names per listed folder ("place\nfolder"), null while being read. */
  const [dirs, setDirs] = useState<Record<string, string[] | null>>({});
  const [dirError, setDirError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const now = Date.now();
  const selected = snapshot.projects.find((p) => p.projectId === value);
  const agentsIn = (p: Project) => snapshot.tasks.filter((t) => t.projectId === p.projectId).length;
  const hostOf = (key: string) => snapshot.remoteHosts.find((h) => h.host === key);
  const reachable = !place || hostOf(place)?.ssh === 'ok';
  const placeLabel = (key: string) => key || t('This Mac');
  const typed = stage === 'folder' ? splitTyped(query) : null;
  const dirKey = typed ? `${place}\n${typed.parent}` : '';

  // Opened or closed: reset right away (typing straight after opening never lands on the old search).
  // A project chosen already: straight to its place's folders; none: the places first.
  const toggle = (next: boolean) => {
    setQuery('');
    setError('');
    setDirError('');
    if (next) {
      setPlace(selected?.host ?? '');
      setStage(selected ? 'folder' : 'place');
    }
    setOpen(next);
  };
  /**
   * The box keeps what is typed itself (React only reads it): a re-render while typing (a folder
   * listing arriving) can then never write an older value back over a keystroke. Changed here only
   * when the app rewrites it (a completion, a fresh search).
   */
  const setText = (v: string) => {
    setQuery(v);
    if (input.current) input.current.value = v;
  };
  const goTo = (key: string) => {
    setPlace(key);
    setStage('folder');
    setText('');
    setError('');
    setDirError('');
    input.current?.focus();
  };
  const back = () => {
    setStage('place');
    setText('');
    setError('');
    input.current?.focus();
  };

  // Folders where sessions already ran in this place, read the first time it is shown.
  useEffect(() => {
    if (!open || stage !== 'folder' || place in found || !reachable) return;
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
  }, [open, stage, place, found, reachable]);

  // A typed path: list its folder (here, or on the machine over SSH), once per folder, shortly after typing.
  useEffect(() => {
    if (!typed || !reachable || dirKey in dirs) return;
    const parent = typed.parent;
    const key = dirKey;
    const id = setTimeout(() => {
      setDirs((d) => ({ ...d, [key]: null }));
      call('fs:listDirs', { dir: parent, ...(place ? { host: place } : {}) })
        .then((r) => {
          setDirError('');
          setDirs((d) => ({ ...d, [key]: r.names }));
        })
        .catch((e) => {
          setDirError(errorText(e));
          setDirs((d) => ({ ...d, [key]: [] }));
        });
    }, 120);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirKey, reachable]);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && toggle(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  });

  const items = useMemo<Item[]>(() => {
    if (stage === 'place') {
      const keys = ['', ...snapshot.remoteHosts.map((h) => h.host)];
      return keys.filter((k) => matches(query, placeLabel(k))).map((key) => ({ kind: 'place' as const, key }));
    }
    if (typed) {
      const names = dirs[dirKey] ?? [];
      const want = typed.prefix.toLowerCase();
      const completions = names
        .filter((n) => n.toLowerCase().startsWith(want) && (want.startsWith('.') || !n.startsWith('.')))
        .slice(0, 60)
        .map((name) => ({ kind: 'dir' as const, name, path: `${typed.parent}${name}/` }));
      const use = query.length > 1 ? query.replace(/\/+$/, '') : query;
      return [{ kind: 'use' as const, path: use }, ...completions];
    }
    const here = snapshot.projects.filter((p) => (p.host ?? '') === place);
    const known = new Set(here.map((p) => p.rootPath));
    // Agents' own worktrees are not projects to start from.
    const inWorktree = (cwd: string) => snapshot.tasks.some((t) => t.worktree && (cwd === t.worktree.path || cwd.startsWith(`${t.worktree.path}/`)));
    const projects = [...here]
      .sort((a, b) => lastUsed(snapshot, b) - lastUsed(snapshot, a))
      .filter((p) => matches(query, `${p.name} ${p.rootPath}`))
      .map((project) => ({ kind: 'project' as const, project }));
    const folders = (found[place] ?? [])
      .filter((f) => !known.has(f.cwd) && !inWorktree(f.cwd) && matches(query, f.cwd))
      .slice(0, 12)
      .map((f) => ({ kind: 'found' as const, found: f }));
    return [...projects, ...folders, ...(place ? [] : [{ kind: 'browse' as const }])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, stage, place, query, found, dirs, dirKey]);

  // Highlight: the first completion while a name is being typed, else the first item.
  useEffect(() => setActive(typed && typed.prefix && items.length > 1 ? 1 : 0), [query, stage, place, items.length]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const add = async (rootPath: string) => {
    setBusy(true);
    try {
      onChange((await call('project:add', { rootPath, ...(place ? { host: place } : {}) })).projectId);
      toggle(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const choose = async (it: Item | undefined) => {
    if (!it) return;
    setError('');
    if (it.kind === 'place') return goTo(it.key);
    if (it.kind === 'dir') {
      // Already typed in full (Enter right after Tab): that folder is the one.
      if ((input.current?.value ?? query) === it.path) return add(it.path.replace(/\/+$/, ''));
      setText(it.path);
      input.current?.focus();
      return;
    }
    if (it.kind === 'project') {
      onChange(it.project.projectId);
      return toggle(false);
    }
    if (it.kind === 'found') return add(it.found.cwd);
    // The path in the box now (a key pressed before the list caught up still means what is typed).
    if (it.kind === 'use') return add((input.current?.value || it.path).replace(/(.)\/+$/, '$1'));
    try {
      const dir = await call('project:pickDirectory', {});
      if (dir) await add(dir);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const keys = (e: React.KeyboardEvent) => {
    // The highlighted item, kept inside the list: right after the list shrinks (a completion taken),
    // the highlight may still point past its end until it is reset.
    const current = items[Math.min(active, items.length - 1)];
    if (e.key === 'ArrowDown') setActive((i) => Math.min(items.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, Math.min(i, items.length - 1) - 1));
    else if (e.key === 'Enter') void choose(current);
    // Tab completes a folder and goes into it: the highlighted one, else the first that matches (as in a shell).
    else if (e.key === 'Tab' && typed && items.some((i) => i.kind === 'dir')) void choose(current?.kind === 'dir' ? current : items.find((i) => i.kind === 'dir'));
    else if (e.key === 'Backspace' && !query && stage === 'folder') back();
    else if (e.key === 'Escape') toggle(false);
    else return;
    e.preventDefault();
  };

  const firstFound = items.findIndex((i) => i.kind === 'found');
  const firstAction = items.findIndex((i) => i.kind === 'browse');
  const firstDir = items.findIndex((i) => i.kind === 'dir');
  const where = (p: Project) => `${p.host ? `${p.host}:` : ''}${tilde(p.rootPath)}`;
  const listing = !!typed && dirs[dirKey] === null;
  const keyOf = (it: Item) =>
    it.kind === 'place' ? `p:${it.key}` : it.kind === 'project' ? it.project.projectId : it.kind === 'found' ? `f:${it.found.cwd}` : it.kind === 'dir' ? `d:${it.path}` : it.kind;

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
        {selected ? <span className="tag">{placeLabel(selected.host ?? '')}</span> : null}
        <Icon name="chevron" size={11} />
      </button>
      {open ? (
        // Esc here closes this list, not the dialog around it.
        <div className="project-pop" data-own-esc data-testid="project-pop" data-stage={stage}>
          {stage === 'folder' ? (
            <button type="button" className="project-back" onClick={back} title={t('Choose another place')} data-testid="project-back">
              <Icon name="chevron" size={11} />
              <Icon name={place ? 'globe' : 'folder'} size={12} />
              <span>{placeLabel(place)}</span>
            </button>
          ) : null}
          <input
            ref={input}
            className="input project-search"
            autoFocus
            spellCheck={false}
            placeholder={stage === 'place' ? t('Where? This Mac or a machine…') : place ? t('Search, or type a path on {host} (~/… or /…)', { host: place }) : t('Search, or type a path (~/… or /…)')}
            defaultValue=""
            onChange={(e) => {
              // ～ / 、 from a Chinese input method: written back as ~ and / at once.
              const v = asPath(e.target.value);
              if (v !== e.target.value) e.target.value = v;
              setQuery(v);
            }}
            onKeyDown={keys}
            data-testid="project-search"
          />
          {stage === 'folder' && place && !reachable ? <div className="warn-text small">{t('{host} is not connected. Check it in Settings › Remote machines.', { host: place })}</div> : null}
          <div className="project-list" ref={list} role="listbox">
            {items.map((it, i) => (
              <div key={keyOf(it)}>
                {i === 0 && it.kind === 'place' ? <div className="project-group">{t('Where')}</div> : null}
                {i === 0 && it.kind === 'project' ? <div className="project-group">{t('Recent')}</div> : null}
                {i === firstFound ? <div className="project-group">{place ? t('Found on {host} (Claude Code / Codex sessions)', { host: place }) : t('Found on this Mac (Claude Code / Codex sessions)')}</div> : null}
                {i === firstAction ? <div className="project-group">{t('Other folders')}</div> : null}
                {i === firstDir ? <div className="project-group">{t('Folders in {dir}', { dir: typed?.parent ?? '' })}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`project-item${i === active ? ' active' : ''}`}
                  data-index={i}
                  data-kind={it.kind}
                  data-testid="project-item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void choose(it)}
                  disabled={busy || (it.kind !== 'place' && !reachable)}
                >
                  {it.kind === 'place' ? (
                    <>
                      <Icon name={it.key ? 'globe' : 'folder'} />
                      <span className="project-item-text">
                        <span className="project-item-name">{placeLabel(it.key)}</span>
                        <span className="project-item-path">
                          {it.key ? (hostOf(it.key)?.ssh === 'ok' ? t('Connected') : hostOf(it.key)?.ssh === 'checking' ? t('Checking…') : t('Not connected')) : t('Folders on this computer')}
                        </span>
                      </span>
                      <span className="muted small">{t('{n} projects', { n: snapshot.projects.filter((p) => (p.host ?? '') === it.key).length })}</span>
                      {it.key && hostOf(it.key)?.ssh !== 'ok' ? <span className="dot-warn" aria-hidden /> : null}
                    </>
                  ) : it.kind === 'project' ? (
                    <>
                      <Icon name="folder" />
                      <span className="project-item-text">
                        <span className="project-item-name">{it.project.name}</span>
                        <span className="project-item-path mono truncate">{tilde(it.project.rootPath)}</span>
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
                  ) : it.kind === 'dir' ? (
                    <>
                      <Icon name="folder" />
                      <span className="project-item-name mono">{it.name}/</span>
                      <span className="muted small project-item-hint">{t('Tab to open')}</span>
                    </>
                  ) : it.kind === 'use' ? (
                    <>
                      <Icon name="plus" />
                      <span className="project-item-text">
                        <span className="project-item-name">{t('Use this folder')}</span>
                        <span className="project-item-path mono truncate">{place ? `${place}:${it.path}` : it.path}</span>
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
            {stage === 'folder' && !typed && reachable && found[place] === null ? <div className="muted small project-loading">{t('Looking for folders with past sessions…')}</div> : null}
            {listing ? <div className="muted small project-loading">{place ? t('Listing folders on {host}…', { host: place }) : t('Listing folders…')}</div> : null}
            {stage === 'folder' && !typed && !items.length && found[place] ? <div className="muted small project-loading">{t('Nothing here yet: type a path (~/… or /…).')}</div> : null}
            {stage === 'place' && !snapshot.remoteHosts.length ? <div className="muted small project-loading">{t('Machines turned on in Settings › Remote machines show here.')}</div> : null}
          </div>
          {dirError ? <div className="error-text small">{dirError}</div> : null}
          {error ? <div className="error-text small">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
