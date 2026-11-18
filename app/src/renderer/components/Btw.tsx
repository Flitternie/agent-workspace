import { useEffect, useRef, useState } from 'react';
import type { BtwEntry, Task } from '../../shared/types';
import { t } from '../i18n';
import { Icon } from './bits';
import { Markdown } from './Markdown';

/**
 * Side questions ("btw") to this agent, in the side column: answered from its conversation so far,
 * never part of it, never interrupting a turn. Asked from the reply box (⌥↵ / the bubble button);
 * here only to read, copy, or bring an answer back into the conversation (into the box, to edit).
 */
export function BtwPanel({ task, entries, onClear, onBring, onClose, width }: { task: Task; entries: BtwEntry[]; onClear: () => void; onBring: (text: string) => void; onClose: () => void; width?: number }) {
  const end = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState('');
  const last = entries.at(-1);
  // The newest exchange in view as it arrives.
  // Braces: scrollIntoView returns a promise in this Chromium, and an effect must return nothing or a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, last?.answer, last?.error]);
  const what = task.provider === 'codex' ? t('A read-only side thread of this conversation.') : t('Answered from what is already in this conversation; no tools.');
  return (
    <aside className="memory btw" style={width ? { width } : undefined} aria-label={t('Side questions')} data-testid="btw-panel">
      <div className="preview-top">
        <div className="preview-head">
          <div className="preview-ident">
            {/* The what and how in its tooltip; the panel itself stays quiet. */}
            <div className="panel-title" title={`${t('Not part of the conversation; interrupts nothing.')} ${what}`}>
              {t('Side questions')}
            </div>
          </div>
          {entries.length ? (
            <button className="icon-btn" title={t('Clear')} aria-label={t('Clear')} onClick={onClear} data-testid="btw-clear">
              <Icon name="trash" size={13} />
            </button>
          ) : null}
          <button className="icon-btn" title={t('Close')} aria-label={t('Close')} onClick={onClose}>
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
      {entries.length ? (
        <div className="btw-thread">
          {entries.map((e) => (
            <div key={e.id} className="btw-exchange" data-testid="btw-exchange">
              <div className="btw-q">{e.question}</div>
              {e.answer ? (
                <div className="btw-a" data-testid="btw-answer">
                  <Markdown text={e.answer} />
                  <div className="btw-actions">
                    <button
                      className="link small"
                      onClick={() =>
                        void navigator.clipboard.writeText(e.answer!).then(() => {
                          setCopied(e.id);
                          setTimeout(() => setCopied(''), 1200);
                        })
                      }
                    >
                      {copied === e.id ? t('Copied') : t('Copy')}
                    </button>
                    <button className="link small" onClick={() => onBring(`${t('About my side question “{q}”:', { q: e.question })}\n> ${e.answer!.replace(/\n/g, '\n> ')}\n\n`)} data-testid="btw-bring">
                      {t('Bring into the conversation')}
                    </button>
                  </div>
                </div>
              ) : e.error ? (
                <div className="error-text small" data-testid="btw-error">
                  {e.error}
                </div>
              ) : (
                <div className="muted small btw-pending" data-testid="btw-pending">
                  {t('Answering…')}
                </div>
              )}
            </div>
          ))}
          <div ref={end} />
        </div>
      ) : null}
    </aside>
  );
}
