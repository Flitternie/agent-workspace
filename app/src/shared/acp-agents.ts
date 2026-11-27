// Coding agents reached through the Agent Client Protocol (ACP, agentclientprotocol.com): any CLI
// that ships an ACP server (`<cli> acp`, JSON-RPC over stdio) runs on the one shared adapter
// (main/providers/acp.ts). Adding a CLI is one entry here; its id becomes a provider everywhere.

export interface AcpAgentSpec {
  /** Provider id (stored on tasks): lowercase, stable. */
  id: string;
  /** Product name, as shown (not translated). */
  label: string;
  /** Executable and the arguments that start its ACP server. */
  command: string;
  args: readonly string[];
  /** Where its installer puts the executable besides PATH (relative to the home folder). */
  dirs: readonly string[];
  /** Official install command (copied by the user; never run by the app). */
  install: string;
  /** Signing in, in a terminal (on the agent's machine). */
  login: string;
  docs: string;
  /** One or two letters for its badge, shown when it has no `icon`. */
  mark: string;
  /** Its own mark, drawn in one colour: an SVG path and the viewBox it is drawn in. */
  icon?: { viewBox: string; d: string };
  /**
   * Environment for its ACP server. OpenCode: every edit, command and fetch asks (its own default is
   * to allow them), so the app's permission mode decides, as for Claude Code and Codex. A JSON value
   * merges over the user's own (same variable), ours winning.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Arguments of a command that forks a saved session just before one of its messages (ACP's
   * session/fork copies it whole), printing JSON with the new session's id at `data.id`.
   */
  forkBefore?: (sessionId: string, messageId: string) => string[];
  /** Session titles the CLI gives sessions nothing was said in yet (left out of "Continue a session"). */
  emptyTitle?: RegExp;
  /**
   * Its global rules file, where the app keeps a marked section of the user memory when memory is
   * shared with the CLIs (main/memory-writeback.ts `kind`; `file` as written in import keys).
   */
  memory?: { kind: 'opencode-md' | 'gemini-md'; file: string };
  /**
   * How it loads the workspace skill library (main/providers/acp-native.ts): `config` adds the skills
   * folder to OpenCode's config (`skills.paths`, OpenCode 2 and later); `workspace` adds the library's
   * folder to the session (ACP additionalDirectories), whose `.agents/skills` holds real copies
   * (Antigravity follows no symbolic links there).
   */
  skills?: 'config' | 'workspace';
  /**
   * Arguments that print its account's usage limits as JSON without a model call
   * (Antigravity: `agy -p /usage --output-format json`); read by main/providers/acp-limits.ts.
   */
  limits?: readonly string[];
  /**
   * Its sign-in, natively (ACP has no status call): how the state is read without a model call
   * (`status`, parsed by main/providers/acp-auth.ts) and how the app signs it in. `terminal`: its
   * login is an interactive menu, run in a Terminal window (OpenCode). `acpMethod`: the ACP
   * `authenticate` method that opens the browser on this computer; `codeLogin`: arguments that
   * print a sign-in link and read the code its page shows on stdin (Antigravity, and on SSH hosts).
   */
  signIn?: { status: 'opencode' | 'antigravity'; terminal?: boolean; acpMethod?: string; codeLogin?: readonly string[] };
}

export const ACP_AGENTS = [
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    dirs: ['.opencode/bin'],
    install: 'curl -fsSL https://opencode.ai/install | bash',
    login: 'opencode auth login',
    docs: 'https://opencode.ai/docs/acp',
    mark: 'O',
    // Simple Icons (CC0 data; the mark is its owner's trademark).
    icon: { viewBox: '0 0 24 24', d: 'M22 24H2V0h20zM17 4.8H7v14.4h10z' },
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } }) },
    // OpenCode 2.x's server API (`opencode api`); 1.x has none, and forks whole conversations only.
    forkBefore: (sessionId: string, messageId: string) => ['api', 'session.fork', '--param', `sessionID=${sessionId}`, '-d', JSON.stringify({ before: messageId })],
    emptyTitle: /^New session - \d{4}-\d\d-\d\dT/,
    memory: { kind: 'opencode-md', file: '~/.config/opencode/AGENTS.md' },
    skills: 'config',
    // `opencode auth list`; without stored credentials its built-in free models still work.
    signIn: { status: 'opencode', terminal: true },
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    command: 'agy',
    args: ['acp'],
    dirs: ['.local/bin'],
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    login: 'agy acp --login',
    docs: 'https://antigravity.google/docs/cli/acp/',
    mark: 'A',
    // The mark from antigravity.google's favicon, in one colour.
    icon: {
      viewBox: '7.6 9.8 96 96',
      d: 'M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z',
    },
    memory: { kind: 'gemini-md', file: '~/.gemini/GEMINI.md' },
    skills: 'workspace',
    limits: ['-p', '/usage', '--output-format', 'json'],
    // `agy models` fails at once when signed out ("Please sign in…"); `-p /usage` would wait a minute for a login.
    signIn: { status: 'antigravity', acpMethod: 'oauth-personal', codeLogin: ['acp', '--login'] },
  },
] as const satisfies readonly AcpAgentSpec[];

export type AcpProvider = (typeof ACP_AGENTS)[number]['id'];

export const ACP_IDS: AcpProvider[] = ACP_AGENTS.map((a) => a.id);

export function acpAgent(id: string): AcpAgentSpec | undefined {
  return (ACP_AGENTS as readonly AcpAgentSpec[]).find((a) => a.id === id);
}

export function isAcpProvider(id: string | undefined): id is AcpProvider {
  return !!id && ACP_IDS.includes(id as AcpProvider);
}

/** Environment variable that replaces an agent's command line (a JSON array: executable, then arguments). Tests point it at a fake agent. */
export const acpCommandEnv = (id: string) => `AMW_ACP_COMMAND_${id.toUpperCase()}`;
