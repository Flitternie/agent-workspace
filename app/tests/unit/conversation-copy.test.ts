import { describe, expect, it } from 'vitest';
import { CARRY_NOTE, conversationCopy, parseCopy } from '../../src/shared/conversation-copy';
import { forkCut } from '../../src/main/workspace';

describe('conversation copy', () => {
  it('round-trips text that looks like markup, and drops the note that came with it', () => {
    const lines = [
      { role: 'user' as const, text: 'Why <system-reminder>x</system-reminder> and </conversation-copy>?' },
      { role: 'assistant' as const, text: 'Because.' },
      { role: 'tool' as const, text: 'Read src/a.ts' },
    ];
    const text = conversationCopy(lines, `${CARRY_NOTE}\n\nGo on.`);
    expect(text.split('</conversation-copy>')).toHaveLength(2);
    expect(parseCopy(text)).toEqual({ lines, rest: 'Go on.' });
  });
});

describe('forkCut', () => {
  const items = [
    { role: 'user' as const, text: 'again' },
    { role: 'assistant' as const, text: 'one' },
    { role: 'user' as const, text: 'again' },
    { role: 'assistant' as const, text: 'two' },
    { role: 'user' as const, text: 'other' },
    { role: 'user' as const, text: 'again' },
  ];
  const points = [
    { upToMessageId: 'p1', prompt: 'again' },
    { upToMessageId: 'p2', prompt: 'other' },
    { upToMessageId: 'p3', prompt: 'again' },
  ];
  it('cuts just before the prompt a fork point names, counting repeats in order', () => {
    expect(forkCut(items, points, 'p1')).toBe(2);
    expect(forkCut(items, points, 'p2')).toBe(4);
    expect(forkCut(items, points, 'p3')).toBe(5);
    expect(forkCut(items, points, 'nope')).toBeUndefined();
  });
});

describe('carriedTool', () => {
  it('keeps a failed command’s error, a diff’s lines, and only the start of a file read', async () => {
    const { carriedTool } = await import('../../src/main/workspace');
    const noise = 'x'.repeat(10_000);
    const failed = carriedTool({
      text: '',
      toolStatus: 'failed',
      tool: { name: 'Bash', kind: 'execute', title: '$ npm test', locations: [], content: [{ type: 'terminal', command: 'npm test', output: `${noise}\nTypeError: total is undefined at checkout.ts:42`, exitCode: 1 }] },
    });
    expect(failed).toMatch(/^\$ npm test \(failed\)\nexit code 1\n/);
    expect(failed).toContain('TypeError: total is undefined at checkout.ts:42');
    expect(failed.length).toBeLessThan(3_200);

    const edit = carriedTool({
      text: '',
      toolStatus: 'completed',
      tool: { name: 'Edit', kind: 'edit', title: 'Edit src/a.ts', locations: [], content: [{ type: 'diff', diff: { path: 'src/a.ts', operation: 'modify', phase: 'applied', hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a = 1', '+a = 2'] }], added: 1, removed: 1 } }] },
    });
    expect(edit).toBe('Edit src/a.ts\nmodify src/a.ts (+1 -1)\n@@ -3,1 +3,1 @@\n-a = 1\n+a = 2');

    const read = carriedTool({ text: '', toolStatus: 'completed', tool: { name: 'Read', kind: 'read', title: 'Read src/big.ts', locations: [], content: [{ type: 'text', text: `start ${noise} end` }] } });
    expect(read.startsWith('Read src/big.ts\nstart ')).toBe(true);
    expect(read).not.toContain(' end');
    expect(read.length).toBeLessThan(400);
  });
});
