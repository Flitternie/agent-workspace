import { describe, expect, it } from 'vitest';
import { inertHtml } from '../../src/main/documents';
import { parseDelimited } from '../../src/renderer/components/FilePreview';
import { previewKind } from '../../src/shared/preview';
import { shikiLang } from '../../src/renderer/highlight';

describe('preview rendering helpers', () => {
  it('splits CSV with quotes, escaped quotes, commas and line breaks inside quotes, and CRLF', () => {
    expect(parseDelimited('a,b,c\r\n1,"x, y",3\n2,"say ""hi""","multi\nline"\n', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', '3'],
      ['2', 'say "hi"', 'multi\nline'],
    ]);
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips anything runnable from converted documents', () => {
    const out = inertHtml('<p onclick="x()">Hi</p><script>alert(1)</script><iframe src="https://e.x"></iframe><a href="javascript:evil()">l</a><img src=x onerror=alert(1)><link rel="stylesheet" href="https://e.x/a.css">');
    expect(out).not.toMatch(/script|onclick|onerror|iframe|javascript:|<link/i);
    expect(out).toContain('<p>Hi</p>');
  });

  it('knows PDFs and office documents, and picks grammars by extension', () => {
    expect(previewKind('a/report.pdf')).toBe('pdf');
    expect(['x.docx', 'x.doc', 'x.rtf', 'x.odt'].map(previewKind)).toEqual(['document', 'document', 'document', 'document']);
    expect(shikiLang('src/App.tsx')).toBe('tsx');
    expect(shikiLang('main.rs')).toBe('rust');
    expect(shikiLang('notes.unknown')).toBeUndefined();
  });
});

import { splitTyped } from '../../src/renderer/components/ProjectChooser';

describe('typed folder paths', () => {
  it('splits a typed path into the folder to list and the name being typed', () => {
    expect(splitTyped('~')).toEqual({ parent: '~/', prefix: '' });
    expect(splitTyped('~/pro')).toEqual({ parent: '~/', prefix: 'pro' });
    expect(splitTyped('/srv/data/')).toEqual({ parent: '/srv/data/', prefix: '' });
    expect(splitTyped('/srv/da')).toEqual({ parent: '/srv/', prefix: 'da' });
    expect(splitTyped('billing')).toBeNull();
  });
});
