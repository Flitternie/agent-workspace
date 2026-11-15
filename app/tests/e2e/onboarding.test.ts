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
  // A fake `ssh`: "devbox" is reachable, with neither Claude Code nor Codex until "installed".
  // Commands run here, as another user (its own HOME). Installers are never run: asked to install,
  // it puts fake CLIs in that HOME's ~/.local/bin, which sign in with a pasted code (Claude) or a
  // device code (Codex).
  const remoteHome = mkdtempSync(join(tmpdir(), 'amw-remote-home-'));
  const remoteBin = join(remoteHome, '.local', 'bin');
  const remoteClaude = `#!/bin/bash
S="${remoteHome}/claude-in"
if [ "$1" = auth ] && [ "$2" = status ]; then [ -f "$S" ] && { echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; }; echo '{"loggedIn":false}'; exit 1; fi
if [ "$1" = auth ] && [ "$2" = login ]; then echo "Open this link to sign in: https://claude.ai/oauth/authorize?remote=1"; echo "Paste code here if prompted >"; read -r c; [ "$c" = good-code ] && { touch "$S"; exit 0; }; echo "Invalid code" >&2; exit 1; fi
[ "$1" = --version ] && { echo "2.1.323 (Claude Code)"; exit 0; }
exit 1
`;
  const remoteCodex = `#!/bin/bash
S="${remoteHome}/codex-in"
if [ "$1" = login ] && [ "$2" = status ]; then [ -f "$S" ] && { echo "Logged in using ChatGPT"; exit 0; }; echo "Not logged in"; exit 1; fi
if [ "$1" = login ] && [ "$2" = --device-auth ]; then echo "Open https://auth.openai.com/codex/device and enter the code ABCD-1234"; sleep 2; touch "$S"; exit 0; fi
[ "$1" = --version ] && { echo "codex-cli 0.162.1"; exit 0; }
exit 1
`;
  writeFileSync(join(dir, 'remote-claude'), remoteClaude, { mode: 0o755 });
  writeFileSync(join(dir, 'remote-codex'), remoteCodex, { mode: 0o755 });
  const ssh = `#!/bin/bash
for a in "$@"; do [ "$a" = -G ] && { echo "hostname 10.0.0.5"; echo "user dev"; exit 0; }; done
cmd="\${@: -1}"
sleep 1
case "$cmd" in
  *claude.ai/install.sh*) mkdir -p "${remoteBin}"; cp "${dir}/remote-claude" "${remoteBin}/claude"; echo "Claude Code installed"; exit 0;;
  *chatgpt.com/codex/install.sh*) mkdir -p "${remoteBin}"; cp "${dir}/remote-codex" "${remoteBin}/codex"; echo "Codex installed"; exit 0;;
esac
HOME="${remoteHome}" PATH=/usr/bin:/bin exec bash -c "$cmd"
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
    expect(await done(3)).toBe('false');
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

    // Other machines (before bringing work in): a host with no agent says how to get one there.
    await invoke('ssh:setEnabled', { host: 'devbox', enabled: true });
    await expect.poll(() => page.getByTestId('host-install').count(), { timeout: 30_000 }).toBe(2);
    expect(await page.getByTestId('host-devbox').innerText()).toContain('Install on devbox');
    // A background look (the guide's every-15-seconds recheck) keeps the row as it is: no flicker.
    const quiet = invoke('ssh:check', { host: 'devbox', quiet: true });
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(250);
      expect(await page.getByTestId('host-devbox').getByTestId('host-state').count()).toBe(0);
      expect(await page.getByTestId('host-install').count()).toBe(2);
    }
    await quiet;
    await page.getByTestId('onboarding-step-3').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'onboarding-05-remote.png') });

    // Install there from the app: the exact command first, then it runs (no terminal).
    const panel = (testId: string, p: string) => page.locator(`[data-testid="${testId}"][data-provider="${p}"]`);
    const remoteState = (p: string) => page.getByTestId('host-devbox').locator(`[data-testid="readiness"][data-provider="${p}"]`).getAttribute('data-state');
    await panel('host-install', 'claude').getByTestId('host-install-start').click();
    expect(await panel('host-install', 'claude').innerText()).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    await page.screenshot({ path: join(shots, 'onboarding-06-remote-confirm.png') });
    await panel('host-install', 'claude').getByTestId('host-install-confirm').click();
    await expect.poll(() => remoteState('claude'), { timeout: 30_000 }).toBe('signed_out');
    // Sign in without a browser there: the link opens here; its page's code goes back to the host.
    await panel('host-signin', 'claude').getByTestId('host-signin-start').click();
    await expect.poll(async () => (await panel('host-signin', 'claude').getByTestId('host-signin-link').getAttribute('href')) ?? '', { timeout: 20_000 }).toContain('claude.ai/oauth');
    await panel('host-signin', 'claude').getByTestId('host-signin-code').fill('good-code');
    await panel('host-signin', 'claude').getByTestId('host-signin-code').press('Enter');
    // A machine with an agent ready ticks the step off (it folds); open it again for Codex there.
    await expect.poll(() => done(2), { timeout: 30_000 }).toBe('true');
    await page.getByTestId('onboarding-step-2').getByRole('button', { name: /Connect other machines/ }).click();
    expect(await remoteState('claude')).toBe('ready');
    // Codex: installed the same way, then a device code shown in the app.
    await page.evaluate(() => window.scrollTo(0, 0));
    await invoke('ssh:install', { host: 'devbox', provider: 'codex' });
    await expect.poll(() => remoteState('codex'), { timeout: 30_000 }).toBe('signed_out');
    await panel('host-signin', 'codex').getByTestId('host-signin-start').click();
    await expect.poll(() => panel('host-signin', 'codex').getByTestId('host-device-code').innerText(), { timeout: 20_000 }).toBe('ABCD-1234');
    await page.screenshot({ path: join(shots, 'onboarding-07-remote-device-code.png') });
    await expect.poll(() => remoteState('codex'), { timeout: 30_000 }).toBe('ready');
    await page.screenshot({ path: join(shots, 'onboarding-08-remote-ready.png') });

    // Then bring work in, from this Mac and the machine just connected, in one place
    // (the folder picker is native, so the folder comes in through the same IPC).
    await expect.poll(() => page.getByTestId('onboarding-bring').count()).toBe(2);
    await expect.poll(() => page.getByTestId('onboarding-step-3').innerText()).toContain('devbox');
    await page.screenshot({ path: join(shots, 'onboarding-04-bring-in.png') });
    await invoke('project:add', { rootPath: repo('shop'), name: 'shop' });
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
