import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { Icon } from './bits';

/**
 * Remote Control (Claude Code): drive this agent from the Claude app on a phone, or claude.ai/code,
 * while it keeps running on this Mac. On: the session's link and where to find it; a click turns it off.
 */
export function RemoteControlButton({ task, url }: { task: Task; url?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const on = !!url;
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
  const set = (next: boolean) => {
    setBusy(true);
    setError('');
    call('task:remoteControl', { taskId: task.taskId, on: next })
      .then(() => setOpen(next))
      .catch((e) => {
        setError(errorText(e));
        setOpen(true);
      })
      .finally(() => setBusy(false));
  };
  const label = on ? t('Remote Control on') : t('Remote Control');
  return (
    <span className="remote-control" ref={box}>
      <button
        className={`btn btn-icon${on ? ' btn-pressed remote-on' : ''}`}
        title={on ? t('Remote Control on: drive this agent from the Claude app or claude.ai/code') : t('Remote Control: drive this agent from the Claude app on your phone')}
        aria-label={label}
        aria-pressed={on}
        disabled={busy}
        data-testid="remote-control"
        onClick={() => (on ? setOpen((o) => !o) : set(true))}
      >
        <Icon name="phone" />
        {on ? <span className="remote-dot" aria-hidden /> : null}
      </button>
      {open ? (
        <div className="remote-pop" role="dialog" aria-label={label} data-testid="remote-pop">
          {error ? (
            <>
              <div className="remote-pop-title">{t('Remote Control did not start')}</div>
              <p className="error-text">{error}</p>
              <p className="muted small">{t('It needs Claude Code signed in with a claude.ai plan (Pro, Max, Team or Enterprise); API keys are not supported.')}</p>
            </>
          ) : on ? (
            <>
              <div className="remote-pop-title">
                <span className="remote-dot" aria-hidden /> {t('Remote Control on')}
              </div>
              <p className="muted small">{t('Open the Claude app on your phone, go to Code, and pick “{name}”. It keeps running on this Mac.', { name: task.name })}</p>
              <div className="remote-link mono" title={url}>
                {url}
              </div>
              <div className="remote-actions">
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void navigator.clipboard.writeText(url!).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    })
                  }
                >
                  <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? t('Copied') : t('Copy link')}
                </button>
                {/* https links leave the app for the default browser (the window's open handler). */}
                <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">
                  <Icon name="external" size={12} /> {t('Open in browser')}
                </a>
                <button className="btn btn-sm btn-ghost" onClick={() => set(false)} disabled={busy} data-testid="remote-off">
                  {t('Turn off')}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
