import { useEffect, useRef, useState, type RefObject } from 'react';
import { t } from '../i18n';
import { Icon } from './bits';

// Find in the conversation (⌘F): every match highlighted, the current one stronger. Folded
// turns and closed tool calls are searched too: the one holding the current match opens.
// Uses the CSS Custom Highlight API, so the page's own text and layout are left alone.

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): Highlights | undefined => (CSS as unknown as { highlights?: Highlights }).highlights;
const Highlight = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase();
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      out.push(r);
    }
  }
  return out;
}

export function FindBar({ scope, version, onClose, onJump }: { scope: RefObject<HTMLElement | null>; version: unknown; onClose: () => void; onJump?: () => void }) {
  const [query, setQuery] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => void input.current?.focus(), []);
  // ⌘F again selects the query.
  useEffect(() => {
    const again = () => input.current?.select();
    window.addEventListener('amw:find-again', again);
    return () => window.removeEventListener('amw:find-again', again);
  }, []);
  useEffect(() => {
    const root = scope.current;
    const q = query.trim();
    const found = root && q ? findRanges(root, q) : [];
    setRanges(found);
    setAt((i) => Math.min(i, Math.max(0, found.length - 1)));
    if (found.length && Highlight) highlights()?.set('find', new Highlight(...found));
    else highlights()?.delete('find');
  }, [query, version]);
  useEffect(() => {
    const r = ranges[at];
    if (!r || !Highlight) {
      highlights()?.delete('find-current');
      return;
    }
    // Open what holds it (a folded turn, a tool call, thinking), then bring it into view.
    for (let el = r.startContainer.parentElement; el; el = el.parentElement) if (el instanceof HTMLDetailsElement) el.open = true;
    highlights()?.set('find-current', new Highlight(r));
    onJump?.();
    r.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  }, [ranges, at]);
  useEffect(
    () => () => {
      highlights()?.delete('find');
      highlights()?.delete('find-current');
    },
    [],
  );
  const step = (d: number) => ranges.length && setAt((i) => (i + d + ranges.length) % ranges.length);
  return (
    <div className="find-bar" data-testid="find-bar">
      <Icon name="search" size={13} />
      <input
        ref={input}
        className="find-input"
        value={query}
        placeholder={t('Find in conversation')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        data-testid="find-input"
      />
      <span className="find-count" data-testid="find-count">
        {query.trim() ? (ranges.length ? `${at + 1}/${ranges.length}` : t('No results')) : ''}
      </span>
      <button className="icon-btn" aria-label={t('Previous')} title={t('Previous (⇧↵)')} disabled={!ranges.length} onClick={() => step(-1)}>
        <span className="find-up"><Icon name="chevron" size={12} /></span>
      </button>
      <button className="icon-btn" aria-label={t('Next')} title={t('Next (↵)')} disabled={!ranges.length} onClick={() => step(1)}>
        <span className="find-down"><Icon name="chevron" size={12} /></span>
      </button>
      <button className="icon-btn" aria-label={t('Close')} title={t('Close (Esc)')} onClick={onClose}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
