import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../../src/main/providers/mock';
import { detectSignIn, signInHost } from '../../src/main/signin';
import { Workspace } from '../../src/main/workspace';

describe('sign-in requests in tool output', () => {
  it('reads the device flows of common CLIs: link and one-time code', () => {
    expect(detectSignIn('! First copy your one-time code: 1A2B-3C4D\nOpen this URL to continue in your web browser: https://github.com/login/device\n')).toEqual({
      url: 'https://github.com/login/device',
      code: '1A2B-3C4D',
    });
    expect(detectSignIn('To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABC123XYZ to authenticate.')).toEqual({
      url: 'https://microsoft.com/devicelogin',
      code: 'ABC123XYZ',
    });
    expect(
      detectSignIn('Attempting to automatically open the SSO authorization page in your default browser.\nIf the browser does not open, open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nWXYZ-ABCD\n'),
    ).toEqual({ url: 'https://device.sso.us-east-1.amazonaws.com/', code: 'WXYZ-ABCD' });
    expect(detectSignIn('Visit https://vercel.com/oauth/device?user_code=QWER-TYUI to sign in')).toEqual({ url: 'https://vercel.com/oauth/device?user_code=QWER-TYUI', code: 'QWER-TYUI' });
    expect(detectSignIn('Follow these steps to sign in:\n1. Open this link in your browser\n   https://auth.openai.com/codex/device\n2. Enter this one-time code (expires in 15 minutes)\n   K7PQ-2M9X\n')).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'K7PQ-2M9X',
    });
  });

  it('reads browser logins without a code (OAuth authorize links, CLI login pages)', () => {
    const google = 'https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2Fauthcode.html&scope=openid';
    expect(detectSignIn(`Go to the following link in your browser, and complete the sign-in prompts:\n\n    ${google}\n\nOnce finished, enter the verification code provided in your browser: `)).toEqual({ url: google });
    expect(detectSignIn('Login at:\nhttps://www.npmjs.com/login?next=/login/cli/4b1d7e0c-aaaa-bbbb\nPress ENTER to open in the browser...')?.url).toBe('https://www.npmjs.com/login?next=/login/cli/4b1d7e0c-aaaa-bbbb');
    expect(detectSignIn('To authenticate, visit:\n\n\thttps://login.tailscale.com/a/1b2c3d4e5f\n')).toEqual({ url: 'https://login.tailscale.com/a/1b2c3d4e5f' });
    expect(detectSignIn("Browser didn't open? Use the url below to sign in:\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=x&code_challenge=y\n")?.url).toContain('https://claude.ai/oauth/authorize?');
  });

  it('works through terminal colours and on a partial stream', () => {
    expect(detectSignIn('\x1b[1;33m!\x1b[0m First copy your one-time code: \x1b[1m9F8E-7D6C\x1b[0m\r\nOpen https://github.com/login/device\r\n')).toEqual({ url: 'https://github.com/login/device', code: '9F8E-7D6C' });
    // Only the link so far; the code is not invented.
    expect(detectSignIn('Open this URL to continue in your web browser: https://github.com/login/device')).toEqual({ url: 'https://github.com/login/device' });
    // Mid-stream, a link the output ends on may be cut short: only a known sign-in page counts yet.
    expect(detectSignIn('! First copy your one-time code: 1A2B-3C4D\nOpen this URL: https://github.com/lo', { streaming: true })).toBeUndefined();
    expect(detectSignIn('! First copy your one-time code: 1A2B-3C4D\nOpen this URL: https://example.com/lo', { streaming: true })).toBeUndefined();
    expect(detectSignIn('! First copy your one-time code: 1A2B-3C4D\nOpen this URL: https://example.com/lo\n', { streaming: true })?.url).toBe('https://example.com/lo');
  });

  it('ignores ordinary URLs, local servers, help links and code-free mentions', () => {
    expect(detectSignIn('Downloading https://registry.npmjs.org/react/-/react-18.2.0.tgz')).toBeUndefined();
    expect(detectSignIn('  ➜  Local:   http://localhost:5173/\n  Open http://localhost:5173 in your browser to sign in')).toBeUndefined();
    expect(detectSignIn('Server listening on http://127.0.0.1:8085/ — waiting for the authorization code')).toBeUndefined();
    expect(detectSignIn('Error: failed to log in. See https://docs.example.com/troubleshooting for help')).toBeUndefined();
    expect(detectSignIn('PR created: https://github.com/acme/shop/pull/12')).toBeUndefined();
    expect(detectSignIn('Enter the code from your authenticator app')).toBeUndefined();
    expect(detectSignIn('HTTP status code 404 at https://api.example.com/v1/items')).toBeUndefined();
    expect(detectSignIn('')).toBeUndefined();
    // A status code beside a sign-in link is not the device code.
    expect(detectSignIn('Open https://github.com/login/device (status code 200)')).toEqual({ url: 'https://github.com/login/device' });
  });

  it('keeps the closing punctuation out of the link and names its host', () => {
    expect(detectSignIn('Please authorize this device at https://example.com/login/device.')?.url).toBe('https://example.com/login/device');
    expect(detectSignIn('(open https://github.com/login/device)')?.url).toBe('https://github.com/login/device');
    expect(signInHost('https://www.microsoft.com/devicelogin')).toBe('microsoft.com');
  });
});

