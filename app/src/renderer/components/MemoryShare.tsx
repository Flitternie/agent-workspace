import { useState } from 'react';
import type { MemoryBackup, MemoryCandidate, WorkspaceSnapshot } from '../../shared/types';
import { call, errorText } from '../api';
import { timeAgo } from '../state';
import { ConfirmDialog, Modal } from './Dialogs';
import { Icon } from './bits';
import { t } from '../i18n';

type Preview = { incoming: MemoryCandidate[]; files: Array<{ path: string; kind: string; exists: boolean; before: string; after: string | null }>; blocked: string[] };

const FILE_ROLE: Record<string, string> = {
  'claude-md': 'Claude Code reads it: one line is added at the end that imports the file below',
  'claude-user': 'The shared user memory for Claude Code (the app’s own file)',
  'codex-md': 'Codex reads it: a marked section at the end holds the shared user memory',
};
const FILE_NAME: Record<string, string> = { 'claude-md': '~/.claude/CLAUDE.md', 'claude-user': '~/.agent-workspace/memory/user.md', 'codex-md': '~/.codex/AGENTS.md' };

const PAUSED: Record<string, string> = {
  edited: 'The Agent Workspace part was changed outside the app. It is left as it is until you choose.',
  removed: 'The Agent Workspace part was removed by hand. It is not put back unless you ask.',
  restored: 'Restored from a backup. The app does not write to it until you resume.',
  'other-owner': 'Kept in sync by another Agent Workspace (another install or data folder). This one leaves it alone; unlink it there first to use this one.',
};

/**
 * Which machines share user memory with their CLIs (terminal Claude Code and Codex).
 * A machine is linked once, after a preview; then the shared user memory is kept in sync
 * there. Nothing on either side is deleted or overwritten: the user's own text is never
 * changed, the app's own text is left alone once someone else changed it, and every
 * change is backed up first.
 */
