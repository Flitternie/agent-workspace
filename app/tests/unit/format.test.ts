import { describe, expect, it } from 'vitest';
import { claudeToolCall } from '../../src/main/providers/claude-content';
import { codexItem } from '../../src/main/providers/codex-content';
import { cleanUserText } from '../../src/main/providers/user-text';

describe('session text cleanup', () => {
  it('drops harness markup and keeps what the person typed', () => {
    expect(cleanUserText('Fix the login bug\n<system-reminder>internal note</system-reminder>')).toBe('Fix the login bug');
    expect(cleanUserText('<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>src/app.ts</command-args>')).toBe('`/review src/app.ts`');
    expect(cleanUserText('<local-command-caveat>Caveat…</local-command-caveat>')).toBe('');
    expect(cleanUserText('<local-command-stdout>Compacted</local-command-stdout>')).toBe('```\nCompacted\n```');
    expect(cleanUserText('# AGENTS.md instructions for /repo\n\nUse pnpm.')).toBe('');
    expect(cleanUserText('<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>')).toBe('');
    // Ordinary angle brackets in what the user wrote stay.
    expect(cleanUserText('Rename <Button> to <IconButton>')).toBe('Rename <Button> to <IconButton>');
  });

  it('Codex history user messages are cleaned the same way', () => {
    const v = codexItem({ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '<environment_context><cwd>/r</cwd></environment_context>' }] }, { history: true, completed: true, cwd: '/r' });
    expect(v).toBeUndefined();
  });

  it('Bash shows its description; multi-line commands show the first line', () => {
    expect(claudeToolCall('Bash', { command: 'npx vitest run', description: 'Run unit tests' }, '/r').title).toBe('Run unit tests');
    expect(claudeToolCall('Bash', { command: "python3 - <<'EOF'\nprint(1)\nEOF" }, '/r').title).toBe("$ python3 - <<'EOF' …");
  });
});

import { headlineFor, summaryFor } from '../../src/main/attention';

describe('card reports from Markdown', () => {
  it('summaries skip tables, code and markup', () => {
    const md = '### Result\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAdded `total()` to **orders.ts**. See [docs](https://x.y).\n```ts\nconst x = 1;\n```';
    expect(summaryFor(md)).toBe('Result Added total() to orders.ts.');
    expect(headlineFor('- [ ] Ship it\n\nShould I open the PR?')).toBe('Ship it Should I open the PR?');
  });
});
