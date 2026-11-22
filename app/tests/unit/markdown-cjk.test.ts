import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';

// The renderer's Markdown reads emphasis that closes on CJK punctuation right before a letter, which
// CommonMark alone leaves as literal asterisks ("**结论。**由…").
const parse = (md: string) => unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly).use(remarkCjkFriendlyGfmStrikethrough).parse(md);
const kinds = (md: string) => {
  const out: string[] = [];
  const walk = (n: { type: string; children?: unknown[] }) => {
    out.push(n.type);
    for (const c of n.children ?? []) walk(c as never);
  };
  walk(unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly).use(remarkCjkFriendlyGfmStrikethrough).runSync(parse(md)) as never);
  return out;
};

describe('markdown with CJK punctuation', () => {
  it('reads bold, italic and strikethrough that close on CJK punctuation before a letter', () => {
    expect(kinds('2. **每个节点加一句话结论。**由 agent 在记录结果时写。')).toContain('strong');
    expect(kinds('3. **加"自上次查看以来"。**顶部一行写。')).toContain('strong');
    expect(kinds('这是*强调。*接着写')).toContain('emphasis');
    expect(kinds('这是~~删掉的。~~接着写')).toContain('delete');
  });

  it('leaves other text as it was', () => {
    expect(kinds('**Bold**, then text.')).toContain('strong');
    expect(kinds('2 * 3 * 4')).not.toContain('emphasis');
    expect(kinds('`a **b** c`')).not.toContain('strong');
  });
});
