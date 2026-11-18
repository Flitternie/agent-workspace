import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// An effect must return nothing or a cleanup function. A one-line `useEffect(() => x(), …)` returns
// whatever x returns; when that is a value (scrollIntoView returns a promise in current Chromium),
// React calls it as a cleanup and the whole window goes blank. One-liners stay to the safe forms:
// a state setter, `void …`, or returning a cleanup (`() => …`).
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('effects', () => {
  it('one-line effects only set state, discard with void, or return a cleanup', () => {
    const root = join(__dirname, '../../src/renderer');
    const bad = files(root).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => {
          const m = /useEffect\(\(\) => (?!\{)(.*)/.exec(line);
          if (!m) return [];
          return /^(set[A-Z]\w*\(|void |\(\) =>)/.test(m[1]) ? [] : [`${relative(root, f)}:${i + 1}: ${line.trim()}`];
        }),
    );
    expect(bad).toEqual([]);
  });
});
