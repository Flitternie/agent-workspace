import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A lost brace (twice so far, both in merges) nests every later rule under the one left open, and
// CSS nesting makes the page still load, just wrong. Catch it here.
describe('styles.css', () => {
  it('closes every rule it opens', () => {
    const css = readFileSync(join(__dirname, '../../src/renderer/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    let line = 1;
    const open: number[] = [];
    for (const ch of css) {
      if (ch === '\n') line++;
      else if (ch === '{') open.push(line), depth++;
      else if (ch === '}') {
        expect(depth, `extra } on line ${line}`).toBeGreaterThan(0);
        open.pop();
        depth--;
      }
    }
    expect(open, 'rules opened on these lines are never closed').toEqual([]);
  });
});
