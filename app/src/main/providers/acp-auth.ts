// Whether an ACP CLI is signed in, read with its own commands (ACP has no status call; a prompt
// would spend quota). Pure parsers plus the commands, so the parsing is tested without a CLI.
//
//   opencode     `opencode auth list --format json` (2.x; 1.x prints text): stored credentials per
//                integration, never the secrets. None stored is still usable: `opencode models`
//                lists the built-in free models (and providers configured by environment variables),
//                so "ready" means a credential, or at least one model to run on.
//   antigravity  `agy models` lists the account's models, or fails at once when signed out
//                ("Please sign in to view available models"). (`agy -p /usage` waits a minute for a
//                login instead.)
import type { AcpAgentSpec } from '../../shared/acp-agents';
import type { ProviderCapabilities } from '../../shared/types';

type Auth = ProviderCapabilities['auth'];
type Kind = NonNullable<AcpAgentSpec['signIn']>['status'];
export interface Ran {
  code: number;
  out: string;
}

/** The commands, in order; each a list of alternatives (the next one when the first fails: OpenCode 1.x knows no `--format`). */
export const AUTH_COMMANDS: Record<Kind, string[][][]> = {
  opencode: [
    [
      ['auth', 'list', '--format', 'json', '--standalone'],
      ['auth', 'list'],
    ],
    [['models', '--standalone'], ['models']],
  ],
  antigravity: [[['models']]],
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Integrations with stored credentials, from `opencode auth list` (JSON in 2.x, text in 1.x); undefined when unreadable. */
export function opencodeCredentials(out: string): string[] | undefined {
  const text = plain(out).trim();
  const start = text.indexOf('[');
  if (start !== -1) {
    try {
      const list = JSON.parse(text.slice(start)) as unknown;
      if (Array.isArray(list))
        return list
          .map(rec)
          .filter((i) => Array.isArray(i.connections) && i.connections.length > 0)
          .map((i) => String(i.name || i.id || ''))
          .filter(Boolean);
    } catch {
      /* text */
    }
  }
  // 1.x: "●  Anthropic oauth" lines, then "└  2 credentials".
  const count = /(\d+)\s+credentials?/i.exec(text);
  if (!count) return undefined;
  const names = [...text.matchAll(/^[│|\s]*[●•]\s+(.+?)\s+(oauth|api|wellknown)\b/gim)].map((m) => m[1].trim());
  return Number(count[1]) > 0 ? (names.length ? names : ['credentials']) : [];
}

/** Models `opencode models` lists ("provider/model" lines). */
export function opencodeModels(out: string): string[] {
  return plain(out)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+\/\S+$/.test(l));
}

/** The sign-in state from the commands' results (AUTH_COMMANDS order); undefined when it cannot be told. */
export function parseAuth(kind: Kind, ran: Array<Ran | undefined>): Auth {
  if (kind === 'antigravity') {
    const r = ran[0];
    if (!r) return undefined;
    if (r.code === 0 && /\S/.test(plain(r.out).replace(/Fetching available models\.*/i, ''))) return { loggedIn: true };
    if (/sign in|log ?in|not (signed|logged) in|authenticat/i.test(r.out)) return { loggedIn: false };
    return undefined;
  }
  const creds = ran[0] ? opencodeCredentials(ran[0].out) : undefined;
  if (creds?.length) return { loggedIn: true, method: creds.join(', ') };
  const models = ran[1] ? opencodeModels(ran[1].out) : [];
  if (models.length) {
    // Only OpenCode's own (free) models without a credential; others come from environment variables or config.
    const others = [...new Set(models.map((m) => m.split('/')[0]).filter((p) => p !== 'opencode'))];
    return { loggedIn: true, method: others.length ? others.join(', ') : 'free models' };
  }
  if (creds) return { loggedIn: false };
  return undefined;
}

/** One shell script running the commands with `exe` (on an SSH host), each result marked for splitAuthScript. */
export function authScript(kind: Kind, exe: string, quote: (s: string) => string): string {
  return AUTH_COMMANDS[kind]
    .map((alts) => `o=$(${alts.map((a) => [exe, ...a.map(quote)].join(' ')).join(' 2>/dev/null </dev/null || ')} 2>&1 </dev/null); c=$?; printf '%s\\n__AMW_AUTH__%s\\n' "$o" "$c"`)
    .join('; ');
}

/** The results in the output of authScript. */
export function splitAuthScript(stdout: string): Ran[] {
  const out: Ran[] = [];
  const re = /__AMW_AUTH__(\d+)\n?/g;
  let from = 0;
  for (let m = re.exec(stdout); m; m = re.exec(stdout)) {
    out.push({ code: Number(m[1]), out: stdout.slice(from, m.index) });
    from = m.index + m[0].length;
  }
  return out;
}

/** Runs the commands (each alternative until one succeeds) and reads the state. */
export async function readAuth(kind: Kind, exec: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>): Promise<Auth> {
  const ran: Array<Ran | undefined> = [];
  for (const alts of AUTH_COMMANDS[kind]) {
    let last: Ran | undefined;
    for (const args of alts) {
      const r = await exec(args).catch(() => undefined);
      if (!r) continue;
      last = { code: r.code, out: `${r.stdout}\n${r.stderr}` };
      if (r.code === 0) break;
    }
    ran.push(last);
    // A stored credential settles it: no need to list models.
    if (kind === 'opencode' && ran.length === 1 && last && opencodeCredentials(last.out)?.length) break;
  }
  return parseAuth(kind, ran);
}
