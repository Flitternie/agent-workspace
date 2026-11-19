import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { browsePath, mentionAt, mentionBefore, mentionText, splitMentions, type FileMatch } from '../../shared/file-match';
import { call } from '../api';
import { t } from '../i18n';
import { Icon } from './bits';

/**
 * @-mentions in an agent's message box, as in Claude Code and Codex: typing @ lists the files and
 * folders in the agent's folder (on its machine, also over SSH), filtered as you type; choosing one
 * puts @path in the message. Claude Code reads a mentioned file in with the message; Codex reads it
 * with its tools.
 */
export function useMentions(taskId: string | undefined, box: RefObject<HTMLTextAreaElement | null>, draft: string, setDraft: (text: string) => void) {
  const [at, setAt] = useState<{ start: number; query: string } | null>(null);
  const [items, setItems] = useState<FileMatch[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const closedAt = useRef<number | null>(null);

  /** Where the caret is decides whether a mention is being typed (also after moving it with the mouse or arrows). */
  const update = () => {
    const el = box.current;
    if (!el || !taskId) return setAt(null);
    const m = mentionAt(el.value, el.selectionStart ?? el.value.length);
    // Escape closed this one: it stays closed until another @ is typed.
    if (m && closedAt.current === m.start) return setAt(null);
    if (!m) closedAt.current = null;
    // Deleting back into a mention does not open the list (typing does; one already open follows).
    if (m && deleting.current && atRef.current?.start !== m.start) return setAt(null);
    setAt((prev) => (prev?.start === m?.start && prev?.query === m?.query ? prev : (m ?? null)));
  };
  const deleting = useRef(false);
  const atRef = useRef(at);
  atRef.current = at;
  // The caret goes after an inserted path as soon as the box shows it (before the next key is typed).
  const caretAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && caretAfter.current !== null) {
      el.focus();
      el.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
    update();
  }, [draft]);

  useEffect(() => {
    if (!at || !taskId) {
      setItems([]);
      return;
    }
    let stale = false;
    setLoading(true);
    const id = setTimeout(() => {
      call('files:search', { taskId, query: at.query })
        .then((r) => {
          if (stale) return;
          setItems(r);
          setActive(0);
        })
        .catch(() => !stale && setItems([]))
        .finally(() => !stale && setLoading(false));
    }, 80);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [at?.start, at?.query, taskId]);

  const choose = (m: FileMatch) => {
    const el = box.current;
    if (!el || !at) return;
    const caret = el.selectionStart ?? el.value.length;
    const insert = mentionText(m);
    const next = el.value.slice(0, at.start) + insert + el.value.slice(caret);
    caretAfter.current = at.start + insert.length;
    setDraft(next);
  };

  const open = !!at && (items.length > 0 || loading);
  /** Keys for the list while it is open; true when the key was used here. */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    deleting.current = e.key === 'Backspace' || e.key === 'Delete';
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && items[active]) {
      e.preventDefault();
      choose(items[active]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closedAt.current = at!.start;
      setAt(null);
      return true;
    }
    return false;
  };

  /** Backspace right after a whole @path removes it at once, as a chip would go (not while the list is editing it). */
  const onBackspace = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const el = e.currentTarget;
    if (e.key !== 'Backspace' || open || e.metaKey || e.altKey || el.selectionStart !== el.selectionEnd) return false;
    const start = mentionBefore(el.value, el.selectionStart);
    if (start === undefined) return false;
    e.preventDefault();
    caretAfter.current = start;
    setDraft(el.value.slice(0, start) + el.value.slice(el.selectionStart));
    return true;
  };

  return { open, items, active, loading, query: at?.query ?? '', choose, setActive, onKeyDown, onBackspace, update };
}

/** The list above the message box. */
export function MentionMenu({ m }: { m: ReturnType<typeof useMentions> }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [m.active, m.items]);
  if (!m.open) return null;
  return (
    <div className="mention-pop" data-testid="mention-pop" role="listbox">
      <div className="project-group">
        {browsePath(m.query) ? t('In {dir}', { dir: browsePath(m.query)!.parent }) : m.query ? t('Files matching “{q}”', { q: m.query }) : t('Files in this agent’s folder')}
      </div>
      <div className="project-list" ref={list}>
        {m.items.map((it, i) => {
          const slash = it.path.replace(/\/$/, '').lastIndexOf('/');
          const name = it.path.slice(slash + 1);
          const dir = slash === -1 ? '' : it.path.slice(0, slash + 1);
          return (
            <button
              type="button"
              key={it.path}
              role="option"
              aria-selected={i === m.active}
              className={`project-item${i === m.active ? ' active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => m.setActive(i)}
              onClick={() => m.choose(it)}
              data-testid="mention-item"
            >
              <Icon name={it.dir ? 'folder' : 'file'} />
              <span className="project-item-text">
                <span className="project-item-name mono">{name}</span>
                {dir ? <span className="project-item-path mono truncate">{dir}</span> : null}
              </span>
            </button>
          );
        })}
        {!m.items.length && m.loading ? <div className="muted small pad">{t('Looking…')}</div> : null}
      </div>
    </div>
  );
}

/**
 * Behind the message box, the same text with each @path marked, so the mentions show as chips in
 * the box itself (the box stays a plain textarea: voice drafts, suggestions and IME keep working).
 * It copies the box's text metrics and follows its scrolling.
 */
export function MentionHighlight({ text, box }: { text: string; box: RefObject<HTMLTextAreaElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const mirror = ref.current;
    if (!el || !mirror) return;
    const cs = getComputedStyle(el);
    for (const k of ['font', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize', 'wordSpacing'] as const) mirror.style[k] = cs[k];
    mirror.scrollTop = el.scrollTop;
    const follow = () => (mirror.scrollTop = el.scrollTop);
    el.addEventListener('scroll', follow);
    return () => el.removeEventListener('scroll', follow);
  });
  if (!text.includes('@')) return null;
  return (
    <div className="composer-mirror" ref={ref} aria-hidden>
      {splitMentions(text).map((p, i) => (p.path ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
      {'\u200b'}
    </div>
  );
}
