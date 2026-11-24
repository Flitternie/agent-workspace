// The detached transport over real SSH (opt-in: AMW_E2E_SSH_HOST=<alias> npx vitest run detached-ssh).
// Shell only on the host, in ~/.cache/agent-workspace/run; no CLI, no credentials. A dropped connection
// is the local ssh killed outright; what the program writes meanwhile arrives once, in order, after.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { detachedSpawn, type RemoteRunner } from '../../src/main/util/detached';
import { sshRunner } from '../../src/main/util/ssh';

const host = process.env.AMW_E2E_SSH_HOST;
const CLI = `while read l; do case "$l" in tick) i=0; while [ $i -lt 8 ]; do echo tick$i; i=$((i+1)); sleep 0.5; done;; *) echo "got:$l";; esac; done; echo bye; exit 0`;

describe.skipIf(!host)('detached remote process over SSH', () => {
  it('survives the local ssh being killed mid-output, and leaves nothing behind', async () => {
    const base = sshRunner(host!);
    const attachments: ChildProcessWithoutNullStreams[] = [];
    const runner: RemoteRunner = { spawn: (c) => { const p = base.spawn(c); attachments.push(p); return p; }, run: base.run };
    const links: string[] = [];
    const p = detachedSpawn(runner, CLI, { backoff: [1000], onLink: (s) => links.push(s) });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exit = new Promise<[number | null, string | null]>((r) => p.once('exit', (c, s) => r([c, s])));
    const until = async (re: RegExp, ms = 30_000) => {
      const end = Date.now() + ms;
      while (!re.test(out)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${re}; got ${JSON.stringify(out)}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    p.stdin.write('a\n');
    await until(/got:a\n/);
    const runs = (await base.run('ls "$HOME/.cache/agent-workspace/run"')).stdout.trim().split('\n');
    p.stdin.write('tick\n');
    await until(/tick1\n/);
    attachments.at(-1)!.kill('SIGKILL');
    await until(/tick7\n/);
    expect(out).toBe('got:a\n' + Array.from({ length: 8 }, (_, i) => `tick${i}\n`).join(''));
    expect(attachments.length).toBeGreaterThanOrEqual(2);
    p.stdin.write('b\n');
    await until(/got:b\n/);
    p.stdin.end();
    expect(await exit).toEqual([0, null]);
    expect(out.endsWith('got:b\nbye\n')).toBe(true);
    expect(links[0]).toBe('lost');
    // Its folder is gone, and nothing of it is left running there.
    const after = (await base.run('ls "$HOME/.cache/agent-workspace/run" 2>/dev/null; echo ---; ps -u "$(id -u)" -o pid=,args= | grep -F "agent-workspace/run" | grep -v grep || true')).stdout;
    const [dirs, procs] = after.split('---');
    for (const d of runs) expect(dirs.split('\n')).not.toContain(d);
    expect(procs.trim()).toBe('');
  }, 120_000);
});
