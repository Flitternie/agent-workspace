// The Copy button on code blocks puts the code on the system clipboard (mock agents, no paid calls).
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;

afterAll(async () => {
  await app?.close().catch(() => {});
});

describe('code block copy', () => {
  it('copies the code to the clipboard', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-copy-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.app');
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'));

    // Bob's first report ends with a TypeScript snippet.
    const bob = page.locator('[data-testid="agent-card"][data-alias="Bob"]');
    await expect.poll(() => bob.getByTestId('card-summary').innerText(), { timeout: 15_000 }).toMatch(/Components 3\/5/);
    await bob.getByRole('button', { name: 'Open' }).click();
    const copy = page.locator('.md-copy').first();
    await copy.click();
    await expect.poll(() => copy.innerText()).toMatch(/Copied/);
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('export const total = (o: Order)');
  }, 60_000);
});
