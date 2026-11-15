// First-run guide with fake CLIs (signed out until their login runs; no browser, no real account).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

/** Fake `claude` and `codex`: report "not signed in" until their own login command has run. */
function fakeClis(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amw-fakecli-'));
  mkdirSync(join(dir, 'state'));
  const claude = `#!/bin/bash
S="${dir}/state/claude"
if [ "$1" = auth ] && [ "$2" = status ]; then [ -f "$S" ] && { echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; }; echo '{"loggedIn":false}'; exit 1; fi
if [ "$1" = auth ] && [ "$2" = login ]; then echo "If the browser didn't open, visit: https://claude.ai/oauth/authorize?test=1"; sleep 2; touch "$S"; exit 0; fi
[ "$1" = --version ] && { echo "2.1.323 (Claude Code)"; exit 0; }
exit 1
`;
  const codex = `#!/bin/bash
S="${dir}/state/codex"
if [ "$1" = login ] && [ "$2" = status ]; then [ -f "$S" ] && { echo "Logged in using $(cat "$S")"; exit 0; }; echo "Not logged in"; exit 1; fi
if [ "$1" = login ] && [ "$2" = --with-api-key ]; then read -r k; case "$k" in sk-*) echo "an API key" > "$S"; exit 0;; esac; echo "Error: the API key was rejected" >&2; exit 1; fi
if [ "$1" = login ]; then echo "navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?test=1"; sleep 2; echo ChatGPT > "$S"; exit 0; fi
[ "$1" = --version ] && { echo "codex-cli 0.162.1"; exit 0; }
exit 1
`;
  writeFileSync(join(dir, 'claude'), claude, { mode: 0o755 });
  writeFileSync(join(dir, 'codex'), codex, { mode: 0o755 });
  // A fake `ssh`: "devbox" is reachable but has neither Claude Code nor Codex (commands run here,
  // with a PATH that has neither).
  const ssh = `#!/bin/bash
for a in "$@"; do [ "$a" = -G ] && { echo "hostname 10.0.0.5"; echo "user dev"; exit 0; }; done
cmd="\${@: -1}"
PATH=/usr/bin:/bin exec bash -c "$cmd"
`;
  writeFileSync(join(dir, 'ssh'), ssh, { mode: 0o755 });
  return dir;
}

/** A home with an SSH config listing "devbox" (and no sessions of its own). */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'amw-ob-home-'));
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'config'), 'Host devbox\n  HostName 10.0.0.5\n  User dev\n');
  return home;
}

function repo(name: string): string {
  const d = join(mkdtempSync(join(tmpdir(), 'amw-ob-')), name);
  mkdirSync(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  writeFileSync(join(d, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', '.'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: d });
  return d;
}

describe('first-run guide', () => {
  it('signs in from the app, brings work in from this Mac and other machines, and gets out of the way', async () => {
    const bin = fakeClis();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, HOME: fakeHome(), PATH: `${bin}:${env.PATH}`, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-ob-data-')), AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.waitForSelector('.app');
    const invoke = (c: string, p: unknown) => page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [c, p] as const);
    const state = (p: string) => page.getByTestId(`onboarding-${p}`).getAttribute('data-state');
    const done = (n: number) => page.getByTestId(`onboarding-step-${n}`).getAttribute('data-done');

    // A fresh workspace opens on the guide; both agents are installed but signed out.
    await expect.poll(() => page.getByTestId('onboarding').isVisible(), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => state('claude'), { timeout: 20_000 }).toBe('signed_out');
    await expect.poll(() => state('codex')).toBe('signed_out');
    expect(await done(2)).toBe('false');
    await page.screenshot({ path: join(shots, 'onboarding-01-signed-out.png') });

    // Claude: the app runs its login (the CLI would open the browser) and shows its link meanwhile.
    await page.getByTestId('onboarding-claude-login').click();
    await expect.poll(() => page.getByTestId('onboarding-claude-signing').isVisible()).toBe(true);
    await expect.poll(async () => (await page.getByTestId('onboarding-claude-link').getAttribute('href')) ?? '').toContain('claude.ai/oauth');
    await page.screenshot({ path: join(shots, 'onboarding-02-signing-in.png') });
    // Signed in: the step ticks itself off and folds (no Recheck); open again, Claude reads ready.
    await expect.poll(() => done(1), { timeout: 20_000 }).toBe('true');
    await page.getByTestId('onboarding-step-1').getByRole('button', { name: /Connect a coding agent/ }).click();
    expect(await state('claude')).toBe('ready');

    // Codex with an API key: a bad key says so; a good one signs in.
    await page.getByTestId('onboarding-codex-apikey').click();
    await page.getByTestId('onboarding-codex-key').fill('not-a-key-123');
    await page.getByTestId('onboarding-codex-key').press('Enter');
    await expect.poll(() => page.getByTestId('onboarding-codex').innerText()).toContain('rejected');
    await page.getByTestId('onboarding-codex-key').fill('sk-test-1234567');
    await page.getByTestId('onboarding-codex-key').press('Enter');
    await expect.poll(() => state('codex'), { timeout: 20_000 }).toBe('ready');
    await expect.poll(() => page.getByTestId('onboarding').innerText()).toContain('Your main agent');
    await page.screenshot({ path: join(shots, 'onboarding-03-connected.png') });

    // Bring work in (the folder picker is native, so the folder comes in through the same IPC).
    await expect.poll(() => page.getByTestId('onboarding-bring').isVisible()).toBe(true);
    await page.screenshot({ path: join(shots, 'onboarding-04-bring-in.png') });
    await invoke('project:add', { rootPath: repo('shop'), name: 'shop' });
    await expect.poll(() => done(2)).toBe('true');

    // Other machines: a host from ~/.ssh/config with no agent installed says how to install one there.
    await invoke('ssh:setEnabled', { host: 'devbox', enabled: true });
    await expect.poll(() => page.getByTestId('host-install').count(), { timeout: 30_000 }).toBe(2);
    expect(await page.getByTestId('host-devbox').innerText()).toContain('npm install -g @anthropic-ai/claude-code');
    await page.getByTestId('onboarding-step-3').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'onboarding-05-remote.png') });
    await page.getByTestId('onboarding-remote-skip').click();
    await expect.poll(() => done(3)).toBe('true');

    // Voice can wait; then the workspace, and the guide stays out of the way.
    await page.getByTestId('onboarding-voice-skip').click();
    await expect.poll(() => done(4)).toBe('true');
    await page.screenshot({ path: join(shots, 'onboarding-06-all-done.png') });
    await page.getByTestId('onboarding-done').click();
    await expect.poll(() => page.getByTestId('onboarding').count()).toBe(0);
    await expect.poll(() => page.getByTestId('new-task').isVisible()).toBe(true);

    // Settings can bring it back.
    await page.getByTestId('open-settings').click();
    await page.getByTestId('reopen-onboarding').click();
    await expect.poll(() => page.getByTestId('onboarding').isVisible()).toBe(true);
  }, 180_000);
});
