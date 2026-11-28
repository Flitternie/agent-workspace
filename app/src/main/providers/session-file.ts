import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { shq, sshRun } from '../util/ssh';

/** Session ids are uuid-like; anything else never reaches a path or a shell. */
const SAFE_ID = /^[A-Za-z0-9-]{8,80}$/;

/**
 * The first file under `root` (searched `depth` folders deep) named `<anything><id>.jsonl`:
 * where Claude Code (projects/<folder>/<id>.jsonl) and Codex (sessions/Y/M/D/rollout-…-<id>.jsonl)
 * keep a conversation. On a host, the same search there over SSH.
 */
export async function findSessionFile(root: string, remoteRoot: string, id: string, depth: number, host?: string): Promise<string | undefined> {
  if (!SAFE_ID.test(id)) return undefined;
  if (host) {
    const r = await sshRun(host, `find ${remoteRoot} -mindepth ${depth} -maxdepth ${depth} -name ${shq(`*${id}.jsonl`)} 2>/dev/null | head -n 1`, 20_000);
    return r.stdout.trim().split('\n')[0] || undefined;
  }
  const walk = async (dir: string, left: number): Promise<string | undefined> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (left === 1) return entries.find((e) => e.isFile() && e.name.endsWith(`${id}.jsonl`)) ? join(dir, entries.find((e) => e.isFile() && e.name.endsWith(`${id}.jsonl`))!.name) : undefined;
    // Newest folders first (Codex's dated folders), so a recent conversation is found quickly.
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const found = await walk(join(dir, e.name), left - 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(root, depth);
}
