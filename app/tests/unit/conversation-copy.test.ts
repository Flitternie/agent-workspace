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
