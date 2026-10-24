// Drives the built Electron app through the spec's end-to-end demo script with
// mock agents (no paid calls). Screenshots land in test-results/.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'amw-e2e-'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;

let app: ElectronApplication | undefined;

async function launch(): Promise<Page> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    cwd: appDir,
    env: { ...env, AMW_DATA_DIR: dataDir, AMW_MOCK_DELAY_MS: '120', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  await page.waitForSelector('.app');
  return page;
}

const card = (page: Page, alias: string) => page.locator(`[data-testid="agent-card"][data-alias="${alias}"]`);
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

afterAll(async () => {
  await app?.close().catch(() => {});
});

describe('end-to-end demo script (mock agents)', () => {
  it('runs the full journey and survives a restart', async () => {
    let page = await launch();
    // 1. Overview first.
    await page.getByTestId('load-demo').click();
    await expect.poll(() => page.getByTestId('agent-card').count()).toBe(3);
    // 3/4. Two substantive requests visible on their cards at once.
    await expect.poll(() => card(page, 'A').getByTestId('attention-item').filter({ hasText: 'compatibility adapter' }).count(), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => card(page, 'C').getByTestId('attention-item').filter({ hasText: 'data-loss risk' }).count(), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => card(page, 'B').getByTestId('card-summary').innerText(), { timeout: 15_000 }).toMatch(/Components 3\/5/);
    await shot(page, '01-overview-two-pending');

    // 4. Focus A and talk for 10 turns.
    await card(page, 'A').getByRole('button', { name: 'Open' }).click();
    const input = page.getByTestId('composer-input');
    await expect.poll(() => page.getByTestId('composer-target').innerText()).toContain('To: Agent A');
    for (let i = 1; i <= 10; i++) {
      await input.fill(`Turn ${i}: let's look at edge case ${i}`);
      await input.press('Enter');
      await expect.poll(() => page.getByTestId('transcript').innerText(), { timeout: 10_000 }).toContain(`turn ${i + 1}, I remember`);
    }
    // C's request stays visible in the rail while we talk to A.
    await expect.poll(() => page.locator('[data-testid="rail-item"][data-alias="C"]').innerText()).toContain('data-loss');
    await shot(page, '02-focus-A-after-10-turns');

    // 5. Back to overview: C's full request is still there; answer it from its card.
    await page.getByRole('button', { name: /^Overview/ }).click();
    const cItem = card(page, 'C').getByTestId('attention-item').filter({ hasText: 'data-loss risk' });
    await expect.poll(() => cItem.count()).toBe(1);
    await cItem.getByRole('button', { name: 'Reply to C' }).click();
    await card(page, 'C').locator('textarea').fill('Add a backfill step first, then proceed.');
    await card(page, 'C').locator('textarea').press('Enter');
    await expect.poll(() => card(page, 'C').getByTestId('attention-item').filter({ hasText: 'data-loss risk' }).count()).toBe(0);
    // A/C histories not intermixed.
    await card(page, 'C').getByRole('button', { name: 'Open' }).click();
    await expect.poll(() => page.getByTestId('transcript').innerText()).toContain('backfill');
    expect(await page.getByTestId('transcript').innerText()).not.toContain('edge case');

    // 6. Focus B; off-focus "voice" (typed into the global dock, same routing) to A.
    await page.locator('[data-testid="rail-item"][data-alias="B"]').click();
    await expect.poll(() => page.getByTestId('composer-target').innerText()).toContain('To: Agent B');
    const dock = page.getByTestId('dock-input');
    await dock.fill('Agent A, add a regression test');
    await dock.press('Enter');
    await expect.poll(() => page.getByTestId('route-preview').innerText()).toContain('Agent A');
    await shot(page, '03-dock-route-preview');
    await page.getByTestId('route-send').click();
    await expect.poll(() => page.getByTestId('caption').last().innerText()).toContain('Sent to Agent A');
    await expect.poll(() => page.getByTestId('composer-target').innerText()).toContain('To: Agent B'); // focus did not move
    expect(await page.getByTestId('transcript').innerText()).not.toContain('regression test');

    // 7. Ambiguous instruction: confirmation shown, nothing sent before selection.
    await dock.fill('look at that thing in the orders API schema');
    await dock.press('Enter');
    await expect.poll(() => page.getByTestId('route-preview').getAttribute('data-route-kind')).toMatch(/clarify|existing/);
    await shot(page, '04-dock-ambiguity');
    await dock.press('Escape');

    // 8. Typed text in B's composer goes to B.
    await input.fill('Use the shared Button component.');
    await input.press('Enter');
    await expect.poll(() => page.getByTestId('transcript').innerText()).toContain('Use the shared Button component.');

    // 11. Memory: save a project convention via the coordinator.
    await dock.fill('记住：这个项目总是先跑集成测试');
    await dock.press('Enter');
    await expect.poll(() => page.getByTestId('route-preview').getAttribute('data-route-kind')).toBe('coordinator');
    await page.getByTestId('route-send').click();
    await expect.poll(() => page.getByTestId('coordinator-log').innerText()).toContain('Saved to project');
    await expect.poll(() => page.getByTestId('memory-panel').innerText()).toContain('总是先跑集成测试');
    await shot(page, '05-focus-B-memory');

    // 9. Quit and relaunch: overview, cards, sessions and pending items restored.
    await app!.close();
    page = await launch();
    await expect.poll(() => page.getByTestId('agent-card').count()).toBe(3);
    await expect.poll(() => page.getByTestId('overview').isVisible()).toBe(true);
    await shot(page, '06-after-restart');
    // Resume A's native (mock) session with real prior context.
    await card(page, 'A').getByRole('button', { name: 'Open' }).click();
    await page.getByTestId('composer-input').fill('Where were we?');
    await page.getByTestId('composer-input').press('Enter');
    await expect.poll(() => page.getByTestId('transcript').innerText(), { timeout: 10_000 }).toMatch(/Resumed native mock session/);
    await expect.poll(() => page.getByTestId('transcript').innerText(), { timeout: 10_000 }).toMatch(/I remember (2[0-9]|[3-9][0-9]) prior messages/);
    // The native history replaces the display cache: no duplicated messages.
    expect(await page.locator('[data-role="user"]', { hasText: "Turn 1: let's look at edge case 1" }).count()).toBe(1);
    await shot(page, '07-resumed-A');
  });
});
