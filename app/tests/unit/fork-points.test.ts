import { describe, expect, it, vi } from 'vitest';

const messages = [
  { type: 'user', uuid: 'u1', message: { content: 'Build the API.' }, parent_tool_use_id: null },
  { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Done.' }] }, parent_tool_use_id: null },
  { type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, parent_tool_use_id: null },
  { type: 'user', uuid: 'u3', message: { content: 'This session is being continued from a previous conversation…' }, parent_tool_use_id: null, isCompactSummary: true, is_meta: true },
  { type: 'user', uuid: 'u4', message: { content: [{ type: 'text', text: 'Add tests.' }] }, parent_tool_use_id: null },
];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionMessages: async () => messages }));

describe('Claude fork points', () => {
  it('are the prompts the user typed, not interrupt markers or compact summaries', async () => {
    const { ClaudeAdapter } = await import('../../src/main/providers/claude');
    const points = await new ClaudeAdapter().forkPoints('s', '/repo');
    expect(points).toEqual([{ upToMessageId: 'u3', prompt: 'Add tests.' }]);
  });
});