// ---------------------------------------------------------------- workspace

const DELAY = 10;
const opened: Workspace[] = [];
afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.shutdown();
});

async function agent(mockScript: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'amw-signin-data-'));
  const ws = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), DELAY) } });
  opened.push(ws);
  const dir = mkdtempSync(join(tmpdir(), 'amw-signin-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  const project = await ws.addProject(dir);
  const t = await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'gh', isolate: false, mockScript, instruction: 'Sign in to GitHub.' });
  const signIns = () => ws.snapshot().attention.filter((a) => a.taskId === t.taskId && a.kind === 'signin');
  const task = () => ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!;
  return { ws, t, signIns, task };
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, DELAY));
  }
}

describe('sign-in requests for the user', () => {
  it('raises one request per tool call from streamed output and resolves it when the command ends', async () => {
    const { ws, signIns, task } = await agent('signin:40');
    await until(() => signIns().some((a) => a.signIn?.code));
    expect(signIns()).toHaveLength(1);
    const a = signIns()[0];
    expect(a).toMatchObject({ state: 'open', toolCallId: 'signin-0', headline: 'Sign in at github.com ($ gh auth login --web)', signIn: { url: 'https://github.com/login/device', code: '1A2B-3C4D', running: true } });
    // Only an open request's own link opens; never a URL from the renderer.
    expect(ws.signInUrl(a.id)).toBe('https://github.com/login/device');
    await until(() => task().status === 'done');
    expect(signIns()).toHaveLength(1);
    expect(signIns()[0]).toMatchObject({ state: 'resolved', resolution: 'The command finished.' });
    expect(() => ws.signInUrl(a.id)).toThrow(/no longer open/);
  });

  it('a message sent meanwhile does not settle it while the command still waits; stopping the turn does', async () => {
    const { ws, t, signIns } = await agent('signin:400');
    await until(() => signIns().some((a) => a.signIn?.code));
    await ws.send(t.taskId, 'Waiting for you to sign in.', 'text');
    expect(signIns()[0].state).toBe('open');
    await ws.interrupt(t.taskId);
    await until(() => signIns()[0].state !== 'open');
    expect(signIns()[0]).toMatchObject({ state: 'expired', resolution: 'The command ended with the turn.' });
  });

  it('keeps a sign-in read from a background login open after the turn, until the user replies', async () => {
    const { ws, t, signIns, task } = await agent('signin-read');
    await until(() => ['done', 'waiting_for_user'].includes(task().status));
    expect(signIns()).toHaveLength(1);
    expect(signIns()[0]).toMatchObject({ state: 'open', toolCallId: 'read-0', signIn: { url: expect.stringContaining('https://accounts.google.com/o/oauth2/auth?') } });
    expect(signIns()[0].signIn?.running).toBeUndefined();
    await ws.send(t.taskId, 'Done, I signed in.', 'text');
    expect(signIns()[0]).toMatchObject({ state: 'resolved' });
  });

  it('can be dismissed', async () => {
    const { ws, signIns } = await agent('signin:400');
    await until(() => signIns().length === 1);
    ws.dismissAttention(signIns()[0].id);
    expect(signIns()[0].state).toBe('dismissed');
  });
});
