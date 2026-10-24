import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setLanguage, t } from '../../src/renderer/i18n';
import { zh } from '../../src/renderer/locales/zh';
import { aliasFor } from '../../src/main/store';

const root = join(__dirname, '../../src/renderer');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

describe('i18n', () => {
  it('has a Chinese string for every literal passed to t()', () => {
    const missing = new Set<string>();
    for (const f of files(root)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\b(?:t|tr)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
        const key = m[2].replace(/\\(.)/g, '$1');
        if (!(key in zh)) missing.add(key);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('keeps placeholders intact in translations', () => {
    for (const [en, cn] of Object.entries(zh)) {
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(cn), en).toEqual(vars(en));
    }
  });

  it('translates with placeholders and falls back to English', () => {
    setLanguage('zh');
    expect(t('{n} need you', { n: 2 })).toBe('2 个待你处理');
    expect(t('Something new')).toBe('Something new');
    setLanguage('en');
    expect(t('{n} need you', { n: 2 })).toBe('2 need you');
  });

  it('names agents per language and numbers repeats', () => {
    expect([0, 1, 2].map((n) => aliasFor(n))).toEqual(['Alice', 'Bob', 'Charlie']);
    expect([0, 1, 2].map((n) => aliasFor(n, 'zh'))).toEqual(['小王', '小李', '小张']);
    expect(aliasFor(26)).toBe('Alice2');
  });
});
