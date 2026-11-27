import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { Icon, type IconName } from './bits';

// The app's one right-click menu (agent rows, project heads, the agent's header, messages): a small
// panel at the pointer, in the page (no native menu), kept inside the window, worked with the
// keyboard (↑ ↓ Home End, Enter or Space to choose, Esc to close), and gone on a click elsewhere,
// a scroll, the window losing focus or resizing.

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Chosen (an item with `items` opens them instead). */
  onSelect?: () => void;
  disabled?: boolean;
  /** A submenu: opens beside the item (hover, → or Enter), closes with ← or by moving to another item. */
  items?: MenuItem[];
  /** The current choice among its siblings: shown with a tick. */
  checked?: boolean;
}

/** Where a menu opens and what is in it; `null` entries are dropped, `'-'` is a divider. */
export interface MenuState {
  x: number;
  y: number;
  items: Array<MenuItem | '-'>;
  /** data-testid of the panel (default "context-menu"). */
  testId?: string;
  /** Opened from the keyboard: the first item starts highlighted (from the pointer, nothing until it moves). */
  keyboard?: boolean;
}

/** Turns a contextmenu event into a menu at the pointer (or under the element, opened from the keyboard). */
export function menuAt(e: ReactMouseEvent, items: Array<MenuItem | '-' | null | false | undefined>, testId?: string): MenuState {
  e.preventDefault();
  e.stopPropagation();
  let { clientX: x, clientY: y } = e;
  // Shift+F10 / the menu key: no pointer, so under the element itself.
  const keyboard = !x && !y;
  if (keyboard) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    x = r.left + 12;
    y = r.bottom - 4;
  }
  return { x, y, items: items.filter((i): i is MenuItem | '-' => !!i), testId, keyboard };
}

