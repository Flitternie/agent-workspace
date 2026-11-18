import { useEffect, useRef, useState } from 'react';
import type { BtwEntry, Task } from '../../shared/types';
import { t } from '../i18n';
import { SidePanel, type SideFrame } from './SidePanel';
import { Icon } from './bits';
import { Markdown } from './Markdown';

/**
 * Side questions ("btw") to this agent, in the side column: answered from its conversation so far,
 * never part of it, never interrupting a turn. Asked from the reply box (⌥↵ / the bubble button);
 * here only to read, copy, or bring an answer back into the conversation (into the box, to edit).
 */
export function BtwPanel({ task, entries, onClear, onBring, frame }: { task: Task; entries: BtwEntry[]; onClear: () => void; onBring: (text: string) => void; frame: SideFrame }) {
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
    <SidePanel
      // The what and how in its tooltip; the panel itself stays quiet.
      title={<span title={`${t('Not part of the conversation; interrupts nothing.')} ${what}`}>{t('Side questions')}</span>}
      label={t('Side questions')}
      testId="btw-panel"
      frame={frame}
      actions={
        entries.length ? (
          <button className="icon-btn" title={t('Clear')} aria-label={t('Clear')} onClick={onClear} data-testid="btw-clear">
            <Icon name="trash" size={13} />
          </button>
        ) : null
      }
    >
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
    </SidePanel>
  );
}
