import type { Language } from '../shared/types';
import { zh } from './locales/zh';

// UI strings are written in English at the call site and looked up by that text,
// so English needs no table and a missing translation falls back to English.
// `{name}` placeholders are filled from `vars`. App sets the language from the
// workspace settings on every render; components call t() while rendering.

let current: Language = 'en';

export function setLanguage(lang: Language): void {
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

export function language(): Language {
  return current;
}

export function t(text: string, vars?: Record<string, string | number>): string {
  const s = (current === 'zh' && zh[text]) || text;
  return vars ? s.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}
