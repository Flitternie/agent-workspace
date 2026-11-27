// The main agent's tool bridge script lives in the user's own folder, private to them, and is rewritten when
// its contents were changed.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { bridgeScript } from '../../src/main/providers/acp-mcp';

it('writes the bridge into ~/.agent-workspace/bin, private, and restores it when tampered with', () => {
  const home = mkdtempSync(join(tmpdir(), 'amw-bridge-home-'));
  const file = bridgeScript(home);
  expect(file.startsWith(join(home, '.agent-workspace', 'bin'))).toBe(true);
  expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, 'process.exit(1)');
  expect(bridgeScript(home)).toBe(file);
  expect(readFileSync(file, 'utf8')).toBe(original);
});
