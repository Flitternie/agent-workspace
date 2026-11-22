import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Icon } from './bits';

/** The side column's frame, the same for every kind of content (a file preview, an agent's memory). */
export interface SideFrame {
  /** Dragged by the user (FocusView keeps it); ignored while maximized. */
  width?: number;
  maximized?: boolean;
  onToggleMax?: () => void;
  onClose: () => void;
}

/**
 * One side panel: a title row that stays on top while the content scrolls (its own
 * actions, then maximize and close), an optional options row, and the content. Width,
 * maximizing and the resize bar are the frame's, so every kind of panel behaves alike.
 */
/**
 * `tabs`: the panel has tabs, as a browser's: they take the top row (with maximize and close), and the title
 * moves down to a quiet line at the top of the content.
 */
export function SidePanel({ title, subtitle, actions, options, tabs, label, testId, frame, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; options?: ReactNode; tabs?: ReactNode; label: string; testId: string; frame: SideFrame; children: ReactNode }) {
  const { width, maximized, onToggleMax, onClose } = frame;
  return (
    <aside className={`memory side-panel${maximized ? ' maximized' : ''}${tabs ? ' with-tabs' : ''}`} aria-label={label} data-testid={testId} style={width && !maximized ? { width } : undefined}>
      <div className="side-top">
        <div className="side-head">
          {tabs ?? (
            <div className="side-ident">
              <div className="panel-title truncate">{title}</div>
              {subtitle ? <div className="side-sub truncate">{subtitle}</div> : null}
            </div>
          )}
          {actions}
          {onToggleMax ? (
            <button className="icon-btn" title={maximized ? t('Back to the side (Esc)') : t('Maximize')} aria-label={maximized ? t('Back to the side (Esc)') : t('Maximize')} data-testid="side-maximize" onClick={onToggleMax}>
              <Icon name={maximized ? 'collapse' : 'expand'} size={13} />
            </button>
          ) : null}
          <button className="icon-btn" title={t('Close')} aria-label={t('Close')} data-testid="side-close" onClick={onClose}>
            <Icon name="x" size={13} />
          </button>
        </div>
        {options}
      </div>
      {tabs ? (
        <div className="side-title-line truncate" data-testid="side-title-line">
          <span className="panel-title">{title}</span>
          {subtitle ? <span className="side-sub"> · {subtitle}</span> : null}
        </div>
      ) : null}
      {children}
    </aside>
  );
}
