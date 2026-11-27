import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CHOICE_GAP, CHOICE_MIN_WIDTH, GRID_MAX_CHOICES, choiceColumns, choiceControl } from '../../src/renderer/choice-layout';
import { ProviderPicker } from '../../src/renderer/components/ProviderPicker';
import type { AgentProvider } from '../../src/shared/types';

const wide = 580; // the New agent dialog
const fits = (n: number) => n * CHOICE_MIN_WIDTH + (n - 1) * CHOICE_GAP;

describe('choice layout', () => {
  it('uses a grid up to the threshold, a dropdown beyond', () => {
    expect(GRID_MAX_CHOICES).toBe(4);
    for (const n of [1, 2, 3, 4]) expect(choiceControl(n)).toBe('grid');
    for (const n of [5, 6, 9]) expect(choiceControl(n)).toBe('dropdown');
  });

  it('puts two or three on one row when they fit, four as 2×2', () => {
    expect(choiceColumns(2, wide)).toBe(2);
    expect(choiceColumns(3, wide)).toBe(3);
    expect(choiceColumns(4, wide)).toBe(2);
    expect(choiceColumns(4, 2000)).toBe(2);
  });

  it('wraps evenly when the row is narrow, never leaving a lone option', () => {
    // Two fit: 3 → one per row, 4 → 2×2; one fits: a column.
    expect(choiceColumns(3, fits(2))).toBe(1);
    expect(choiceColumns(4, fits(2))).toBe(2);
    expect(choiceColumns(2, fits(1))).toBe(1);
    expect(choiceColumns(4, fits(1))).toBe(1);
    // Beyond the grid (should one be asked for): rows of three, evened out.
    expect(choiceColumns(6, wide)).toBe(3);
    expect(choiceColumns(5, wide)).toBe(3);
    expect(choiceColumns(5, fits(2))).toBe(2);
  });

  it('renders the picker as a grid or a dropdown by count', () => {
    const all: AgentProvider[] = ['claude', 'codex', 'opencode', 'antigravity', 'mock'];
    const render = (n: number) =>
      renderToStaticMarkup(
        createElement(ProviderPicker, {
          providers: [...all, ...all].slice(0, n) as AgentProvider[],
          value: 'claude',
          onChange: () => {},
          capOf: (p) => ({ provider: p, available: p !== 'codex', version: '2.4.2', detail: '' }) as never,
          usable: (p) => p !== 'codex',
        }),
      );
    for (const n of [2, 3, 4]) {
      const html = render(n);
      expect(html).toContain('data-control="grid"');
      expect(html.match(/<label class="radio/g)?.length).toBe(n);
      // The version is in the tooltip, not on the option.
      expect(html).not.toMatch(/>\s*2\.4\.2\s*</);
    }
    expect(render(4)).toContain('data-columns="2"');
    for (const n of [5, 6]) {
      const html = render(n);
      expect(html).toContain('data-control="dropdown"');
      expect(html).toContain('class="input select"');
      expect(html).toMatch(/<option[^>]*disabled=""[^>]*>Codex — not installed<\/option>/);
    }
  });
});
