import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { CodexRemoteControl, Task } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { timeAgo } from '../state';
import { Icon } from './bits';

/**
 * Remote Control: drive this agent from a phone while it keeps running on this computer. Claude Code:
 * the Claude app or claude.ai/code, with the session's link. Codex: the ChatGPT app, paired by typing a
 * short-lived code shown here. A click on the lit button opens the popover; its button turns it off.
 */
export function RemoteControlButton({ task, url, codex }: { task: Task; url?: string; codex?: CodexRemoteControl }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const on = !!url || !!codex;
  const isCodex = task.provider === 'codex';
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
        data-tip={on ? t('Remote on') : t('Remote')}
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
          {/* Closes this popover only; Remote Control stays as it is. */}
          <button className="icon-btn remote-pop-close" aria-label={t('Close')} title={t('Close')} onClick={() => setOpen(false)} data-testid="remote-pop-close">
            <Icon name="x" size={12} />
          </button>
          {error && !codex ? (
            <>
              <div className="remote-pop-title">{t('Remote Control did not start')}</div>
              <p className="error-text">{error}</p>
              {/* Codex says why itself (its login, version or the organization's rules); a hint would only mislead. */}
              {isCodex ? null : (
                <p className="muted small">{t('It needs Claude Code signed in with a claude.ai plan (Pro, Max, Team or Enterprise); API keys are not supported.')}</p>
              )}
            </>
          ) : codex ? (
            <CodexPairing codex={codex} busy={busy} failed={error} onNewCode={() => set(true)} onOff={() => set(false)} taskId={task.taskId} />
          ) : on ? (
            <>
              <div className="remote-pop-title">
                <span className="remote-dot" aria-hidden /> {t('Remote Control on')}
              </div>
              <p className="muted small">{t('Open the Claude app on your phone, go to Code, and pick “{name}”. It keeps running on this computer.', { name: task.name })}</p>
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
                <button className="btn btn-sm btn-ghost remote-off" onClick={() => set(false)} disabled={busy} data-testid="remote-off">
                  {t('Turn off Remote Control')}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

/** The link to ChatGPT; once up, whether a code is waiting to be entered. */
const codexStatus = (c: CodexRemoteControl, waiting: boolean): string =>
  c.status === 'errored'
    ? t('Cannot reach ChatGPT; Codex keeps trying.')
    : c.status === 'connecting' || c.status === 'disabled'
      ? t('Connecting to ChatGPT…')
      : waiting
        ? t('Waiting for your phone')
        : t('Connected');

/** The pairing as a QR code (black on white whatever the theme, so phones read it). */
function PairingQr({ text }: { text: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(''));
    return () => {
      live = false;
    };
  }, [text]);
  // The library's own SVG markup for the code (no user text in it beyond the encoded data).
  return svg ? <div className="remote-qr" data-testid="remote-qr" dangerouslySetInnerHTML={{ __html: svg }} /> : null;
}

/** Codex: the code to type in the ChatGPT app and when it expires, then the paired devices. */
function CodexPairing({ codex, busy, failed, taskId, onNewCode, onOff }: { codex: CodexRemoteControl; busy: boolean; failed: string; taskId: string; onNewCode: () => void; onOff: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const expires = codex.expiresAt ? Date.parse(codex.expiresAt) : NaN;
  const live = !!codex.code && !(expires <= now);
  useEffect(() => {
    if (!codex.code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [codex.code]);
  const left = Math.max(0, Math.round((expires - now) / 1000));
  const revoke = (clientId: string) => {
    setError('');
    call('task:remoteControlRevoke', { taskId, clientId }).catch((e) => setError(errorText(e)));
  };
  return (
    <>
      <div className="remote-pop-title">
        <span className={`remote-dot${codex.status === 'errored' ? ' remote-dot-err' : ''}`} aria-hidden /> {t('Remote Control on')}
      </div>
      <p className="muted small" data-testid="remote-status">
        {codexStatus(codex, live)}
        {codex.serverName ? ` · ${codex.serverName}` : ''}
      </p>
      {live ? (
        <>
          {codex.qr ? <PairingQr text={codex.qr} /> : null}
          <p className="muted small">{codex.qr ? t('Scan it in the ChatGPT app on your phone, or enter this code:') : t('In the ChatGPT app on your phone, open Codex, pair a computer and enter this code.')}</p>
          <div className="remote-code mono" data-testid="remote-code">
            {codex.code}
          </div>
          {Number.isFinite(expires) ? (
            <p className="muted small">{t('Expires in {time}', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</p>
          ) : null}
        </>
      ) : codex.paired ? (
        <p className="muted small">{t('Paired. Continue this agent from Codex in the ChatGPT app; it keeps running on this computer.')}</p>
      ) : (
        <p className="muted small">{t('The code expired.')}</p>
      )}
      {codex.devices?.length ? (
        <div className="remote-devices" data-testid="remote-devices">
          <div className="small">{t('Paired devices')}</div>
          {codex.devices.map((d) => (
            <div className="remote-device" key={d.id} data-testid="remote-device">
              <span className="remote-device-name" title={d.name}>
                {d.name}
              </span>
              {d.lastSeenAt ? <span className="muted small">{timeAgo(d.lastSeenAt, now)}</span> : null}
              <button className="btn btn-sm btn-ghost remote-off" onClick={() => revoke(d.id)} data-testid="remote-revoke">
                {t('Unpair')}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {error || failed ? <p className="error-text">{error || failed}</p> : null}
      <div className="remote-actions">
        {!live ? (
          <button className="btn btn-sm" onClick={onNewCode} disabled={busy} data-testid="remote-new-code">
            {codex.paired || codex.devices?.length ? t('Pair another device') : t('New code')}
          </button>
        ) : null}
        <button className="btn btn-sm btn-ghost remote-off" onClick={onOff} disabled={busy} data-testid="remote-off">
          {t('Turn off Remote Control')}
        </button>
      </div>
    </>
  );
}
