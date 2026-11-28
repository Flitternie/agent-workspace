import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceSnapshot } from '../../shared/types';
import { call } from '../api';
import { t } from '../i18n';
import { Icon } from './bits';

type Folder = { name: string; git?: boolean; research?: boolean };

/**
 * Where a research is kept: a folder of its project (typed with completion, or picked from the list of the
 * project's folders, repositories and those with a research already marked); empty is the project's own folder.
 * Deeper paths complete folder by folder.
 */
export function ResearchFolderField({ snapshot, projectId, value, onChange, testId }: { snapshot: WorkspaceSnapshot; projectId: string; value: string; onChange: (v: string) => void; testId: string }) {
  const project = snapshot.projects.find((p) => p.projectId === projectId);
  const [top, setTop] = useState<Folder[] | null>(null);
  const [deeper, setDeeper] = useState<{ parent: string; names: string[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTop(null);
    if (!projectId) return;
    let live = true;
    call('research:folders', { projectId })
      .then((f) => live && setTop(f))
      .catch(() => live && setTop([]));
    return () => {
      live = false;
    };
  }, [projectId]);

  // Typed past a folder ("a/b"): the folders in "a", as the project chooser lists them.
  const cut = value.lastIndexOf('/');
  const parent = cut > 0 ? value.slice(0, cut) : '';
  const prefix = (cut >= 0 ? value.slice(cut + 1) : value).toLowerCase();
  useEffect(() => {
    if (!parent || !project) return setDeeper(null);
    let live = true;
    const dir = `${project.rootPath.replace(/\/+$/, '')}/${parent}`;
    call('fs:listDirs', { dir, ...(project.host ? { host: project.host } : {}) })
      .then((r) => live && setDeeper({ parent, names: r.names.filter((n) => !n.startsWith('.')) }))
      .catch(() => live && setDeeper({ parent, names: [] }));
    return () => {
      live = false;
    };
  }, [parent, project]);

  const choices: Folder[] = useMemo(() => {
    const list = parent ? (deeper?.parent === parent ? deeper.names.map((name) => ({ name })) : []) : (top ?? []);
    return list.filter((f) => f.name.toLowerCase().includes(prefix)).slice(0, 200);
  }, [parent, deeper, top, prefix]);
  useEffect(() => setActive(0), [value]);

  // Closed by a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);

  const pick = (f: Folder) => {
    if (f.research) return;
    onChange(parent ? `${parent}/${f.name}` : f.name);
    setOpen(false);
  };
  const usable = choices.filter((f) => !f.research);

  return (
    <div className="field research-folder" ref={box}>
      <label>{t('Where it is kept')}</label>
      <input
        className="input mono"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || !usable.length) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : usable.length - 1)) % usable.length);
          } else if ((e.key === 'Enter' || e.key === 'Tab') && usable[active] && prefix !== usable[active].name.toLowerCase()) {
            e.preventDefault();
            pick(usable[active]);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder={t('The project’s own folder')}
        spellCheck={false}
        data-testid={testId}
      />
      {open && projectId ? (
        <div className="project-pop research-folder-pop" data-own-esc data-testid={`${testId}-pop`}>
          <div className="project-list" role="listbox">
            {!parent && top === null ? <div className="muted small project-loading">{t('Reading the project’s folders…')}</div> : null}
            {top !== null && !choices.length ? <div className="muted small project-loading">{t('No folder matches.')}</div> : null}
            {choices.map((f) => (
              <button
                key={f.name}
                type="button"
                role="option"
                aria-selected={usable[active] === f}
                className={`project-item${usable[active] === f ? ' active' : ''}`}
                disabled={f.research}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(f)}
                data-testid="research-folder-option"
              >
                <Icon name="folder" size={14} />
                <span className="project-item-text">
                  <span className="project-item-name mono">{parent ? `${parent}/` : ''}{f.name}</span>
                </span>
                {f.research ? <span className="muted small">{t('Has a research')}</span> : f.git ? <span className="tag">{t('Repository')}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="muted small">{t('The research and its agents work here; empty is the project’s own folder.')}</div>
    </div>
  );
}
