// A remote CLI that outlives its SSH connection. The laptop sleeps, the Wi-Fi changes: the CLI on the
// host keeps working, and the app picks its output up where it left off once it can connect again.
//
// On the host, in its own folder under ~/.cache/agent-workspace/run/<id>:
//   in     a named pipe, the CLI's stdin; a keeper holds it open, so no connection closing it reads as EOF
//   out    the CLI's stdout, a plain file: what was written while nobody was connected waits there
//   err    its stderr; pid, keeper, exit (its exit code, once it ends); alive (touched while connected)
// An attachment (one long-lived ssh) forwards our input into the pipe and reads `out` from the byte
// after the last one received; it ends with the CLI's exit code, or 75 when the connection goes.
//
// To the caller (the Claude Agent SDK, Codex's app-server client) it is one process: one stdin,
// one stdout, one 'exit' when the CLI itself ends (or is killed), whatever happened to connections.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** How commands reach the host: ssh in the app, a local shell in tests. */
export interface RemoteRunner {
  /** A long-lived command whose stdio is the connection. */
  spawn(command: string): ChildProcessWithoutNullStreams;
  /** A short command. */
  run(command: string, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface DetachedOptions {
  /** Waits between attempts to connect again (ms); the last one repeats. */
  backoff?: number[];
  /** Gives up (exit 255) after trying to connect again for this long. */
  giveUpMs?: number;
  /** Minutes without a connection after which the host stops the CLI itself. */
  leaseMin?: number;
  /** Told when the connection goes and comes back (for a status line). */
  onLink?: (state: 'lost' | 'back') => void;
}

/** How an attachment says the CLI ended, and with what code (last line of its stderr). */
const MARK = 'AMW_EXIT';
/** The attachment's exit code when its connection ended (not the CLI). */
const LOST = 75;
/** ...and when the run's folder is gone (cleaned up, or the host was reset). */
const GONE = 74;

const BASE = '"$HOME/.cache/agent-workspace/run"';

/** Stops sent to hosts and not answered yet: the app waits for them before it quits. */
const stopping = new Set<Promise<unknown>>();

/** Waits (up to `ms`) for the stops sent to hosts, so quitting does not leave CLIs running there. */
export async function settleStops(ms = 5000): Promise<void> {
  if (!stopping.size) return;
  await Promise.race([Promise.allSettled([...stopping]), new Promise((r) => setTimeout(r, ms))]);
}

function track<T>(p: Promise<T>): Promise<T> {
  stopping.add(p);
  void p.finally(() => stopping.delete(p)).catch(() => {});
  return p;
}

function startScript(id: string, command: string, leaseMin: number): string {
  // The run itself, written to a file (quoted heredoc: taken literally) and started with nohup.
  const run = [
    'D="$1"',
    // The keeper: holds the pipe open for writing; and the lease: nobody connected for leaseMin minutes, the CLI stops.
    `( exec 3>"$D/in"; while :; do sleep 60 3>&-; if [ -n "$(find "$D/alive" -mmin +${leaseMin} 2>/dev/null)" ]; then kill "$(cat "$D/pid" 2>/dev/null)" 2>/dev/null; break; fi; done ) &`,
    'echo $! > "$D/keeper"',
    `( ${command} ) < "$D/in" > "$D/out" 2> "$D/err" &`,
    'echo $! > "$D/pid"',
    'wait $!',
    'echo $? > "$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"',
    'kill "$(cat "$D/keeper")" 2>/dev/null',
  ].join('\n');
  return [
    `B=${BASE}; D="$B/${id}"`,
    // Runs nobody came back for (the app gone for good): cleared after a few days.
    'mkdir -p "$B" && find "$B" -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf {} + 2>/dev/null',
    'mkdir "$D" && mkfifo "$D/in" && : > "$D/out" && touch "$D/alive" || exit 70',
    `cat > "$D/run.sh" <<'AMW_RUN_EOF'\n${run}\nAMW_RUN_EOF`,
    'nohup sh "$D/run.sh" "$D" </dev/null >/dev/null 2>&1 &',
    'echo started',
  ].join('\n');
}

function attachScript(id: string, offset: number, input: boolean): string {
  return [
    `D=${BASE}/${id}`,
    `cd "$D" 2>/dev/null || exit ${GONE}`,
    // Our stdin kept for cat; the shell's own notices (jobs killed) kept out of what the caller reads.
    'exec 3<&0 4>&2 2>/dev/null',
    // One connection at a time: one that went without the host noticing (a laptop asleep) lets go of the pipe.
    '[ -f conn ] && kill $(cat conn) 2>/dev/null',
    'touch alive',
    `tail -c +${offset + 1} -f out & t=$!`,
    // With input: forwarded into the pipe. Without (the caller ended it): only the rest of the output.
    input ? 'cat <&3 > in & c=$!; echo "$t $c" > conn' : 'c=$t; echo "$t" > conn',
    // Until the CLI ends, or our side goes (its stdin closes: cat ends; or tail cannot write), or the CLI is
    // gone without a word (killed outright, the host restarted): nothing will write its exit code then.
    'alive() { [ ! -f pid ] || kill -0 "$(cat pid)" 2>/dev/null; }',
    'while [ ! -f exit ] && kill -0 $c 2>/dev/null && alive; do sleep 1; touch alive; done',
    `if [ ! -f exit ] && ! alive; then sleep 1; [ -f exit ] || { kill $t $c 2>/dev/null; cd /; rm -rf "$D"; exit ${GONE}; }; fi`,
    // The CLI ended: its last words and its exit code (whatever it is: 255 or 75 too), as a marker. The
    // rest of its output is fetched by byte count after this, and the folder removed then.
    'if [ -f exit ]; then',
    '  kill $t $c 2>/dev/null',
    `  tail -c 2048 err >&4; printf '\\n${MARK} %s\\n' "$(cat exit)" >&4; exit 0`,
    'fi',
    `kill $t 2>/dev/null; exit ${LOST}`,
  ].join('\n');
}

/**
 * Starts `command` (a shell command line, run in the host's login shell) detached from the connection,
 * and returns it as one process. `exit` codes: the CLI's own; 255 when it could not be started or
 * reached again; null with a signal when killed from here.
 */
export function detachedSpawn(runner: RemoteRunner, command: string, opts: DetachedOptions = {}): ChildProcessWithoutNullStreams {
  const backoff = opts.backoff ?? [1000, 2000, 5000, 10_000, 30_000];
  const giveUpMs = opts.giveUpMs ?? 24 * 3600_000;
  const id = randomUUID();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid?: number;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(proc, { stdin, stdout, stderr, killed: false, exitCode: null, signalCode: null });

  let received = 0;
  let attachment: ChildProcessWithoutNullStreams | null = null;
  /** Input while no connection is up: sent when one is. */
  let queue: Buffer[] = [];
  let ended = false;
  let lostSince = 0;
  /** The caller ended our stdin: the connection that carried it is closed, and the next one only reads. */
  let inputEnded = false;
  let reattachNow = false;
  let tries = 0;
  let retry: NodeJS.Timeout | null = null;

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (ended) return;
    ended = true;
    if (retry) clearTimeout(retry);
    proc.exitCode = code;
    proc.signalCode = signal;
    stdout.end();
    stderr.end();
    // After the streams' last data, like a child process.
    setImmediate(() => {
      proc.emit('exit', code, signal);
      proc.emit('close', code, signal);
    });
  };

  const attach = () => {
    if (ended) return;
    const a = runner.spawn(attachScript(id, received, !inputEnded));
    attachment = a;
    a.stdout.on('data', (d: Buffer) => {
      received += d.length;
      stdout.write(d);
    });
    // Kept, not streamed: ssh's notices about a connection we will open again, or the CLI's last words.
    let errText = '';
    a.stderr.on('data', (d: Buffer) => (errText = (errText + d.toString()).slice(-8000)));
    a.stdin.on('error', () => {});
    for (const b of queue) a.stdin.write(b);
    queue = [];
    // Back once an attachment holds (a failed connection ends within moments).
    const held = setTimeout(() => {
      if (attachment !== a || !lostSince) return;
      lostSince = 0;
      tries = 0;
      opts.onLink?.('back');
    }, 2000);
    a.on('error', () => {});
    a.on('exit', (code) => {
      clearTimeout(held);
      if (attachment === a) attachment = null;
      if (ended) return;
      if (proc.killed) return finish(null, 'SIGTERM');
      const marked = new RegExp(`\\n?${MARK} (\\d+)\\s*$`).exec(errText);
      if (marked) {
        stderr.write(errText.slice(0, marked.index));
        const cli = Number(marked[1]);
        // The rest of its output (from the byte after the last received), then its folder goes.
        void runner
          .run(`cd ${BASE}/${id} 2>/dev/null && tail -c +${received + 1} out && cd / && rm -rf ${BASE}/${id}`, 60_000)
          .then((r) => {
            if (r.stdout) stdout.write(r.stdout);
          })
          .catch(() => {})
          .finally(() => finish(cli, null));
        return;
      }
      if (code === GONE) {
        stderr.write(errText);
        return finish(255, null);
      }
      if (reattachNow && (code === LOST || code === 255 || code === null)) {
        reattachNow = false;
        return attach();
      }
      if (code === LOST || code === 255 || code === null) {
        if (!lostSince) {
          lostSince = Date.now();
          opts.onLink?.('lost');
        }
        if (Date.now() - lostSince > giveUpMs) return finish(255, null);
        retry = setTimeout(attach, backoff[Math.min(tries++, backoff.length - 1)]);
        return;
      }
      finish(code, null);
    });
  };

  stdin.on('data', (d: Buffer) => {
    if (attachment && attachment.stdin.writable) attachment.stdin.write(d);
    else queue.push(d);
  });
  // The caller is done with it (end of input): the keeper lets go, the CLI reads EOF and ends on its own.
  // Every writer has to let go of the pipe for the CLI to see EOF: the keeper, and the connection's cat.
  stdin.on('end', () => {
    inputEnded = true;
    reattachNow = !!attachment;
    void track(runner.run(`cd ${BASE}/${id} 2>/dev/null && kill $(cat keeper) $(cat conn 2>/dev/null) 2>/dev/null; true`, 15_000)).catch(() => {});
  });

  proc.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (ended || proc.killed) return false;
    proc.killed = true;
    const sig = signal.replace(/^SIG/, '');
    // Best effort: offline, the lease stops it on the host later.
    // ...and its folder goes once it has (nobody will read the rest of its output).
    void track(runner.run(`kill -${sig} "$(cat ${BASE}/${id}/pid)" 2>/dev/null; kill "$(cat ${BASE}/${id}/keeper)" 2>/dev/null; (sleep 3; rm -rf ${BASE}/${id}) </dev/null >/dev/null 2>&1 & true`, 15_000)).catch(() => {});
    if (attachment) attachment.kill('SIGTERM');
    finish(null, signal);
    return true;
  };

  void runner
    .run(startScript(id, command, opts.leaseMin ?? 24 * 60), 60_000)
    .then((r) => {
      if (ended) return;
      if (r.code !== 0 || !r.stdout.includes('started')) {
        stderr.write(r.stderr);
        return finish(r.code === 0 ? 255 : r.code, null);
      }
      attach();
    })
    .catch((e: Error) => {
      stderr.write(e.message);
      finish(255, null);
    });

  return proc as unknown as ChildProcessWithoutNullStreams;
}
