import type { SessionStore, SessionStoreEntry, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { shq, sshError, sshRun, sshSpawn } from '../util/ssh';

// Claude Code on an SSH host: the SDK runs the `claude` installed there through
// `spawnClaudeCodeProcess` (its login, settings and transcripts stay on the host), and
// reads that host's saved transcripts through a read-only SessionStore over SSH so its
// own parsing (titles, history) applies unchanged.

const SAFE_KEY = /^[A-Za-z0-9._-]{1,255}$/;

const parseLines = (text: string): SessionStoreEntry[] =>
  text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionStoreEntry];
      } catch {
        return []; // a line cut short by the scan's size limit
      }
    });

/** Read-only view of ~/.claude/projects on `host` (writes stay with the CLI there). */
export function remoteSessionStore(host: string): SessionStore {
  return {
    async append() {
      /* never used for writing: the remote CLI writes its own transcripts */
    },
    async load(key) {
      if (!SAFE_KEY.test(key.projectKey) || !SAFE_KEY.test(key.sessionId) || (key.subpath && !/^[A-Za-z0-9._/-]{1,255}$/.test(key.subpath))) return null;
      const file = `~/.claude/projects/${shq(key.projectKey)}/${key.subpath ? `${shq(key.sessionId)}/${shq(key.subpath)}` : shq(key.sessionId)}.jsonl`;
      const r = await sshRun(host, `cat ${file} 2>/dev/null || exit 3`, 120_000);
      if (r.code === 3) return null;
      if (r.code !== 0) throw new Error(`Could not read the session on ${host}.`);
      return parseLines(r.stdout);
    },
  };
}

export interface RemoteClaudeSession {
  sessionId: string;
  projectKey: string;
  mtime: number;
  /** Just the lines needed for title and folder (the SDK derives the rest). */
  entries: SessionStoreEntry[];
}

/**
 * The newest transcripts on `host`, newest first, in one SSH round trip: per file its
 * folder line, title entries and first user prompts, not the whole conversation.
 */
export async function scanRemoteSessions(host: string, limit: number): Promise<RemoteClaudeSession[]> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const script = [
    'cd ~/.claude/projects 2>/dev/null || exit 0',
    // GNU stat, else BSD stat (a macOS host).
    `{ find . -mindepth 2 -maxdepth 2 -name '*.jsonl' -exec stat -c '%Y %n' {} + 2>/dev/null || find . -mindepth 2 -maxdepth 2 -name '*.jsonl' -exec stat -f '%m %N' {} +; } | sort -rn | head -n ${n} | while read -r t p; do`,
    `  printf '\\n__AMW_FILE__ %s %s\\n' "$t" "$p"`,
    `  grep -m 1 '"cwd":"' "$p" | cut -c1-30000`,
    `  grep -E '"type":"(custom-title|ai-title|summary)"' "$p" | tail -n 3 | cut -c1-30000`,
    `  grep -m 5 '"type":"user"' "$p" | cut -c1-30000`,
    'done',
  ].join('\n');
  const r = await sshRun(host, script, 120_000);
  if (r.code !== 0) throw new Error(`Could not list Claude Code sessions on ${host}.`);
  const out: RemoteClaudeSession[] = [];
  for (const block of r.stdout.split('\n__AMW_FILE__ ').slice(1)) {
    const [head, ...lines] = block.split('\n');
    const m = /^(\d+)\s+\.\/([^/]+)\/([^/]+)\.jsonl$/.exec(head.trim());
    if (!m || !SAFE_KEY.test(m[2]) || !SAFE_KEY.test(m[3])) continue;
    out.push({ mtime: Number(m[1]) * 1000, projectKey: m[2], sessionId: m[3], entries: parseLines(lines.join('\n')) });
  }
  return out;
}

/** The entrypoint the CLI records on each transcript line (`cli`, `sdk-cli`, `sdk-ts`, …). */
export function entrypointOf(entries: Array<Record<string, unknown>>): string | undefined {
  return entries.map((e) => e.entrypoint).find((v): v is string => typeof v === 'string');
}

/**
 * Started by an agent inside another task rather than by a person or an app: `claude -p`
 * (how Claude Code and Codex call Claude from a shell) and daemon workers. Agent SDK
 * sessions (`sdk-ts` / `sdk-py`) are an app's own conversations, such as this one's, and stay.
 */
export const isSubAgentEntrypoint = (entrypoint: string | undefined) => !!entrypoint && (entrypoint === 'sdk-cli' || entrypoint.includes('daemon'));

/** Runs the SDK's CLI command line with the host's own `claude`, in `cwd` there. */
export function remoteSpawn(host: string, cwd: string, localEnv: Record<string, string>): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    // Only what the SDK itself adds for the CLI crosses over; the user's environment stays here.
    const added = Object.entries(o.env).filter(([k, v]) => typeof v === 'string' && localEnv[k] !== v && /^CLAUDE_[A-Z0-9_]+$/.test(k));
    const exports = added.map(([k, v]) => `export ${k}=${shq(v!)}; `).join('');
    const command = `cd ${shq(cwd)} || exit 3; ${exports}exec claude ${o.args.map(shq).join(' ')}`;
    const proc = sshSpawn(host, command);
    // stderr may hold private diagnostics; never forwarded.
    proc.stderr.resume();
    o.signal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true });
    return proc;
  };
}

/** Fails early with a clear reason (folder or CLI missing) instead of an opaque exit code. */
export async function checkRemoteStart(host: string, cwd: string): Promise<void> {
  const r = await sshRun(host, `cd ${shq(cwd)} 2>/dev/null || exit 3; command -v claude >/dev/null || exit 4`);
  if (r.code === 255) throw new Error(sshError(host, r.stderr));
  if (r.code === 3) throw new Error(`The folder ${cwd} does not exist on ${host}.`);
  if (r.code === 4) throw new Error(`Claude Code is not installed on ${host} (not on its login shell's PATH).`);
  if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `Could not reach ${host}.`);
}
