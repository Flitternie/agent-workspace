import { describe, expect, it } from 'vitest';
import { shellContext } from '../../src/main/workspace';
import { cleanUserText } from '../../src/main/providers/user-text';
import { unwrapShell } from '../../src/main/providers/codex-content';

describe('!command', () => {
  it('hands the output to the agent in Claude Code’s own bash-mode markup', () => {
    expect(shellContext('git status', 'On branch main\n', '')).toBe('<bash-input>git status</bash-input>\n<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>');
  });

  it('keeps the end of very long output', () => {
    const ctx = shellContext('yes', 'x'.repeat(30_000) + 'END', '');
    expect(ctx.length).toBeLessThan(21_000);
    expect(ctx).toContain('…');
    expect(ctx).toContain('END</bash-stdout>');
  });

  it('shows a saved bash-mode turn as the command and its output', () => {
    expect(cleanUserText('<bash-input>ls</bash-input>\n<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>\n\nwhat is in a.txt?')).toBe('`! ls`\n\n```\na.txt\n```\n\n\nwhat is in a.txt?');
  });
});

describe('Codex !command title', () => {
  it('shows the command as typed, not the shell wrapper', () => {
    expect(unwrapShell("/bin/zsh -lc 'cat a.txt && echo MARK-$((6*7))'")).toBe('cat a.txt && echo MARK-$((6*7))');
    expect(unwrapShell("/bin/bash -c 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShell('git status')).toBe('git status');
  });
});
