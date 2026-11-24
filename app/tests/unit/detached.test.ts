// The detached transport against a local shell standing in for the host: what the CLI writes while the
// connection is down arrives once it is back, exactly once and in order; input, exit codes, kill.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detachedSpawn, type RemoteRunner } from '../../src/main/util/detached';

const home = mkdtempSync(join(tmpdir(), 'amw-detached-'));
const env = { ...process.env, HOME: home };
const attachments: ChildProcessWithoutNullStreams[] = [];
const runner: RemoteRunner = {
  spawn(command) {
    const p = spawn('sh', ['-c', command], { env, stdio: 'pipe' });
    attachments.push(p);
    return p;
  },
  run(command) {
    return new Promise((resolve) => {
      const p = spawn('sh', ['-c', command], { env, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (code) => resolve({ code: code ?? 255, stdout, stderr }));
    });
  },
};
/** What a dropped connection looks like on the host: its stdin closes. */
const drop = () => attachments.at(-1)!.stdin.end();

const CLI = `while read l; do case "$l" in tick) i=0; while [ $i -lt 5 ]; do echo tick$i; i=$((i+1)); sleep 0.3; done;; *) echo "got:$l";; esac; done; echo bye; exit 0`;
const runs = () => (existsSync(join(home, '.cache/agent-workspace/run')) ? readdirSync(join(home, '.cache/agent-workspace/run')) : []);

function collect(p: ChildProcessWithoutNullStreams) {
  let out = '';
  p.stdout.on('data', (d: Buffer) => (out += d.toString()));
  const exit = new Promise<[number | null, string | null]>((resolve) => p.once('exit', (c, s) => resolve([c, s])));
  const until = async (re: RegExp, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!re.test(out)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re}; got ${JSON.stringify(out)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { out: () => out, exit, until };
}

describe('detached remote process', () => {
  it('keeps running through a dropped connection and picks up where it left off', async () => {
    const links: string[] = [];
    const p = detachedSpawn(runner, CLI, { backoff: [300], onLink: (s) => links.push(s) });
    const c = collect(p);
    p.stdin.write('a\n');
    await c.until(/got:a\n/);
    p.stdin.write('tick\n');
    await c.until(/tick0\n/);
    drop();
    // Written while nobody was connected, delivered after: each once, in order.
    await c.until(/tick4\n/);
    expect(c.out()).toBe('got:a\ntick0\ntick1\ntick2\ntick3\ntick4\n');
    expect(attachments.length).toBeGreaterThanOrEqual(2);
    p.stdin.write('b\n');
    await c.until(/got:b\n/);
    await new Promise((r) => setTimeout(r, 2200));
    expect(links).toEqual(['lost', 'back']);
    // End of input: the CLI reads EOF and ends on its own; its folder goes.
    p.stdin.end();
    expect(await c.exit).toEqual([0, null]);
    expect(c.out().endsWith('got:b\nbye\n')).toBe(true);
    expect(runs()).toEqual([]);
  }, 30_000);

  it("passes the CLI's exit code and last words through", async () => {
    const p = detachedSpawn(runner, 'echo "no such folder" >&2; exit 3');
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const c = collect(p);
    expect(await c.exit).toEqual([3, null]);
    expect(err).toContain('no such folder');
  }, 15_000);

  it('stops the CLI on the host when killed', async () => {
    const before = runs();
    const p = detachedSpawn(runner, 'sleep 30');
    const c = collect(p);
    await new Promise((r) => setTimeout(r, 1500));
    const [dir] = runs().filter((d) => !before.includes(d));
    const pid = (await runner.run(`cat "$HOME/.cache/agent-workspace/run/${dir}/pid"`)).stdout.trim();
    p.kill('SIGTERM');
    expect(await c.exit).toEqual([null, 'SIGTERM']);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await runner.run(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).stdout.trim()).toBe('gone');
  }, 15_000);

  it('tells an exit code of 255 or 75 from the CLI apart from a lost connection', async () => {
    expect(await collect(detachedSpawn(runner, 'exit 255', { backoff: [100] })).exit).toEqual([255, null]);
    expect(await collect(detachedSpawn(runner, 'exit 75', { backoff: [100] })).exit).toEqual([75, null]);
  }, 15_000);

  it('gives up with 255 when the host cannot be reached at all', async () => {
    const failing: RemoteRunner = { spawn: runner.spawn, run: async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host x: Connection refused' }) };
    const p = detachedSpawn(failing, 'true');
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    expect(await collect(p).exit).toEqual([255, null]);
    expect(err).toContain('Connection refused');
  });
});
