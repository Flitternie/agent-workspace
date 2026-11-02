import { describe, expect, it } from 'vitest';
import { matches, PressGesture, released, SHORTCUT_RE, shortcutFrom, TAP_MS } from '../../src/renderer/voice/shortcut';

const key = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('microphone shortcut', () => {
  it('records a key press as a shortcut, and refuses ones that would fire while typing', () => {
    expect(shortcutFrom(key('Space', { altKey: true }))).toEqual({ shortcut: 'Alt+Space' });
    expect(shortcutFrom(key('KeyK', { metaKey: true, shiftKey: true }))).toEqual({ shortcut: 'Meta+Shift+K' });
    expect(shortcutFrom(key('F5'))).toEqual({ shortcut: 'F5' });
    expect(shortcutFrom(key('KeyK')).error).toBeTruthy();
    expect(shortcutFrom(key('KeyK', { shiftKey: true })).error).toBeTruthy();
    expect(shortcutFrom(key('Backquote', { altKey: true })).error).toBeTruthy();
    for (const s of ['Alt+Space', 'Meta+Shift+K', 'F5', 'Control+Up']) expect(SHORTCUT_RE.test(s), s).toBe(true);
  });

  it('matches only the exact modifiers, and ends a hold when the key or a modifier is let go', () => {
    expect(matches('Alt+Space', key('Space', { altKey: true }))).toBe(true);
    expect(matches('Alt+Space', key('Space', { altKey: true, shiftKey: true }))).toBe(false);
    expect(matches('Alt+Space', key('Space'))).toBe(false);
    expect(released('Alt+Space', key('Space', { altKey: true }))).toBe(true);
    expect(released('Alt+Space', key('AltLeft'))).toBe(true);
    expect(released('Alt+Space', key('ShiftLeft', { altKey: true }))).toBe(false);
  });
});

describe('push to talk presses', () => {
  const at = (ms: number[]) => {
    let i = 0;
    return () => ms[i++];
  };

  it('hold: talks while held, a quick tap is not speech', () => {
    const g = new PressGesture(at([0, 2000, 5000, 5100]));
    expect(g.down('hold', false)).toBe('start');
    expect(g.up('hold')).toBe('stop');
    expect(g.down('hold', false)).toBe('start');
    expect(g.up('hold')).toBe('cancel');
  });

  it('toggle: press to start, press again to send; key-up does nothing', () => {
    const g = new PressGesture(at([0, 50, 3000, 3050]));
    expect(g.down('toggle', false)).toBe('start');
    expect(g.up('toggle')).toBe('none');
    expect(g.down('toggle', true)).toBe('stop');
    expect(g.up('toggle')).toBe('none');
  });

  it('both: a tap toggles, a hold sends on release', () => {
    const g = new PressGesture(at([0, TAP_MS - 50, 4000, 4050, 6000, 6000 + TAP_MS + 500]));
    expect(g.down('both', false)).toBe('start');
    expect(g.up('both')).toBe('none'); // tap: stays on
    expect(g.down('both', true)).toBe('stop');
    expect(g.up('both')).toBe('none');
    expect(g.down('both', false)).toBe('start');
    expect(g.up('both')).toBe('stop'); // held
  });

  it('always on: a press mutes or unmutes; key repeat is ignored', () => {
    const g = new PressGesture(at([0, 10, 20, 30]));
    expect(g.down('open', true)).toBe('stop');
    expect(g.down('open', true)).toBe('none');
    expect(g.up('open')).toBe('none');
    expect(g.down('open', false)).toBe('start');
  });
});
