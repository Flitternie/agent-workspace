// How a set of choices (the coding agents, so far) is laid out, whatever their number: a few as a
// grid of equal options, rows evened out (2 → 1×2, 3 → 1×3, 4 → 2×2, never a lone option on a
// last row when that can be helped), many as one dropdown. Every provider picker follows this.

/** Up to this many choices: a grid of options; more: a dropdown. */
export const GRID_MAX_CHOICES = 4;
/** Never more options side by side than this (four read as a wall; 2×2 instead). */
export const MAX_CHOICE_COLUMNS = 3;
/** The narrowest an option gets: mark, radio and the longest name on one line. */
export const CHOICE_MIN_WIDTH = 150;
export const CHOICE_GAP = 8;

export function choiceControl(count: number): 'grid' | 'dropdown' {
  return count > GRID_MAX_CHOICES ? 'dropdown' : 'grid';
}

/**
 * Columns for `count` options in `width` pixels: as many as fit (at most MAX_CHOICE_COLUMNS), then
 * the most that divide the options into full rows; failing that (a prime count wider than one row),
 * rows as even as they get.
 */
export function choiceColumns(count: number, width: number, minWidth = CHOICE_MIN_WIDTH, gap = CHOICE_GAP): number {
  if (count <= 1) return 1;
  const fit = Math.max(1, Math.min(MAX_CHOICE_COLUMNS, Math.floor((width + gap) / (minWidth + gap))));
  if (count <= fit) return count;
  for (let c = fit; c > 1; c--) if (count % c === 0) return c;
  // e.g. 3 options where two fit: one per row (a 2+1 grid leaves an orphan).
  if (count <= GRID_MAX_CHOICES) return 1;
  return Math.ceil(count / Math.ceil(count / fit));
}
