import type { MicMode } from '../../shared/types';

/**
 * The microphone shortcut (Settings › Voice), and what a press does in each mode:
 * - open:   the mic is on until muted; a press mutes / unmutes.
 * - toggle: a press starts talking, the next press sends.
 * - hold:   talk while the keys are held; releasing sends.
 * - both:   a quick tap works like toggle, holding works like hold.
 *
 * Shortcuts are stored as "Alt+Space", "Meta+Shift+K", "F5": modifiers in the
 * order Meta, Control, Alt, Shift, then one key. It works while the app is in front.
 */

export const MODIFIERS = ['Meta', 'Control', 'Alt', 'Shift'] as const;
type Modifier = (typeof MODIFIERS)[number];
export const SHORTCUT_RE = /^((Meta|Control|Alt|Shift)\+){0,4}(Space|[A-Z0-9]|F([1-9]|1[0-9])|Up|Down|Left|Right)$/;

const mac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** ⌥Space on a Mac; elsewhere Alt+Space opens the window menu. */
export function defaultShortcut(): string {
  return mac() ? 'Alt+Space' : 'Control+Shift+Space';
}

/** The key part of a keyboard event as stored in a shortcut, or '' for keys we do not use. */
export function baseKey(e: Pick<KeyboardEvent, 'code'>): string {
  if (e.code === 'Space') return 'Space';
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^F([1-9]|1[0-9])$/.test(e.code)) return e.code;
  if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) return e.code.slice(5);
  return '';
}

type Mods = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;
const held = (e: Mods): Record<Modifier, boolean> => ({ Meta: e.metaKey, Control: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey });

/** The shortcut a key press makes, or an error to show while recording one. */
export function shortcutFrom(e: Mods & Pick<KeyboardEvent, 'code'>): { shortcut?: string; error?: string } {
  const base = baseKey(e);
  if (!base) return { error: 'Use Space, a letter, a digit, an arrow or a function key.' };
  const mods = MODIFIERS.filter((m) => held(e)[m]);
  // A bare letter or Space would fire while typing; function keys are fine alone.
  if (!mods.length && !/^F\d/.test(base)) return { error: 'Hold at least one modifier key (⌘, ⌃, ⌥ or ⇧).' };
  if (mods.length === 1 && mods[0] === 'Shift' && !/^F\d/.test(base)) return { error: 'Shift alone types text; add ⌘, ⌃ or ⌥.' };
  return { shortcut: [...mods, base].join('+') };
}

export function matches(shortcut: string, e: Mods & Pick<KeyboardEvent, 'code'>): boolean {
  const parts = shortcut.split('+');
  const base = parts.pop();
  const h = held(e);
  return baseKey(e) === base && MODIFIERS.every((m) => h[m] === parts.includes(m));
}

/** Whether a key-up ends a held shortcut: its key, or one of its modifiers, was let go. */
export function released(shortcut: string, e: Mods & Pick<KeyboardEvent, 'code'>): boolean {
  const parts = shortcut.split('+');
  const base = parts.pop();
  if (baseKey(e) === base) return true;
  const h = held(e);
  return parts.some((m) => !h[m as Modifier]);
}

const MAC_SYMBOL: Record<string, string> = { Meta: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Up: '↑', Down: '↓', Left: '←', Right: '→' };
const PC_NAME: Record<string, string> = { Meta: 'Win', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Up: '↑', Down: '↓', Left: '←', Right: '→' };

/** Keycaps for display: ⌃⌥⇧⌘ order on a Mac, as in its menus. */
export function shortcutKeys(shortcut: string): string[] {
  const parts = shortcut.split('+');
  const base = parts.pop()!;
  if (!mac()) return [...parts.map((p) => PC_NAME[p] ?? p), PC_NAME[base] ?? base];
  const order = ['Control', 'Alt', 'Shift', 'Meta'];
  return [...parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((p) => MAC_SYMBOL[p]), MAC_SYMBOL[base] ?? base];
}

export function shortcutLabel(shortcut: string): string {
  return shortcutKeys(shortcut).join(mac() ? '' : '+');
}

/** Set while Settings records a new shortcut, so pressing it there does not open the mic. */
export const recording = { active: false };

export type PressAction = 'start' | 'stop' | 'cancel' | 'none';

/** Holds shorter than this are taps (`both`), or too short to be speech (`hold`). */
export const TAP_MS = 300;

/** Turns shortcut presses and releases into mic actions, one press at a time. */
export class PressGesture {
  private press?: { at: number; opened: boolean };
  constructor(private readonly now = Date.now) {}

  get pressed(): boolean {
    return !!this.press;
  }

  down(mode: MicMode, live: boolean): PressAction {
    if (this.press) return 'none'; // key repeat
    this.press = { at: this.now(), opened: !live };
    return live ? 'stop' : 'start';
  }

  up(mode: MicMode): PressAction {
    const p = this.press;
    this.press = undefined;
    if (!p?.opened) return 'none';
    const ms = this.now() - p.at;
    if (mode === 'hold') return ms < TAP_MS ? 'cancel' : 'stop';
    if (mode === 'both') return ms < TAP_MS ? 'none' : 'stop';
    return 'none';
  }

  reset(): void {
    this.press = undefined;
  }
}
