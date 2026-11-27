// Remote Control for Codex agents, against a fake `codex` on PATH (never the real one: enabling or
// pairing registers this computer with an OpenAI account). The fake speaks just enough app-server.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task, WorkspaceSnapshot } from '../../src/shared/types';

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

function repo(name: string): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-rcx-'))), name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

/**
 * The fake: `--version`, `login status` (ChatGPT) and `app-server`. In a folder named "legacy" it
 * has no remoteControl/* methods (an older Codex). The phone "claims" the code once `claimed` exists
 * in its state folder; every remoteControl request is logged there.
 */
function fakeCodex(state: string): string {
  const bin = join(state, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const STATE = ${JSON.stringify(state)};
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('codex-cli 0.162.1'); process.exit(0); }
if (a[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (a[0] !== 'app-server') process.exit(2);
const legacy = path.basename(process.cwd()) === 'legacy';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const status = (s) => ({ status: s, serverName: 'e2e-mac', installationId: 'inst', environmentId: s === 'disabled' ? null : 'env-1' });
let clients = [{ clientId: 'c-1', displayName: 'Old iPad', lastSeenAt: Math.floor(Date.now() / 1000) - 3600 }];
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    const ok = (result) => send({ id: m.id, result });
    if (m.method.startsWith('remoteControl/')) {
      fs.appendFileSync(path.join(STATE, 'calls.log'), JSON.stringify({ method: m.method, params: m.params }) + '\\n');
      if (legacy) { send({ id: m.id, error: { code: -32600, message: 'Invalid request: unknown variant \`' + m.method + '\`' } }); continue; }
    }
    switch (m.method) {
      case 'initialize': ok({ userAgent: 'fake' }); break;
      case 'thread/start': case 'thread/resume': ok({ thread: { id: 'thread-' + process.pid, turns: [] }, model: 'gpt-fake' }); break;
      case 'thread/list': case 'model/list': ok({ data: [] }); break;
      case 'account/read': ok({ account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true }); break;
      case 'configRequirements/read': ok({ requirements: null }); break;
      case 'remoteControl/enable': ok(status('connecting')); setTimeout(() => send({ method: 'remoteControl/status/changed', params: status('connected') }), 300); break;
      case 'remoteControl/disable': ok(status('disabled')); break;
      case 'remoteControl/pairing/start': ok({ pairingCode: 'qr-token', manualPairingCode: 'K7Q-4MZ', environmentId: 'env-1', expiresAt: Math.floor(Date.now() / 1000) + 600 }); break;
      case 'remoteControl/pairing/status': {
        const claimed = fs.existsSync(path.join(STATE, 'claimed'));
        if (claimed && !clients.some((c) => c.clientId === 'c-2')) clients = [{ clientId: 'c-2', displayName: 'My iPhone', lastSeenAt: Math.floor(Date.now() / 1000) }, ...clients];
        ok({ claimed }); break;
      }
      case 'remoteControl/client/list': ok({ data: clients, nextCursor: null }); break;
      case 'remoteControl/client/revoke': clients = clients.filter((c) => c.clientId !== m.params.clientId); ok({}); break;
      default: ok({});
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
  writeFileSync(join(bin, 'codex'), script);
  chmodSync(join(bin, 'codex'), 0o755);
  return bin;
}

describe('remote control (Codex)', () => {
  it('pairs a Codex agent with the ChatGPT app: code, expiry, status, devices, off; an old Codex says so', async () => {
    const state = realpathSync(mkdtempSync(join(tmpdir(), 'amw-rcx-fake-')));
    const bin = fakeCodex(state);
    const calls = () => (existsSync(join(state, 'calls.log')) ? readFileSync(join(state, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { method: string; params: unknown }) : []);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, PATH: `${bin}:${env.PATH ?? ''}`, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-rcx-data-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1', AMW_CODEX_PAIR_POLL_MS: '200' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    // Offered only with a ChatGPT login (the fake's `login status`).
    await expect.poll(async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).capabilities.find((c) => c.provider === 'codex')?.remoteControl, { timeout: 30_000 }).toBe(true);
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo('shop'), name: 'shop' });
    const old = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: repo('legacy'), name: 'legacy' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'codex', title: 'Orders', name: 'Orders', isolate: false });
    const b = await invoke<Task>(page, 'task:create', { projectId: old.projectId, provider: 'codex', title: 'Legacy', name: 'Legacy', isolate: false });
    const row = (name: string) => page.locator('[data-testid="rail-item"],[data-testid="needs-item"]').filter({ hasText: name }).first();
    const remote = async () => (await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).codexRemote;
    const pop = () => page.getByTestId('remote-pop').innerText();

    // On (connecting the session first): the code to type, its expiry, waiting for the phone.
    await row('Orders').click();
    await page.getByTestId('remote-control').click();
    await expect.poll(() => page.getByTestId('remote-control').getAttribute('aria-pressed'), { timeout: 30_000 }).toBe('true');
    await expect.poll(() => page.getByTestId('remote-code').innerText()).toBe('K7Q-4MZ');
    expect(await pop()).toMatch(/Expires in (9|10):\d\d/);
    expect(await pop()).toContain('ChatGPT app');
    expect(calls().find((c) => c.method === 'remoteControl/enable')?.params).toEqual({ ephemeral: true });
    // The link comes up; an earlier device shows with Unpair.
    await expect.poll(() => page.getByTestId('remote-status').innerText()).toContain('Waiting for your phone');
    await expect.poll(() => page.getByTestId('remote-device').count()).toBe(1);
    expect(await page.getByTestId('remote-device').innerText()).toContain('Old iPad');
    await page.screenshot({ path: join(shots, 'remote-codex-01-code.png') });

    // The phone enters the code: paired, the code goes, the new device is listed.
    writeFileSync(join(state, 'claimed'), '');
    await expect.poll(() => pop()).toContain('Paired.');
    expect(await page.getByTestId('remote-code').count()).toBe(0);
    await expect.poll(() => page.getByTestId('remote-device').count()).toBe(2);
    expect(await page.getByTestId('remote-status').innerText()).toContain('Connected');
    await page.screenshot({ path: join(shots, 'remote-codex-02-paired.png') });
    // Unpair the old device.
    await page.getByTestId('remote-device').filter({ hasText: 'Old iPad' }).getByTestId('remote-revoke').click();
    await expect.poll(() => page.getByTestId('remote-device').count()).toBe(1);
    expect(calls().find((c) => c.method === 'remoteControl/client/revoke')?.params).toEqual({ environmentId: 'env-1', clientId: 'c-1' });
    // Closing the popover leaves it on.
    await page.getByTestId('remote-pop-close').click();
    expect(await page.getByTestId('remote-control').getAttribute('aria-pressed')).toBe('true');
    // Off: the session keeps running here.
    await page.getByTestId('remote-control').click();
    await page.getByTestId('remote-off').click();
    await expect.poll(() => page.getByTestId('remote-control').getAttribute('aria-pressed')).toBe('false');
    expect((await remote())[a.taskId]).toBeUndefined();
    expect(calls().find((c) => c.method === 'remoteControl/disable')?.params).toEqual({ ephemeral: true });
    expect((await invoke<WorkspaceSnapshot>(page, 'workspace:snapshot', {})).connectedTaskIds).toContain(a.taskId);
    // On again, then the session stops: Remote Control goes with it.
    await page.getByTestId('remote-control').click();
    await expect.poll(async () => (await remote())[a.taskId]).toBeTruthy();
    await invoke(page, 'task:stop', { taskId: a.taskId });
    await expect.poll(async () => (await remote())[a.taskId]).toBeUndefined();

    // An older Codex without Remote Control: the reason, nothing turned on.
    await row('Legacy').click();
    await page.getByTestId('remote-control').click();
    await expect.poll(() => pop(), { timeout: 30_000 }).toContain('This Codex version has no Remote Control');
    expect(await pop()).not.toContain('API keys'); // the reason is the version, not the login
    expect((await remote())[b.taskId]).toBeUndefined();
    expect(await page.getByTestId('remote-control').getAttribute('aria-pressed')).toBe('false');
    await page.screenshot({ path: join(shots, 'remote-codex-03-old.png') });
  }, 150_000);
});
