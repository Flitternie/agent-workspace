import { useEffect, useRef, useState } from 'react';
import { call, errorText, type Outputs } from '../api';
import { t } from '../i18n';
import { Icon } from './bits';

type App = Outputs['apps:installed'][number];

// Installed apps, asked once per run (the main process checks the catalog against /Applications).
let installed: Promise<App[]> | null = null;
const loadApps = () => (installed ??= call('apps:installed', {}).catch(() => []));

const GROUPS: Array<{ kind: App['kind']; label: string }> = [
  { kind: 'editor', label: 'Editors' },
  { kind: 'git', label: 'Git' },
  { kind: 'terminal', label: 'Terminals' },
  { kind: 'files', label: 'Files' },
];

/**
 * "Open with…" (after DeepSeek Harness's open-in-app): an agent's folder, or one of its files, in
 * an app the user has. The main part opens it in the app used last time; the arrow lists the rest.
 * A file opens in editors (at its line where the editor can) or is shown in Finder.
 */
export function OpenInApp({
  taskId,
  path,
  line,
  allowOutside,
  compact,
  iconOnly,
  extra,
}: {
  taskId: string;
  path?: string;
  line?: number;
  allowOutside?: boolean;
  /** Small, borderless (the preview header). */
  compact?: boolean;
  /** The app's icon without its name (the agent header); the name is in the tooltip. */
  iconOnly?: boolean;
  extra?: Array<{ label: string; run: () => void }>;
}) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLSpanElement>(null);
  const key = path ? 'amw.openWith.file' : 'amw.openWith.folder';
  const [last, setLast] = useState(() => localStorage.getItem(key) ?? '');
  useEffect(() => {
    let live = true;
    void loadApps().then((a) => live && setApps(a));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  // A file: editors, and Finder to show it; a folder: everything.
  const usable = (apps ?? []).filter((a) => !path || a.kind === 'editor' || a.kind === 'files');
  if (!usable.length && !extra?.length) return null;
  // Until the user picks one: Finder (open the folder, or show the file in it).
  const main = usable.find((a) => a.id === last) ?? usable.find((a) => a.kind === 'files') ?? usable[0];
  const run = (a: App) => {
    setOpen(false);
    setError('');
    localStorage.setItem(key, a.id);
    setLast(a.id);
    call('apps:open', { appId: a.id, taskId, path, line, allowOutside: allowOutside || undefined }).catch((e) => setError(errorText(e)));
  };
  const label = (a: App) => (a.kind === 'files' && path ? t('Show in Finder') : t('Open in {app}', { app: a.name }));
  return (
    <span className={`open-in${compact ? ' compact' : ''}`} ref={box} data-testid={path ? 'open-file-in' : 'open-folder-in'}>
      {main ? (
        <button className="open-in-main" onClick={() => run(main)} title={label(main)} aria-label={label(main)} data-testid="open-in-main" data-app={main.id}>
          {main.icon ? <img src={main.icon} alt="" width={16} height={16} /> : <Icon name="external" size={13} />}
          {compact || iconOnly ? null : <span className="open-in-label">{label(main)}</span>}
        </button>
      ) : null}
      <button className="open-in-more" aria-label={t('Open with…')} title={t('Open with…')} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="open-in-more">
        <Icon name="chevron" size={11} />
      </button>
      {open ? (
        <div className="open-in-menu" role="menu" data-testid="open-in-menu">
          {GROUPS.map((g) => {
            const list = usable.filter((a) => a.kind === g.kind);
            if (!list.length) return null;
            return (
              <div key={g.kind} className="open-in-group">
                <div className="open-in-group-label">{t(g.label)}</div>
                {list.map((a) => (
                  <button key={a.id} role="menuitem" className={`open-in-item${a.id === main?.id ? ' on' : ''}`} onClick={() => run(a)} data-testid="open-in-item" data-app={a.id}>
                    {a.icon ? <img src={a.icon} alt="" width={16} height={16} /> : <span className="open-in-noicon" />}
                    <span>{a.kind === 'files' && path ? t('Show in Finder') : a.name}</span>
                    {path && line && a.lines ? <span className="muted small">{t('line {n}', { n: line })}</span> : null}
                  </button>
                ))}
              </div>
            );
          })}
          {extra?.length ? (
            <div className="open-in-group">
              {extra.map((x) => (
                <button
                  key={x.label}
                  role="menuitem"
                  className="open-in-item"
                  onClick={() => {
                    setOpen(false);
                    x.run();
                  }}
                >
                  <span className="open-in-noicon" />
                  <span>{x.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <span className="error-text small open-in-error">{error}</span> : null}
    </span>
  );
}
