// New agent: no title or name to make up; created empty, its first message says what it is for.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
afterAll(async () => {
  await app?.close().catch(() => {});
});
const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

describe('new agent', () => {
  it('creates an agent with nothing filled in; its first message names it', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    // Folders where sessions "ran" (a fixture, never this Mac's real sessions): one to pick, one inside nothing.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-found-')));
    const shop = join(scratch, 'billing-service');
    mkdirSync(shop);
    execFileSync('git', ['init', '-q'], { cwd: shop });
    // A machine "devbox" reached through a fake `ssh` that runs its commands here (another HOME);
    // the app's own HOME lists it in ~/.ssh/config.
    const home = join(scratch, 'home');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    mkdirSync(join(home, 'Documents'));
    writeFileSync(join(home, '.ssh', 'config'), 'Host devbox\n  HostName 10.0.0.5\n  User dev\n');
    const remoteHome = join(scratch, 'remote-home');
    const train = join(scratch, 'gpu', 'train');
    mkdirSync(join(remoteHome, 'models'), { recursive: true });
    mkdirSync(train, { recursive: true });
    const localLib = join(scratch, 'local-lib');
    mkdirSync(localLib);
    execFileSync('git', ['init', '-q'], { cwd: localLib });
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ssh'), `#!/bin/bash\nfor a in "$@"; do [ "$a" = -G ] && { echo "hostname 10.0.0.5"; echo "user dev"; exit 0; }; done\nHOME="${remoteHome}" PATH=/usr/bin:/bin exec bash -c "\${@: -1}"\n`, { mode: 0o755 });
    const fixture = join(scratch, 'sessions.json');
    writeFileSync(
      fixture,
      JSON.stringify([
        { provider: 'claude', nativeSessionId: 's1', cwd: shop, title: 'Fix invoices', updatedAt: new Date().toISOString() },
        { provider: 'codex', nativeSessionId: 's2', cwd: shop, title: 'Add refunds', updatedAt: new Date().toISOString() },
        { provider: 'claude', nativeSessionId: 's3', cwd: join(scratch, 'ml-notes'), title: 'Read papers', updatedAt: new Date(Date.now() - 86400_000).toISOString() },
        { provider: 'claude', nativeSessionId: 's4', cwd: join(scratch, 'bot'), title: 'sub-agent', automated: true },
        { provider: 'codex', nativeSessionId: 's5', cwd: train, host: 'devbox', title: 'Train the model', updatedAt: new Date().toISOString() },
      ]),
    );
    // The demo entry offers mock agents in the dialog.
    app = await electron.launch({ executablePath: electronPath, args: [appDir], cwd: appDir, env: { ...env, AMW_MODE: 'demo', AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-new-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_DISCOVER_FIXTURE: fixture, HOME: home, PATH: `${bin}:${env.PATH}` } });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    await expect.poll(async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).projects.length, { timeout: 30_000 }).toBeGreaterThan(0);
    // The demo seeds its sample agents in the background: wait until they are all there.
    let last = -1;
    await expect
      .poll(async () => {
        const n = (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.length;
        const settled = n > 0 && n === last;
        last = n;
        return settled;
      }, { timeout: 30_000, interval: 1500 })
      .toBe(true);
    const before = (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.map((t) => t.taskId);

    await invoke(page, 'ssh:setEnabled', { host: 'devbox', enabled: true });
    await expect.poll(async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).remoteHosts.find((h) => h.host === 'devbox')?.ssh, { timeout: 30_000 }).toBe('ok');
    await page.getByTestId('new-task').first().click();
    const dialog = page.getByRole('dialog');
    const kinds = () => page.getByTestId('project-item').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-kind')}:${e.textContent?.trim().slice(0, 40)}`));
    const stage = () => page.getByTestId('project-pop').getAttribute('data-stage');
    // The project: the one used last, shown as a button that names its place.
    await expect.poll(() => page.getByTestId('project-current').innerText()).toContain('demo-shop');
    expect(await page.getByTestId('project-current').innerText()).toContain('This Mac');

    // Opened with a project chosen: straight to that place's folders (a way back to the places on top).
    await page.getByTestId('project-current').click();
    expect(await stage()).toBe('folder');
    expect(await page.getByTestId('project-back').innerText()).toContain('This Mac');
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('project-search');
    // This Mac: its projects, the folders where sessions ran here (automated ones left out), a folder dialog.
    await expect.poll(async () => (await kinds()).filter((k) => k.startsWith('found:')).length).toBe(2);
    const listed = await kinds();
    expect(listed[0]).toMatch(/^project:demo-shop/);
    expect(listed.filter((k) => k.startsWith('found:'))[0]).toMatch(/^found:billing-service/);
    expect(listed.some((k) => k.includes('bot') || k.includes('train'))).toBe(false);
    expect(listed.at(-1)).toMatch(/^browse:/);
    await page.screenshot({ path: join(shots, 'new-agent-00-projects.png') });
    // Search narrows it; Esc closes the list, not the dialog.
    await page.keyboard.type('billing');
    await expect.poll(async () => (await kinds()).filter((k) => !k.startsWith('browse')).map((k) => k.split(':')[0])).toEqual(['found']);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByTestId('project-pop').count()).toBe(0);
    expect(await dialog.count()).toBe(1);
    // Typed fast while folder listings arrive and re-render the list: not one keystroke lost.
    const longPath = `${scratch}/gpu/train/`;
    for (let round = 0; round < 3; round++) {
      await page.getByTestId('project-current').click();
      await page.keyboard.type(longPath);
      expect(await page.getByTestId('project-search').inputValue()).toBe(longPath);
      await page.keyboard.press('Escape');
    }
    // A found folder, picked with the keyboard, becomes the project.
    await page.getByTestId('project-current').click();
    await page.keyboard.type('billing');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('project-current').innerText()).toContain('billing-service');
    expect((await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).projects.some((p) => p.rootPath === shop)).toBe(true);

    // First the place: Backspace in the empty box goes back to the places (a searchable list, however many).
    await page.getByTestId('project-current').click();
    await page.keyboard.press('Backspace');
    await expect.poll(stage).toBe('place');
    expect(await kinds()).toEqual([expect.stringMatching(/^place:This Mac/), expect.stringMatching(/^place:devbox/)]);
    await page.keyboard.type('dev');
    await expect.poll(async () => (await kinds()).length).toBe(1);
    await page.screenshot({ path: join(shots, 'new-agent-00a-places.png') });
    await page.keyboard.press('Enter');
    await expect.poll(stage).toBe('folder');
    expect(await page.getByTestId('project-back').innerText()).toContain('devbox');
    // The machine: only the folders where sessions ran there.
    await expect.poll(async () => (await kinds()).map((k) => k.slice(0, 11))).toEqual(['found:train']);
    // ~ is that machine's home (its own, not this Mac's).
    await page.keyboard.type('~/');
    await expect.poll(async () => (await kinds()).filter((k) => k.startsWith('dir:'))).toEqual(['dir:models/Tab to open']);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    // Any folder on it by typing a path, completed from that machine (over ssh) as typed; Tab goes in.
    await page.keyboard.type(`${scratch}/g`);
    await expect.poll(async () => (await kinds()).filter((k) => k.startsWith('dir:'))).toEqual(['dir:gpu/Tab to open']);
    await page.screenshot({ path: join(shots, 'new-agent-00b-machine-path.png') });
    await page.keyboard.press('Tab');
    await expect.poll(() => page.getByTestId('project-search').inputValue()).toBe(`${scratch}/gpu/`);
    await expect.poll(async () => (await kinds()).filter((k) => k.startsWith('dir:'))).toEqual(['dir:train/Tab to open']);
    await page.keyboard.press('Tab');
    await expect.poll(() => page.getByTestId('project-search').inputValue()).toBe(`${scratch}/gpu/train/`);
    // Enter on "Use this folder" (highlighted once inside it): a project on the machine.
    await expect.poll(async () => (await kinds())[0]).toMatch(/^use:Use this folderdevbox:/);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('project-current').innerText()).toContain('train');
    expect(await page.getByTestId('project-current').innerText()).toContain('devbox');
    expect((await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).projects.some((p) => p.host === 'devbox' && p.rootPath === train)).toBe(true);

    // This Mac, by path too: completion from this Mac's folders.
    await page.getByTestId('project-current').click();
    expect(await page.getByTestId('project-back').innerText()).toContain('devbox');
    await page.getByTestId('project-back').click();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('project-back').innerText()).toContain('This Mac');
    // A Chinese input method's punctuation (～ and 、) still types a path.
    await page.keyboard.type('～、');
    await expect.poll(() => page.getByTestId('project-search').inputValue()).toBe('~/');
    await expect.poll(async () => (await kinds()).filter((k) => k.startsWith('dir:'))).toEqual(['dir:Documents/Tab to open']);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(`${scratch}/lo`);
    await expect.poll(async () => (await kinds()).filter((k) => k.startsWith('dir:'))).toEqual(['dir:local-lib/Tab to open']);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByTestId('project-current').innerText()).toContain('local-lib');
    expect(await page.getByTestId('project-current').innerText()).toContain('This Mac');

    // Nothing to name or write: no label, title or first-instruction box (the first message goes in the agent's reply box).
    expect(await dialog.locator('input.input').count()).toBe(0);
    expect(await dialog.locator('textarea').count()).toBe(0);
    expect(await page.getByTestId('new-instruction').count()).toBe(0);
    // A quiet line for someone who meant to continue an existing conversation.
    expect(await page.getByTestId('new-continue-hint').innerText()).toContain('Continuing a conversation from Claude Code or Codex?');
    // At the top of the dialog, before the project and provider choices.
    const hintTop = (await page.getByTestId('new-continue-hint').boundingBox())!.y;
    expect(hintTop).toBeLessThan((await page.locator('.modal .field').first().boundingBox())!.y);
    await dialog.locator('label.radio').filter({ hasText: 'Mock' }).click();
    await page.screenshot({ path: join(shots, 'new-agent-01-dialog.png') });
    expect(await page.getByTestId('create-agent').isEnabled()).toBe(true);
    await page.getByTestId('create-agent').click();

    // Created and opened, waiting for its first message, the box ready to type in.
    let fresh = '';
    await expect
      .poll(async () => {
        const s = await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {});
        fresh = s.tasks.find((t) => !before.includes(t.taskId))?.taskId ?? '';
        return fresh;
      })
      .not.toBe('');
    const task = async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).tasks.find((t) => t.taskId === fresh)!;
    expect((await task()).title).toBe('');
    expect((await task()).name).toBe((await task()).alias);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('composer-input');

    // Its first message is what the task is, and what its name is made from.
    await page.keyboard.type('Migrate the orders API to v2');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await task()).title).toBe('Migrate the orders API to v2');
    await expect.poll(async () => (await task()).name).not.toBe((await task()).alias);
    // The header does not repeat its messages: with no session map yet, it names no task.
    expect(await page.locator('.focus-meta').innerText()).not.toContain('Migrate the orders API to v2');
    expect(await page.getByTestId('focus-work').count()).toBe(0);
    await page.screenshot({ path: join(shots, 'new-agent-02-named.png') });

    // The hint's link swaps the New agent dialog for Continue a session… (same as the sidebar's history button).
    await page.getByTestId('sidebar-new-task').click();
    await page.getByTestId('menu-new-agent').click();
    await page.getByTestId('new-continue-session').click();
    await expect.poll(() => page.getByTestId('session-search').count()).toBe(1);
    expect(await page.getByTestId('create-agent').count()).toBe(0);
    expect(await page.getByRole('dialog').count()).toBe(1);
    await page.screenshot({ path: join(shots, 'new-agent-03-continue.png') });
  }, 120_000);
});
