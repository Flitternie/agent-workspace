// Opt-in: one short answer from each installed CLI, under the user's login, saving no session.
//   AMW_E2E_REAL=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/oneshot-real.test.ts
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/main/providers/claude';
import { CodexAdapter } from '../../src/main/providers/codex';
import { findExecutable } from '../../src/main/util/exec';

const enabled = process.env.AMW_E2E_REAL === '1';

/** Files under a folder, recursively (sessions are saved as files there). */
function files(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? files(join(dir, e.name)) : 1), 0);
}

const SYSTEM = 'Answer with a single word only.';
const PROMPT = 'Which area does this coding task belong to: "Add an index to the orders table and a migration for it"? One word, e.g. Database, Frontend, Docs.';

describe.runIf(enabled)('one-shot answers from the CLIs', () => {
  it.runIf(!!findExecutable('claude'))('Claude Code', async () => {
    const dir = join(homedir(), '.claude', 'projects');
    const before = files(dir);
    const answer = await new ClaudeAdapter().oneShot(SYSTEM, PROMPT);
    expect(answer).toMatch(/database/i);
    expect(files(dir)).toBe(before);
  }, 120_000);

  it.runIf(!!findExecutable('codex'))('Codex', async () => {
    const dir = join(homedir(), '.codex', 'sessions');
    const before = files(dir);
    const answer = await new CodexAdapter().oneShot(SYSTEM, PROMPT);
    expect(answer).toMatch(/database/i);
    expect(files(dir)).toBe(before);
  }, 150_000);
});
