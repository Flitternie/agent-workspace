import { describe, expect, it } from 'vitest';
import { FILE_SCHEME, fileTarget, remarkFilePaths, splitPaths } from '../../src/renderer/components/filePaths';
import { resolveRequested } from '../../src/main/preview';

const paths = (text: string) => splitPaths(text).flatMap((p) => (p.path ? [p.path] : []));

describe('file paths in agent messages', () => {
  it('finds absolute, home and relative paths to previewable files', () => {
    expect(paths('Wrote /Users/me/proj/docs/report.md and ~/notes/todo.md.')).toEqual(['/Users/me/proj/docs/report.md', '~/notes/todo.md']);
    expect(paths('See docs/design.md, ./a.html, ../shared/b.json or README.md')).toEqual(['docs/design.md', './a.html', '../shared/b.json', 'README.md']);
    expect(paths('改好了 PROPOSAL_FULL.md，长版和短版一致')).toEqual(['PROPOSAL_FULL.md']);
    expect(paths('Icons in assets/logo@2x.png')).toEqual(['assets/logo@2x.png']);
  });

  it('drops :line, keeps the text as written', () => {
    const parts = splitPaths('at src/app.json:12:3 now');
    expect(parts.find((p) => p.path)).toEqual({ text: 'src/app.json:12:3', path: 'src/app.json' });
    expect(parts.map((p) => p.text).join('')).toBe('at src/app.json:12:3 now');
  });

  it('leaves URLs, code files and plain words alone', () => {
    expect(paths('https://github.com/x/y/blob/main/README.md and github.com/x/README.md')).toEqual([]);
    expect(paths('edit src/main.ts and run npm test; version 1.2.3')).toEqual([]);
  });

  it('reads whole code spans and link targets', () => {
    expect(fileTarget(' docs/a b.md ')).toBe('docs/a b.md');
    expect(fileTarget('file:///Users/me/a.md')).toBe('/Users/me/a.md');
    expect(fileTarget('docs/a%20b.md#intro')).toBe('docs/a b.md');
    expect(fileTarget('https://x.com/a.md')).toBeUndefined();
    expect(fileTarget('npm run build')).toBeUndefined();
  });

  it('turns text, inline code and file links into preview links, but not code blocks or web links', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', value: 'See docs/a.md and ' }, { type: 'inlineCode', value: '/abs/b.html' }, { type: 'text', value: ' or ' }, { type: 'link', url: 'c.json', children: [{ type: 'text', value: 'this' }] }] },
        { type: 'paragraph', children: [{ type: 'link', url: 'https://x.com', children: [{ type: 'text', value: 'x.com/d.md' }] }] },
        { type: 'code', value: 'cat e.md' },
      ],
    };
    remarkFilePaths()(tree as never);
    const p1 = tree.children[0].children as Array<{ type: string; url?: string }>;
    expect(p1.filter((n) => n.type === 'link').map((n) => decodeURIComponent(n.url!.slice(FILE_SCHEME.length)))).toEqual(['docs/a.md', '/abs/b.html', 'c.json']);
    expect((tree.children[1].children as Array<{ url?: string }>)[0].url).toBe('https://x.com');
    expect(tree.children[2]).toEqual({ type: 'code', value: 'cat e.md' });
  });
});

describe('resolving a path from a message', () => {
  it('relative to the agent’s folder, absolute as is, ~ from home', () => {
    expect(resolveRequested('/w/proj', 'docs/a.md', undefined, '/Users/me')).toBe('/w/proj/docs/a.md');
    expect(resolveRequested('/w/proj', '/etc/x.md', undefined, '/Users/me')).toBe('/etc/x.md');
    expect(resolveRequested('/w/proj', '~/notes/a.md', undefined, '/Users/me')).toBe('/Users/me/notes/a.md');
  });
});
