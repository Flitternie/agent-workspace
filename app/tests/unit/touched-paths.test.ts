import { describe, expect, it } from 'vitest';
import { touchedPaths } from '../../src/renderer/components/Content';
import type { TranscriptItem } from '../../src/shared/types';

const item = (diffPaths: string[], locations: string[]): TranscriptItem =>
  ({
    id: 't1',
    taskId: 'a',
    role: 'tool',
    text: '',
    createdAt: '',
    toolStatus: 'completed',
    tool: {
      name: 'Write',
      kind: 'edit',
      title: 'Write',
      locations: locations.map((path) => ({ path })),
      content: diffPaths.map((path) => ({ type: 'diff', diff: { path, operation: 'modify', phase: 'applied', hunks: [] } })),
    },
  }) as unknown as TranscriptItem;

describe('files a tool call touched', () => {
  it('one file written relative (its diff) and absolute (its location) is listed once', () => {
    expect(touchedPaths(item(['video/out/linkedin-post.md'], ['/Users/me/proj/video/out/linkedin-post.md']))).toEqual(['video/out/linkedin-post.md']);
  });

  it('also with ./ or Windows paths', () => {
    expect(touchedPaths(item(['./src/a.ts'], ['/repo/src/a.ts']))).toEqual(['./src/a.ts']);
    expect(touchedPaths(item(['src/a.ts'], ['C:\\repo\\src\\a.ts']))).toEqual(['src/a.ts']);
  });

  it('different files with the same name stay apart', () => {
    expect(touchedPaths(item(['docs/notes.md', 'notes.md'], []))).toEqual(['docs/notes.md', 'notes.md']);
    expect(touchedPaths(item(['a/notes.md', 'b/notes.md'], []))).toEqual(['a/notes.md', 'b/notes.md']);
  });
});
