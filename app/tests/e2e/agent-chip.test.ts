import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';
const appDir = resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

// Another agent mentioned in a sent message is a chip with its name; clicking it opens that agent.
it('an agent mentioned in a message opens on click', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amw-ac-')));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, HOME: home, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-acd-')), AMW_MOCK_DELAY_MS: '20', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.waitForSelector('.app');
  const inv = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as any).amw.invoke(c, p), [c, p] as const) as Promise<any>;
  await inv('settings:update', { onboarding: { dismissed: true } });
  writeFileSync(join(home, 'README.md'), 'x');
  execFileSync('git', ['init', '-q'], { cwd: home });
  const p = await inv('project:add', { rootPath: home, name: 'shop' });
  const plan = await inv('task:create', { projectId: p.projectId, provider: 'mock', title: 'Checkout plan', name: 'checkout-plan', mockScript: 'quick', isolate: false });
  const search = await inv('task:create', { projectId: p.projectId, provider: 'mock', title: 'Search page', name: 'search-page', mockScript: 'quick', isolate: false });
  await page.locator(`[data-testid="rail-item"][data-alias="${search.alias}"]`).click();
  const box = page.getByTestId('composer-input');
  await box.fill('Follow @checkout-plan for the button.');
  // Marked in the box like a file.
  await expect.poll(() => page.locator('.composer-mirror mark').allInnerTexts()).toEqual(['@checkout-plan']);
  await box.press('Enter');
  const chip = page.locator('.msg.user [data-testid="mention-chip"][data-agent="checkout-plan"]');
  await expect.poll(() => chip.innerText(), { timeout: 5000 }).toContain('checkout-plan');
  await chip.click();
  await expect.poll(() => page.locator(`[data-testid="rail-item"][data-alias="${plan.alias}"]`).getAttribute('class'), { timeout: 5000 }).toMatch(/active|selected|focused/);
  await app.close();
}, 120000);
