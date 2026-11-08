import { useState } from 'react';
import type { MemoryBackup, MemoryCandidate, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { timeAgo } from '../state';
import { Modal } from './Dialogs';
import { Icon } from './bits';
import { t } from '../i18n';

type Preview = { incoming: MemoryCandidate[]; files: Array<{ path: string; kind: string; exists: boolean; before: string; after: string | null }> };

const FILE_ROLE: Record<string, string> = {
  'claude-md': 'Claude Code reads it: one line is added that imports the file below',
  'claude-user': 'The shared user memory for Claude Code (the app’s own file)',
  'codex-md': 'Codex reads it: a marked section at the end holds the shared user memory',
};

/**
 * Which machines share user memory with their CLIs (terminal Claude Code and Codex).
 * A machine is linked once, after a preview; then the shared user memory is kept in sync
 * there. Every change is backed up first and can be undone.
 */
export function MemoryShare({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [preview, setPreview] = useState<{ host: string; data?: Preview; error?: string } | null>(null);
  const [backups, setBackups] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const machines = ['local', ...snapshot.remoteHosts.map((h) => h.host)];
  const name = (h: string) => (h === 'local' ? t('This Mac') : h);
  const reachable = (h: string) => h === 'local' || snapshot.remoteHosts.find((x) => x.host === h)?.ssh === 'ok';

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const openPreview = (host: string) => {
    setPreview({ host });
    call('memory:linkPreview', { host }).then(
      (data) => setPreview({ host, data }),
      (e) => setPreview({ host, error: errorText(e) }),
    );
  };

  return (
    <div className="memory-share" data-testid="memory-share">
      <div className="section-label">{t('Share with the CLIs on each machine')}</div>
      <p className="muted small">
        {t('Linked machines get your user memory in Claude Code’s and Codex’s own files, so agents you start in a terminal know it too. Linking backs up those files and merges the notes already there; after that, changes on any linked machine reach all of them.')}
      </p>
      {machines.map((h) => {
        const link = snapshot.memoryShare[h];
        return (
          <div key={h} className="settings-row" data-testid="share-machine" data-host={h} data-linked={link ? '1' : '0'}>
            <div className="settings-row-main">
              <strong className={h === 'local' ? '' : 'mono'}>{name(h)}</strong>
              {link ? (
                <span className="badge badge-ready">
                  <Icon name="check" size={12} /> {t('Linked {time}', { time: timeAgo(link.linkedAt) })}
                </span>
              ) : (
                <span className="muted small">{t('Not linked')}</span>
              )}
              {link?.lastWrite ? <span className="muted small">{t('updated {time}', { time: timeAgo(link.lastWrite) })}</span> : null}
              <span className="host-actions">
                {link ? (
                  <>
                    <button className="btn btn-sm btn-ghost" onClick={() => setBackups(h)} data-testid="share-backups">
                      {t('Backups')}
                    </button>
                    <button className="btn btn-sm" disabled={!!busy || !reachable(h)} onClick={() => setUnlinking(h)} data-testid="share-unlink">
                      {t('Unlink…')}
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm btn-primary" disabled={!!busy || !reachable(h)} onClick={() => openPreview(h)} data-testid="share-link">
                    {t('Link and sync…')}
                  </button>
                )}
              </span>
            </div>
            {!reachable(h) ? <div className="muted small">{t('Connect it under Remote machines first.')}</div> : null}
            {link?.errors?.map((e) => (
              <div key={e} className="warn-text small">
                <Icon name="alert" size={12} /> {e}
              </div>
            ))}
          </div>
        );
      })}
      {error ? <div className="error-text small">{error}</div> : null}

      {preview ? (
        <Modal title={t('Link {machine}', { machine: name(preview.host) })} onClose={() => setPreview(null)}>
          {preview.error ? <div className="error-text">{preview.error}</div> : null}
          {!preview.data && !preview.error ? <div className="muted">{t('Reading the files there…')}</div> : null}
          {preview.data ? (
            <div className="link-preview" data-testid="link-preview">
              <div className="section-label">{t('Notes from this machine joining your user memory · {n}', { n: preview.data.incoming.length })}</div>
              {preview.data.incoming.length ? (
                <ul className="small">
                  {preview.data.incoming.map((c) => (
                    <li key={c.key}>
                      <strong>{c.title}</strong> <span className="muted mono">{c.file}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="muted small">{t('None: everything there is already in your user memory.')}</div>
              )}
              <div className="section-label">{t('Files that will change')}</div>
              {preview.data.files.filter((f) => f.after !== null).length === 0 ? <div className="muted small">{t('None.')}</div> : null}
              {preview.data.files
                .filter((f) => f.after !== null)
                .map((f) => (
                  <details key={f.path} className="link-file">
                    <summary>
                      <span className="mono">{f.path}</span> <span className="muted small">{f.exists ? t('changed') : t('new file')}</span>
                      <div className="muted small">{t(FILE_ROLE[f.kind] ?? '')}</div>
                    </summary>
                    <pre className="link-after">{f.after}</pre>
                  </details>
                ))}
              <p className="muted small">
                {t('Before anything changes, each file is backed up in the app and next to it on that machine (~/.agent-workspace/backups). Your own text in these files is never changed; you can unlink and put them back as they were at any time.')}
              </p>
              <div className="modal-foot">
                <button className="btn" onClick={() => setPreview(null)}>
                  {t('Cancel')}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!!busy}
                  data-testid="link-confirm"
                  onClick={() =>
                    void act(preview.host, async () => {
                      const r = await call('memory:link', { host: preview.host });
                      if (r.errors.length) throw new Error(r.errors.join(' '));
                      setPreview(null);
                    })
                  }
                >
                  {busy === preview.host ? t('Linking…') : t('Back up and link')}
                </button>
              </div>
            </div>
          ) : null}
        </Modal>
      ) : null}

      {unlinking ? (
        <Modal title={t('Unlink {machine}', { machine: name(unlinking) })} onClose={() => setUnlinking(null)}>
          <p>{t('The CLIs there stop getting your user memory. The notes stay in the app. Files are backed up before they change.')}</p>
          <div className="modal-foot">
            <button className="btn" onClick={() => setUnlinking(null)}>
              {t('Cancel')}
            </button>
            <button className="btn" disabled={!!busy} data-testid="unlink-original" onClick={() => void act(unlinking, async () => (await call('memory:unlink', { host: unlinking, how: 'original' }), setUnlinking(null)))}>
              {t('Put the files back as before linking')}
            </button>
            <button className="btn btn-primary" disabled={!!busy} data-testid="unlink-remove" onClick={() => void act(unlinking, async () => (await call('memory:unlink', { host: unlinking, how: 'remove' }), setUnlinking(null)))}>
              {t('Remove only the app’s lines')}
            </button>
          </div>
        </Modal>
      ) : null}

      {backups ? <BackupList host={backups} name={name(backups)} onClose={() => setBackups(null)} /> : null}
    </div>
  );
}

const REASON: Record<MemoryBackup['reason'], string> = { link: 'before linking', sync: 'before a sync', restore: 'before a restore', unlink: 'before unlinking' };

function BackupList({ host, name, onClose }: { host: string; name: string; onClose: () => void }) {
  const [list, setList] = useState<MemoryBackup[] | null>(null);
  const [open, setOpen] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => call('memory:backups', { host }).then(setList, (e) => setError(errorText(e)));
  if (list === null && !error) void load();
  return (
    <Modal title={t('Backups · {machine}', { machine: name })} onClose={onClose}>
      {error ? <div className="error-text small">{error}</div> : null}
      {list?.length === 0 ? <div className="muted small">{t('No backups yet.')}</div> : null}
      {list?.map((b) => (
        <div key={b.id} className="settings-row" data-testid="backup-row">
          <div className="settings-row-main">
            <span className="mono small">{b.path.split('/').slice(-2).join('/')}</span>
            <span className="muted small">
              {timeAgo(b.at)} · {t(REASON[b.reason])}
              {b.original ? ` · ${t('original, kept for good')}` : ''}
              {!b.existed ? ` · ${t('file did not exist')}` : ''}
            </span>
            <span className="host-actions">
              <button className="btn btn-sm btn-ghost" onClick={() => (open?.id === b.id ? setOpen(null) : call('memory:backupContent', { id: b.id }).then((text) => setOpen({ id: b.id, text }), (e) => setError(errorText(e))))}>
                {open?.id === b.id ? t('Hide') : t('View')}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy}
                data-testid="backup-restore"
                onClick={() => {
                  if (!window.confirm(t('Put {file} back as it was then? Its current version is backed up first.', { file: b.path }))) return;
                  setBusy(true);
                  call('memory:restoreBackup', { id: b.id })
                    .then(() => load())
                    .catch((e) => setError(errorText(e)))
                    .finally(() => setBusy(false));
                }}
              >
                {t('Restore')}
              </button>
            </span>
          </div>
          {open?.id === b.id ? <pre className="link-after">{open.text || t('(empty)')}</pre> : null}
        </div>
      ))}
    </Modal>
  );
}