/** Shift+F10 or the menu key on a focused element (macOS sends no contextmenu for them): the menu under it. */
export function menuKey(e: ReactKeyboardEvent, items: () => Array<MenuItem | '-' | null | false | undefined>, testId?: string): MenuState | null {
  if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return null;
  e.preventDefault();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left + 12, y: r.bottom - 4, items: items().filter((i): i is MenuItem | '-' => !!i), testId, keyboard: true };
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  const items = menu.items;
  const enabled = items.map((it, i) => (it !== '-' && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState(menu.keyboard ? (enabled[0] ?? -1) : -1);
  const close = useRef(onClose);
  close.current = onClose;
  // The open submenu: which item's, where that item is, and its highlight (-1: the pointer or keys are still on the menu).
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);
  const [subActive, setSubActive] = useState(-1);
  const subRef = useRef<HTMLDivElement>(null);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  const subItems = sub ? ((items[sub.index] as MenuItem).items ?? []) : [];
  const subEnabled = subItems.map((it, i) => (!it.disabled ? i : -1)).filter((i) => i >= 0);
  const openSub = (i: number, keyboard: boolean) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
    if (!el) return;
    setSub({ index: i, rect: el.getBoundingClientRect() });
    setSubActive(keyboard ? (((items[i] as MenuItem).items ?? []).findIndex((x) => !x.disabled)) : -1);
  };
  // Beside its item, on whichever side has room, inside the window.
  useLayoutEffect(() => {
    const el = subRef.current;
    if (!sub || !el) return setSubPos(null);
    const { width, height } = el.getBoundingClientRect();
    const pad = 6;
    let left = sub.rect.right + 2;
    if (left + width > window.innerWidth - pad) left = Math.max(pad, sub.rect.left - width - 2);
    const top = Math.max(pad, Math.min(sub.rect.top - 4, window.innerHeight - pad - height));
    setSubPos({ left, top });
  }, [sub]);

  // Inside the window: flipped to the pointer's other side when it would run off an edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 6;
    let left = menu.x;
    let top = menu.y;
    if (left + width > window.innerWidth - pad) left = Math.max(pad, Math.min(menu.x - width, window.innerWidth - pad - width));
    if (top + height > window.innerHeight - pad) top = Math.max(pad, Math.min(menu.y - height, window.innerHeight - pad - height));
    setPos({ left, top });
  }, [menu.x, menu.y, items.length]);

  // Focus moves into the menu (so the keys work), and back where it was when the menu closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (before && document.contains(before) && !document.activeElement?.closest('input, textarea')) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const done = () => close.current();
    const away = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) done();
    };
    // Esc closes it wherever focus is, before anything else hears it (Esc also steps back a view).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      done();
    };
    // Scrolling by hand (wheel, a scrollbar's mousedown) closes it; a conversation streaming in below does not.
    window.addEventListener('mousedown', away, true);
    window.addEventListener('wheel', away, true);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('blur', done);
    window.addEventListener('resize', done);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('wheel', away, true);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('blur', done);
      window.removeEventListener('resize', done);
    };
  }, []);

  const choose = (i: number) => {
    const it = items[i];
    if (!it || it === '-' || it.disabled) return;
    if (it.items) return openSub(i, true);
    onClose();
    it.onSelect?.();
  };
  const chooseSub = (j: number) => {
    const it = subItems[j];
    if (!it || it.disabled) return;
    onClose();
    it.onSelect?.();
  };
  const step = (by: number) => {
    if (!enabled.length) return;
    const at = enabled.indexOf(active);
    // Nothing highlighted yet: ↓ starts at the top, ↑ at the bottom.
    setActive(at < 0 ? enabled[by > 0 ? 0 : enabled.length - 1] : enabled[(at + by + enabled.length) % enabled.length]);
  };

  return createPortal(
    <div
      className="context-menu"
      ref={ref}
      style={pos}
      role="menu"
      tabIndex={-1}
      data-testid={menu.testId ?? 'context-menu'}
      // In a portal, React still bubbles its events to whatever opened it: they stop here.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const inSub = !!sub && subActive >= 0;
        const subStep = (by: number) => {
          if (!subEnabled.length) return;
          const at = subEnabled.indexOf(subActive);
          setSubActive(subEnabled[(at + by + subEnabled.length) % subEnabled.length]);
        };
        const keys: Record<string, () => void> = inSub
          ? {
              ArrowDown: () => subStep(1),
              ArrowUp: () => subStep(-1),
              ArrowLeft: () => {
                setSub(null);
                setSubActive(-1);
              },
              Enter: () => chooseSub(subActive),
              ' ': () => chooseSub(subActive),
              Tab: () => onClose(),
            }
          : {
              ArrowDown: () => step(1),
              ArrowUp: () => step(-1),
              ArrowRight: () => {
                const it = items[active];
                if (it && it !== '-' && it.items && !it.disabled) openSub(active, true);
              },
              Home: () => setActive(enabled[0] ?? -1),
              End: () => setActive(enabled.at(-1) ?? -1),
              Enter: () => choose(active),
              ' ': () => choose(active),
              Tab: () => onClose(),
            };
        const fn = keys[e.key];
        if (!fn) return;
        e.preventDefault();
        e.stopPropagation();
        fn();
      }}
    >
      {items.map((it, i) =>
        it === '-' ? (
          <div key={`sep-${i}`} className="context-menu-sep" role="separator" />
        ) : (
          <button
            key={it.id}
            role="menuitem"
            tabIndex={-1}
            disabled={it.disabled}
            className={i === active || sub?.index === i ? 'active' : undefined}
            data-testid={`menu-${it.id}`}
            data-index={i}
            aria-haspopup={it.items ? 'menu' : undefined}
            aria-expanded={it.items ? sub?.index === i : undefined}
            onMouseEnter={() => {
              if (it.disabled) return;
              setActive(i);
              if (it.items) openSub(i, false);
              else setSub(null);
            }}
            onMouseLeave={() => !it.items && setActive(-1)}
            onClick={() => choose(i)}
          >
            {it.checked ? <Icon name="check" size={13} /> : it.icon ? <Icon name={it.icon} size={13} /> : <span className="context-menu-gap" aria-hidden />}
            <span className="context-menu-label">{it.label}</span>
            {it.items ? <Icon name="chevron" size={11} /> : null}
          </button>
        ),
      )}
      {sub ? (
        <div className="context-menu context-submenu" ref={subRef} role="menu" style={subPos ?? { left: sub.rect.right + 2, top: sub.rect.top - 4, visibility: 'hidden' }} data-testid={`menu-${(items[sub.index] as MenuItem).id}-items`}>
          {subItems.map((it, j) => (
            <button
              key={it.id}
              role="menuitem"
              tabIndex={-1}
              disabled={it.disabled}
              className={j === subActive ? 'active' : undefined}
              data-testid={`menu-${it.id}`}
              onMouseEnter={() => !it.disabled && setSubActive(j)}
              onMouseLeave={() => setSubActive(-1)}
              onClick={() => chooseSub(j)}
            >
              {it.checked ? <Icon name="check" size={13} /> : it.icon ? <Icon name={it.icon} size={13} /> : <span className="context-menu-gap" aria-hidden />}
              <span className="context-menu-label">{it.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/** A menu's state and its element, for a component with one menu at a time. */
export function useContextMenu(): { open: (m: MenuState) => void; element: ReactNode } {
  const [menu, setMenu] = useState<MenuState | null>(null);
  return { open: setMenu, element: menu ? <ContextMenu key={`${menu.x},${menu.y}`} menu={menu} onClose={() => setMenu(null)} /> : null };
}

/**
 * A name edited where it stands: Enter or leaving the field saves, Esc cancels, an empty or
 * unchanged name cancels. `check` refuses a name with a message shown under the field (Enter keeps
 * editing; leaving drops the edit). A failed save shows its message and keeps editing.
 */
export function InlineEdit({
  value,
  onSave,
  onDone,
  check,
  label,
  testId = 'inline-edit',
  className = '',
}: {
  value: string;
  onSave: (v: string) => Promise<unknown> | void;
  onDone: () => void;
  check?: (v: string) => string | null;
  label: string;
  testId?: string;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const [problem, setProblem] = useState<string | null>(null);
  const settled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // The message hangs under the field on the page itself, so a narrow list's edge does not cut it.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = problem ? input.current?.getBoundingClientRect() : undefined;
    setAt(r ? { left: Math.max(6, Math.min(r.left, window.innerWidth - 270)), top: r.bottom + 4 } : null);
  }, [problem]);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = () => {
    settled.current = true;
    onDone();
  };
  const commit = async (leaving: boolean) => {
    if (settled.current) return;
    const v = text.replace(/\s+/g, ' ').trim();
    if (!v || v === value.trim()) return finish();
    const why = check?.(v) ?? null;
    if (why) {
      if (leaving) return finish();
      setProblem(why);
      return;
    }
    settled.current = true;
    try {
      await onSave(v);
      onDone();
    } catch (e) {
      settled.current = false;
      const raw = e instanceof Error ? e.message : String(e);
      setProblem(t(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
      input.current?.focus();
    }
  };
  return (
    <span className={`inline-edit ${className}`} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input
        ref={input}
        className={`input inline${problem ? ' invalid' : ''}`}
        value={text}
        aria-label={label}
        aria-invalid={!!problem}
        data-testid={testId}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setProblem(null);
        }}
        onBlur={() => void commit(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void commit(false);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish();
          }
        }}
      />
      {problem && at
        ? createPortal(
            <span className="inline-edit-problem" style={at} role="alert" data-testid={`${testId}-problem`}>
              {problem}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
