import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; testId?: string }
  | { swatches: readonly string[]; current?: number; onPick: (index: number) => void; label: string }
  | 'sep';

/** A small menu at the pointer (a right-click's): closes on a click away, Esc, or a choice; kept inside the window. */
export function ContextMenu({ x, y, items, onClose, testId }: { x: number; y: number; items: MenuItem[]; onClose: () => void; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [onClose]);
  const rows = items.filter((i) => i !== 'sep').length;
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - rows * 34 - 24);
  return createPortal(
    <div className="context-menu" ref={ref} style={{ left, top }} role="menu" data-testid={testId ?? 'context-menu'}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="context-sep" />
        ) : 'swatches' in it ? (
          <div key={i} className="context-swatches" role="group" aria-label={it.label}>
            {it.swatches.map((c, j) => (
              <button key={c} className={`context-swatch${it.current === j ? ' on' : ''}`} style={{ background: c }} aria-label={`${it.label} ${j + 1}`} aria-pressed={it.current === j} onClick={() => (it.onPick(j), onClose())} data-testid="context-swatch" />
            ))}
          </div>
        ) : (
          <button key={i} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => (it.onClick(), onClose())} data-testid={it.testId}>
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