export function MemoryShare({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [preview, setPreview] = useState<{ host: string; data?: Preview; error?: string } | null>(null);
  const [backups, setBackups] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // This Mac, the SSH machines in Settings, and any machine still linked after it was removed from there.
  const machines = [...new Set(['local', ...snapshot.remoteHosts.map((h) => h.host), ...Object.keys(snapshot.memoryShare)])];
  const name = (h: string) => (h === 'local' ? t('This Mac') : h);
  const reachable = (h: string) => h === 'local' || snapshot.remoteHosts.find((x) => x.host === h)?.ssh === 'ok';

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError('');
    setNote('');
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
  const resolve = (host: string, kind: string, how: 'resume' | 'adopt') =>
    void act(`${host}:${kind}`, async () => {
      const added = await call('memory:resolveShare', { host, kind: kind as 'claude-md', how });
      if (how === 'adopt') setNote(t('{n} notes from there joined your user memory.', { n: added }));
    });

  return (
    <div className="memory-share" data-testid="memory-share">
      <div className="section-label">{t('Share with the CLIs on each machine')}</div>
      <p className="muted small">
        {t('Linked machines get your user memory in Claude Code’s and Codex’s own files, so agents you start in a terminal know it too. Linking backs up those files and brings in the user-level notes already there (CLAUDE.md, AGENTS.md). Claude Code’s own memory belongs to its project and stays there; import it under Import… if you want it here. Your own text in those files is never changed, and nothing is deleted or overwritten on either side.')}
      </p>
      {machines.map((h) => {
        const link = snapshot.memoryShare[h];
        return (
          <div key={h} className="settings-row" data-testid="share-machine" data-host={h} data-linked={link ? '1' : '0'}>
            <div className="settings-row-main">
              <strong className={h === 'local' ? '' : 'mono'}>{name(h)}</strong>
              {link?.unlinking ? (
                <span className="badge">{t('Unlinking: cleaned up when it connects')}</span>
              ) : link ? (
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
                    {link.unlinking ? null : (
                      <button className="btn btn-sm" disabled={!!busy} onClick={() => setUnlinking(h)} data-testid="share-unlink">
                        {t('Unlink…')}
                      </button>
                    )}
                  </>
                ) : (
                  <button className="btn btn-sm btn-primary" disabled={!!busy || !reachable(h)} onClick={() => openPreview(h)} data-testid="share-link">
                    {t('Link and sync…')}
                  </button>
                )}
              </span>
            </div>
            {!link && !reachable(h) ? <div className="muted small">{t('Connect it under Remote machines first.')}</div> : null}
            {link?.paused?.map((p) => (
              <div key={p.kind} className="share-paused" data-testid="share-paused" data-why={p.why}>
                <div className="small">
                  <Icon name="alert" size={12} /> <span className="mono">{FILE_NAME[p.kind] ?? p.kind}</span>: {t(PAUSED[p.why] ?? p.why)}
                </div>
                {p.why === 'other-owner' ? null : (
                  <div className="row">
                    {p.why === 'edited' ? (
                      <button className="btn btn-sm" disabled={!!busy} onClick={() => resolve(h, p.kind, 'adopt')} data-testid="share-adopt">
                        {t('Keep those edits (add them to user memory)')}
                      </button>
                    ) : null}
                    <button className="btn btn-sm btn-ghost" disabled={!!busy || !reachable(h)} onClick={() => resolve(h, p.kind, 'resume')} data-testid="share-resume">
                      {p.why === 'removed' ? t('Put it back') : p.why === 'edited' ? t('Replace with the app’s version (backed up first)') : t('Resume sharing')}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {link?.errors?.map((e) => (
              <div key={e} className="warn-text small">
                <Icon name="alert" size={12} /> {e}
              </div>
            ))}
          </div>
        );
      })}
      {note ? <div className="muted small">{note}</div> : null}
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
              <div className="muted small">{t('Notes from CLAUDE.md / AGENTS.md are copied in once, then belong to the app.')}</div>
              {preview.data.blocked.map((f) => (
                <div key={f} className="warn-text small">
                  <Icon name="alert" size={12} /> {t('{file} is kept in sync by another Agent Workspace; it will not be touched.', { file: f })}
                </div>
              ))}
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
                {t('Before anything changes, each file is backed up in the app and next to it on that machine (~/.agent-workspace/backups). Your own text in these files is never changed; unlinking takes out only what the app added.')}
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
                      if (!r.written.length && (r.errors.length || r.notices.length)) throw new Error([...r.errors, ...r.notices].join(' '));
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
          <p>{t('The CLIs there stop getting your user memory. Only what the app added is taken out (its line in CLAUDE.md, its section in AGENTS.md, its own user.md), each file backed up first. Your own text there stays, and the notes stay in the app.')}</p>
          {!reachable(unlinking) ? <p className="muted small">{t('It is not connected now: it stops getting updates at once and is cleaned up when it connects again.')}</p> : null}
          <div className="modal-foot">
            <button className="btn" onClick={() => setUnlinking(null)}>
              {t('Cancel')}
            </button>
            <button
              className="btn btn-primary"
              disabled={!!busy}
              data-testid="unlink-confirm"
              onClick={() =>
                void act(unlinking, async () => {
                  const r = await call('memory:unlink', { host: unlinking });
                  if (r.notices.length) setNote(r.notices.join(' '));
                  setUnlinking(null);
                })
              }
            >
              {t('Unlink')}
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
  const [confirming, setConfirming] = useState<MemoryBackup | null>(null);
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
                onClick={() => setConfirming(b)}
              >
                {t('Restore')}
              </button>
            </span>
          </div>
          {open?.id === b.id ? <pre className="link-after">{open.text || t('(empty)')}</pre> : null}
        </div>
      ))}
      {confirming ? (
        <ConfirmDialog
          title={t('Restore this backup?')}
          message={t('Put {file} back as it was then? Its current version is backed up first, and the app stops writing to it until you resume.', { file: confirming.path })}
          confirmLabel={t('Restore')}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            setBusy(true);
            call('memory:restoreBackup', { id: confirming.id })
              .then(() => load())
              .catch((e) => setError(errorText(e)))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </Modal>
  );
}
