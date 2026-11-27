import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { acpCommandEnv, type AcpAgentSpec } from '../../shared/acp-agents';
import type { AgentProvider, AttentionQuestion, ForkPoint, ModelOption, PermissionKind, NativeSessionInfo, PermissionMode, ProviderCapabilities } from '../../shared/types';
import { transientKind } from '../retry';
import { detachedSpawn, type RemoteRunner } from '../util/detached';
import { childEnv, findExecutable, needsShell, run } from '../util/exec';
import { shq, sshError, sshRunner } from '../util/ssh';
import { MCP_TOOLS_NOTE, startMcpBridge, type McpBridge } from './acp-mcp';
import { AcpLimitsReader, planOf } from './acp-limits';
import { authScript, parseAuth, readAuth, splitAuthScript } from './acp-auth';
import { acpNative, mergeEnv } from './acp-native';
import { acpApprovalHeadline, acpBlockText, commandOf, readOnlyCommand, acpPlan, acpToolInfo, acpToolStatus, mergeAcpTool, type AcpTool } from './acp-content';
import type { ApprovalResponse, Delivery, ForkSessionOpts, HistoryImage, ImageInput, ProviderAdapter, ProviderEvent, ProviderSession, StartArgs } from './types';
import { cleanUserText } from './user-text';

// Any CLI with an Agent Client Protocol server (agentclientprotocol.com, protocol version 1): JSON-RPC
// 2.0, one message per line, over the CLI's stdin/stdout; this app is the client. The CLI keeps its
// own tools, login and settings: no file system or terminal is offered to it (no fs/terminal client
// capabilities), so it reads, writes and runs commands itself and asks permission through
// session/request_permission. On an SSH host the CLI runs there, detached from the connection (as
// Codex does), so a dropped connection costs nothing. Which CLIs: shared/acp-agents.ts.

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: 'agent_workspace', title: 'Agent Workspace', version: '0.1.0' };
/** ACP's "authentication required" error code. */
const AUTH_REQUIRED = -32000;
const PERMISSION_KINDS: PermissionKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];

class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Minimal JSON-RPC 2.0 peer (newline-delimited) over one agent process. */
export class AcpConnection {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  closed = false;
  onNotification: (method: string, params: Rec) => void = () => {};
  onRequest: (id: string | number, method: string, params: Rec) => void = () => {};
  onExit: (reason: string) => void = () => {};
  private stderrTail = '';

  constructor(
    private proc: ChildProcessWithoutNullStreams,
    private label: string,
    private host?: string,
  ) {
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg: Rec;
      try {
        msg = rec(JSON.parse(line));
      } catch {
        return; // a CLI's stray log line on stdout
      }
      this.receive(msg);
    });
    // stderr may hold private diagnostics: never forwarded; its tail only explains a failed start.
    proc.stderr.on('data', (d: Buffer) => (this.stderrTail = (this.stderrTail + d.toString()).slice(-2000)));
    proc.on('exit', (code, signal) => this.shutdown(this.exitReason(code, signal)));
    proc.on('error', (err) => this.shutdown(err.message));
    proc.stdin.on('error', (err) => this.shutdown(err.message));
  }

  private exitReason(code: number | null, signal: NodeJS.Signals | null): string {
    if (this.host && code === 255) return sshError(this.host, this.stderrTail);
    const last = this.stderrTail.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    return `${this.label}${this.host ? ` on ${this.host}` : ''} exited (${signal ?? code})${last && code ? `: ${last.slice(0, 200)}` : ''}.`;
  }

  /** `timeoutMs` 0: no limit (a prompt runs as long as its turn). */
  rpc(method: string, params: Rec, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${this.label} timed out during ${method}.`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params: Rec): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  reply(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  replyError(id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(msg: unknown): void {
    if (this.closed) throw new Error(`${this.label} is not running.`);
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  kill(): void {
    const pid = this.proc.pid;
    if (!pid) this.proc.kill('SIGTERM'); // on a host: stopped there
    try {
      if (pid) process.kill(-pid, 'SIGTERM'); // its own process group: the commands it started too
    } catch {
      this.proc.kill('SIGTERM');
    }
    const hard = setTimeout(() => {
      try {
        if (pid) process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
    hard.unref();
    this.shutdown('stopped');
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.onExit(reason);
  }

  private receive(msg: Rec): void {
    const method = str(msg.method);
    const id = msg.id;
    if (!method && (typeof id === 'number' || typeof id === 'string')) {
      const p = this.pending.get(Number(id));
      if (!p) return;
      this.pending.delete(Number(id));
      clearTimeout(p.timer);
      if (msg.error) {
        const e = rec(msg.error);
        p.reject(new RpcError(str(e.message) || `${this.label} request failed.`, typeof e.code === 'number' ? e.code : undefined));
      } else p.resolve(msg.result);
      return;
    }
    if (method && (typeof id === 'string' || typeof id === 'number')) this.onRequest(id, method, rec(msg.params));
    else if (method) this.onNotification(method, rec(msg.params));
  }
}

export interface AcpAdapterOptions {
  /** How commands reach an SSH host (tests: a local shell). */
  runner?: (host: string) => RemoteRunner;
  /** The command line instead of the registry's (else the AMW_ACP_COMMAND_<ID> variable). */
  command?: string[];
  /** Passed to the detached transport (tests: quick reconnects, giving up soon). */
  backoff?: number[];
  giveUpMs?: number;
}

/** The agent's permission modes (ACP session modes) that match the app's, when it has them (Antigravity: default / accept-edits / auto). */
function permissionModes(modes: Array<{ id: string; name: string }>): Partial<Record<PermissionMode, string>> | undefined {
  const find = (re: RegExp) => modes.find((m) => re.test(m.id) || re.test(m.name))?.id;
  const ask = find(/^(default|ask|ask before edits)$/i);
  const edits = find(/^accept[ _-]?edits$/i);
  if (!ask || !edits) return undefined;
  return { ask, edits, auto: find(/^auto$/i) ?? edits };
}

/** Pulls the model choice out of a session/new (or load, config) result: a `model` config option, or the older `models` field. */
function modelsOf(result: Rec): { kind: 'config'; configId: string; current: string; list: ModelOption[] } | { kind: 'legacy'; current: string; list: ModelOption[] } | undefined {
  const opts = arr(result.configOptions).map(rec);
  const cfg = opts.find((o) => o.category === 'model' && o.type === 'select') ?? opts.find((o) => o.id === 'model' && o.type === 'select');
  if (cfg) {
    const flat = arr(cfg.options).flatMap((o) => (Array.isArray(rec(o).options) ? arr(rec(o).options) : [o])).map(rec);
    return {
      kind: 'config',
      configId: str(cfg.id),
      current: str(cfg.currentValue),
      list: flat.filter((o) => str(o.value)).map((o) => ({ id: str(o.value), label: str(o.name) || str(o.value), description: str(o.description) || undefined })),
    };
  }
  const legacy = rec(result.models);
  if (Array.isArray(legacy.availableModels))
    return {
      kind: 'legacy',
      current: str(legacy.currentModelId),
      list: arr(legacy.availableModels)
        .map(rec)
        .filter((m) => str(m.modelId))
        .map((m) => ({ id: str(m.modelId), label: str(m.name) || str(m.modelId), description: str(m.description) || undefined })),
    };
  return undefined;
}

export interface SaidLine {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

const COPY_OPEN = '<conversation-copy>';
const COPY_CLOSE = '</conversation-copy>';
const COPY_LIMIT = 200_000;

/**
 * A conversation carried into a new session as text (a fork or a side question where the CLI cannot
 * copy sessions itself): JSON lines between tags, then what follows. Long ones keep their latest part.
 */
export function conversationCopy(lines: SaidLine[], after: string): string {
  const kept: SaidLine[] = [];
  let size = 0;
  for (const l of [...lines].reverse()) {
    const line = { role: l.role, text: l.text.slice(0, 20_000) };
    size += line.text.length + 40;
    if (size > COPY_LIMIT) break;
    kept.unshift(line);
  }
  return `${COPY_OPEN}\n${kept.map((l) => JSON.stringify(l)).join('\n')}\n${COPY_CLOSE}\n\n${after}`;
}

/** The lines of a conversation copy, and the message that came with it (when it is more than the copy's own note). */
export function parseCopy(text: string): { lines: SaidLine[]; rest?: string } | undefined {
  const start = text.indexOf(COPY_OPEN);
  const end = text.indexOf(COPY_CLOSE);
  if (start === -1 || end < start || text.slice(0, start).trim()) return undefined;
  const lines: SaidLine[] = [];
  for (const raw of text.slice(start + COPY_OPEN.length, end).split('\n')) {
    try {
      const l = rec(JSON.parse(raw));
      if ((l.role === 'user' || l.role === 'assistant' || l.role === 'tool') && typeof l.text === 'string') lines.push({ role: l.role, text: l.text });
    } catch {
      /* blank */
    }
  }
  const rest = text.slice(end + COPY_CLOSE.length).trim();
  return { lines, rest: rest && rest !== COPY_NOTE ? rest.replace(/^\(A side question[^)]*\)\s*/, '') : undefined };
}

/** What goes with a copied conversation that is to be continued (forks): only an acknowledgement is asked for. */
export const COPY_NOTE = 'The conversation above is a copy of an earlier conversation with you, carried over from another session. Continue from it as if it were this one. For now reply with only: ok';

const SIDE_NOTE =
  '(A side question, asked while you work on the conversation above. Answer it briefly from what you already know of that conversation. Do not use tools or change anything; this answer does not become part of the conversation.)';

/** Files named with @ in a message (`@src/a.ts`, `@"with space.md"`) that exist, as absolute paths. */
export function mentionedFiles(text: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g)) {
    const raw = (m[1] ?? m[2]).replace(/[.,;:!?)]+$/, '');
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    try {
      if (statSync(abs).isFile()) out.add(abs);
    } catch {
      /* not a file */
    }
  }
  return [...out].slice(0, 20);
}

/** A path the agent names lies inside the agent's folder. */
function inside(path: string, cwd: string): boolean {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, abs);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export class AcpAdapter implements ProviderAdapter {
  readonly provider: AgentProvider;
  readonly remote = true;
  /** Models seen in sessions (per machine; '' = this computer): ACP lists them per session, not per CLI. */
  readonly models = new Map<string, ModelOption[]>();
  /** The CLI's version per machine ('' = this computer), as last checked: what its configuration may say depends on it. */
  readonly versions = new Map<string, string | undefined>();
  /** Account limits, for a CLI that prints them (registry `limits`); shared by its sessions. */
  readonly limits = new AcpLimitsReader((host) => this.runLimits(host));

  constructor(
    readonly spec: AcpAgentSpec,
    readonly opts: AcpAdapterOptions = {},
  ) {
    this.provider = spec.id as AgentProvider;
  }

  /** The command line set from outside (tests), if any. */
  private override(): string[] | undefined {
    if (this.opts.command) return this.opts.command;
    const env = process.env[acpCommandEnv(this.spec.id)];
    if (!env) return undefined;
    try {
      const argv = JSON.parse(env);
      if (Array.isArray(argv) && argv.length && argv.every((a) => typeof a === 'string')) return argv;
    } catch {
      /* not JSON */
    }
    return env.split(/\s+/).filter(Boolean);
  }

  /**
   * The CLI itself, for its other commands (status, limits, login). On a host: its name, found on the
   * PATH set by remotePath (as installed there). Here: a test's command line without the ACP server's
   * arguments it ends with, else the executable; null when not installed.
   */
  cliArgv(host?: string): string[] | null {
    if (host) return [this.spec.command];
    const override = this.override();
    if (override) {
      const n = this.spec.args.length;
      const tail = override.slice(-n);
      return n && override.length > n && tail.every((a, i) => a === this.spec.args[i]) ? override.slice(0, -n) : override;
    }
    const exe = this.executable();
    return exe ? [exe] : null;
  }

  /** The executable on this computer: PATH (incl. the usual install folders), then the installer's own folder. */
  executable(): string | null {
    for (const dir of this.spec.dirs) {
      const candidate = join(homedir(), dir, this.spec.command);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
    return findExecutable(this.spec.command);
  }

  runner(host: string): RemoteRunner {
    return this.opts.runner ? this.opts.runner(host) : sshRunner(host);
  }

  /** On a host: its login shell's PATH plus the installers' folders. */
  remotePath(): string {
    return `export PATH="${[...new Set(this.spec.dirs)].map((d) => `$HOME/${d}`).join(':')}:$PATH"`;
  }

  /** The registry's environment for the CLI, then `extra` (a session's: acp-native.ts), merged over the same variables' values in `base` (JSON ones key by key). */
  agentEnv(base: Record<string, string | undefined>, extra?: Record<string, string>): Record<string, string> {
    return mergeEnv(base, this.spec.env, extra);
  }

  spawn(cwd: string, host?: string, extraEnv?: Record<string, string>): AcpConnection {
    const override = this.override();
    if (host) {
      const argv = (override ?? [this.spec.command, ...this.spec.args]).map(shq).join(' ');
      // (The host's own value of a merged variable is not known here: ours, as given.)
      const env = Object.entries(this.agentEnv({}, extraEnv)).map(([k, v]) => `export ${k}=${shq(v)}; `).join('');
      const command = `${this.remotePath()}; ${env}cd ${cwd === '~' ? '' : shq(cwd)} 2>/dev/null; exec ${argv}`;
      const proc = detachedSpawn(this.runner(host), command, { backoff: this.opts.backoff, giveUpMs: this.opts.giveUpMs, onLink: (s) => console.warn(`[ssh] ${host}: connection ${s}`) });
      return new AcpConnection(proc, this.spec.label, host);
    }
    const argv = override ?? (() => {
      const exe = this.executable();
      if (!exe) throw new Error(`${this.spec.label} CLI not found on PATH.`);
      return [exe, ...this.spec.args];
    })();
    const [exe, ...args] = argv;
    const base = childEnv();
    const proc = spawn(needsShell(exe) ? `"${exe}"` : exe, args, { cwd, env: { ...base, ...this.agentEnv(base, extraEnv) }, stdio: 'pipe', detached: process.platform !== 'win32', shell: needsShell(exe) });
    return new AcpConnection(proc, this.spec.label);
  }

  private describe(available: boolean, version: string | undefined, detail: string, auth?: ProviderCapabilities['auth']): ProviderCapabilities {
    return {
      provider: this.provider,
      available,
      version,
      detail,
      // ACP has no sign-in status call: the CLI's own commands tell (acp-auth.ts); unknown, a prompt that needs a login fails with the hint (errorText).
      ...(auth ? { auth } : {}),
      createSession: available,
      resumeHistorical: available,
      // session/list + session/load ("Continue a session"); a CLI without session/list lists nothing.
      importHistory: available,
      attachExternalRunning: false,
      readOnlyMonitor: false,
      structuredApprovals: true,
      // Forms the agent asks to fill in (ACP elicitation: OpenCode's question tool) become question cards.
      structuredQuestions: available,
      // (Set by the workspace from forkSession/forkPoints.)
      fork: false,
      // A copy of the session (session/fork), else a new one given the conversation: both always possible.
      sideQuestions: available,
    };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const override = this.override();
    if (override) return this.describe(true, undefined, `${this.spec.label} (ACP) → ${override.join(' ')}`, await this.localAuth(this.cliArgv()!));
    const path = this.executable();
    const version = path ? (await run(path, ['--version'], { timeoutMs: 15_000 })).stdout.trim().split('\n')[0] || undefined : undefined;
    this.versions.set('', version);
    const auth = path ? await this.localAuth([path]) : undefined;
    return this.describe(!!path, version, path ? `${this.spec.command} ${this.spec.args.join(' ')} (ACP over stdio) → ${path}. Uses its own sign-in.` : `${this.spec.label} CLI not found on PATH.`, auth);
  }

  /** The sign-in state on this computer, with `argv` (the executable, or a test's command line). */
  private localAuth(argv: string[]): Promise<ProviderCapabilities['auth']> {
    const kind = this.spec.signIn?.status;
    if (!kind) return Promise.resolve(undefined);
    const [exe, ...pre] = argv;
    // Read afresh each time, as Claude Code's and Codex's status commands are: a recheck right after a sign-in sees it.
    return readAuth(kind, (args) => run(exe, [...pre, ...args], { timeoutMs: 20_000 })).catch(() => undefined);
  }

  async hostCapabilities(host: string): Promise<ProviderCapabilities> {
    const argv = this.cliArgv(host)!;
    const exe = argv.map(shq).join(' ');
    const kind = this.spec.signIn?.status;
    // One connection: the version, then the sign-in (acp-auth.ts), each output marked.
    const status = kind ? `; echo __AMW_VERSION_END__; ${authScript(kind, exe, shq)}` : '';
    const r = await this.runner(host).run(`${this.remotePath()}; command -v ${shq(argv[0])} >/dev/null || exit 127; ${exe} --version 2>/dev/null </dev/null | head -n 1${status}`, 45_000);
    if (r.code === 255) throw new Error(sshError(host, r.stderr));
    const found = r.code !== 127;
    const [head, rest = ''] = r.stdout.split('__AMW_VERSION_END__');
    const version = found ? head.trim() || undefined : undefined;
    this.versions.set(host, version);
    const auth = found && kind ? parseAuth(kind, splitAuthScript(rest.replace(/^\n/, ''))) : undefined;
    return this.describe(found, version, found ? `${this.spec.command} ${this.spec.args.join(' ')} over SSH on ${host}, with the sign-in there.` : `${this.spec.label} CLI not found on ${host} (in its login shell's PATH).`, auth);
  }

  /** The registry's limits command, on this computer or the host (acp-limits.ts parses it). */
  private async runLimits(host?: string): Promise<{ code: number | null; stdout: string }> {
    const args = this.spec.limits;
    if (!args?.length) return { code: 1, stdout: '' };
    if (host) {
      const argv = [...this.cliArgv(host)!, ...args].map(shq).join(' ');
      return this.runner(host).run(`${this.remotePath()}; ${argv} </dev/null`, 30_000);
    }
    const [exe, ...pre] = this.cliArgv() ?? [''];
    if (!exe) return { code: 1, stdout: '' };
    return run(exe, [...pre, ...args], { timeoutMs: 30_000 });
  }

  /** A folder for sessions that are not about the agent's folder (side questions without session/fork). */
  scratchDir(host?: string): string {
    if (host) return '/tmp';
    const dir = join(tmpdir(), 'amw-acp-side');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A short-lived connection (initialized) for one job, closed afterwards. */
  private async oneOff<T>(cwd: string, host: string | undefined, job: (conn: AcpConnection, caps: Rec) => Promise<T>): Promise<T> {
    const conn = this.spawn(host ? cwd : existsSync(cwd) ? cwd : homedir(), host);
    try {
      const init = rec(await conn.rpc('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } }, clientInfo: CLIENT_INFO }));
      return await job(conn, rec(init.agentCapabilities));
    } finally {
      conn.kill();
    }
  }

  /** Saved sessions (ACP session/list): of one folder, or every folder. Sessions nothing was said in yet are left out. */
  async discoverSessions(filter: { cwd?: string; limit?: number; host?: string }): Promise<NativeSessionInfo[]> {
    const limit = filter.limit ?? 100;
    return this.oneOff(filter.cwd ?? (filter.host ? '~' : homedir()), filter.host, async (conn, caps) => {
      if (!rec(caps.sessionCapabilities).list) return [];
      const out: NativeSessionInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10 && out.length < limit; page++) {
        const r = rec(await conn.rpc('session/list', { ...(filter.cwd ? { cwd: filter.cwd } : {}), ...(cursor ? { cursor } : {}) }));
        for (const x of arr(r.sessions).map(rec)) {
          const id = str(x.sessionId);
          const cwd = str(x.cwd);
          const title = str(x.title);
          if (!id || (filter.cwd && cwd && cwd !== filter.cwd) || (this.spec.emptyTitle && this.spec.emptyTitle.test(title))) continue;
          out.push({ provider: this.provider, nativeSessionId: id, cwd: cwd || filter.cwd || '', ...(filter.host ? { host: filter.host } : {}), title: title || id, ...(str(x.updatedAt) ? { updatedAt: str(x.updatedAt) } : {}) });
        }
        cursor = str(r.nextCursor) || undefined;
        if (!cursor) break;
      }
      return out.slice(0, limit);
    });
  }

  /** A saved conversation, read with session/load on a connection of its own (history events only). */
  async readHistory(nativeSessionId: string, cwd: string, host?: string): Promise<ProviderEvent[]> {
    return (await this.readSaved(nativeSessionId, cwd, host)).events;
  }

  private async readSaved(nativeSessionId: string, cwd: string, host?: string): Promise<{ events: ProviderEvent[]; said: SaidLine[]; prompts: Array<{ messageId?: string; text: string; index: number }> }> {
    const events: ProviderEvent[] = [];
    const session = new AcpSession(this, { cwd, host, title: '', resumeNativeSessionId: nativeSessionId }, (e) => events.push(e), true);
    try {
      await session.start();
    } finally {
      await session.close();
    }
    return { events: events.filter((e) => e.type === 'transcriptItem'), said: session.said, prompts: session.prompts };
  }

  /**
   * Where a saved conversation can be forked: before each of the user's prompts. OpenCode 2.x by
   * message (its own fork API); a CLI without session/fork by copying the conversation up to there.
   */
  async forkPoints(nativeSessionId: string, cwd: string): Promise<ForkPoint[]> {
    const saved = await this.readSaved(nativeSessionId, cwd);
    const native = this.spec.forkBefore && (await this.forkApiWorks());
    const points: ForkPoint[] = [];
    for (const p of saved.prompts.slice(1)) {
      if (native && p.messageId) points.push({ upToMessageId: `before:${p.messageId}`, prompt: p.text });
      else if (!native) points.push({ upToMessageId: `said:${p.index}`, prompt: p.text });
    }
    return points;
  }

  private forkApi?: Promise<boolean>;
  /** The CLI has the fork-before command (OpenCode 2.x; not 1.x). */
  private forkApiWorks(): Promise<boolean> {
    const exe = this.executable();
    if (!this.spec.forkBefore || !exe || this.override()) return Promise.resolve(false);
    return (this.forkApi ??= run(exe, [this.spec.forkBefore('x', 'y')[0], '--help'], { timeoutMs: 15_000 }).then((r) => r.code === 0));
  }

  /**
   * A copy of a saved conversation as a new session. Whole: ACP session/fork where offered. Before a
   * prompt: OpenCode's own fork command. Otherwise (Antigravity) a new session in `targetCwd` given the
   * conversation as text in its first prompt (the agent acknowledges it; a replay shows the copied
   * conversation, not that prompt). Such a copy carries what was said and the tools' titles, not their output.
   */
  async forkSession(nativeSessionId: string, opts: ForkSessionOpts): Promise<string> {
    const target = opts.targetCwd ?? opts.cwd;
    const up = opts.upToMessageId;
    // OpenCode keeps a session to its folder (loading or forking it elsewhere is refused): a fork into
    // another folder (its own worktree) is the copy as text, from the same point.
    const elsewhere = resolve(target) !== resolve(opts.cwd);
    if (up?.startsWith('before:') && !elsewhere) {
      const exe = this.executable();
      if (!exe || !this.spec.forkBefore) throw new Error(`${this.spec.label} cannot fork from an earlier point.`);
      const r = await run(exe, this.spec.forkBefore(nativeSessionId, up.slice('before:'.length)), { timeoutMs: 60_000, cwd: existsSync(opts.cwd) ? opts.cwd : undefined });
      let id = '';
      try {
        id = str(rec(rec(JSON.parse(r.stdout)).data).id);
      } catch {
        /* below */
      }
      if (!id) throw new Error(`${this.spec.label} did not fork the conversation${r.stderr.trim() ? `: ${r.stderr.trim().split('\n')[0].slice(0, 200)}` : '.'}`);
      return id;
    }
    const whole = !up;
    const viaFork = whole && !elsewhere && (await this.oneOff(target, undefined, async (conn, caps) => {
      if (!rec(caps.sessionCapabilities).fork) return '';
      return str(rec(await conn.rpc('session/fork', { sessionId: nativeSessionId, cwd: target, mcpServers: [] }, 120_000)).sessionId);
    }));
    if (viaFork) return viaFork;
    const saved = await this.readSaved(nativeSessionId, opts.cwd);
    const before = up?.startsWith('before:') ? saved.prompts.find((p) => p.messageId === up.slice('before:'.length)) : undefined;
    const cut = up?.startsWith('said:') ? Number(up.slice('said:'.length)) : before ? before.index : saved.said.length;
    const lines = saved.said.slice(0, cut);
    if (!lines.length) throw new Error(`There is nothing to fork in that ${this.spec.label} conversation yet.`);
    return this.oneOff(target, undefined, async (conn) => {
      const id = str(rec(await conn.rpc('session/new', { cwd: target, mcpServers: [] }, 180_000)).sessionId);
      if (!id) throw new Error(`${this.spec.label} did not return a session id.`);
      const r = rec(await conn.rpc('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: conversationCopy(lines, COPY_NOTE) }] }, 300_000));
      if (str(r.stopReason) === 'refusal') throw new Error(`${this.spec.label} refused the copied conversation.`);
      return id;
    });
  }

  /** The models a session of this CLI offered on that machine (ACP lists them per session). */
  async listModels(host?: string): Promise<ModelOption[]> {
    const list = this.models.get(host ?? '');
    if (!list) throw new Error(`${this.spec.label} lists its models once the agent has started.`);
    return list;
  }

  createSession(args: StartArgs, onEvent: (event: ProviderEvent) => void): ProviderSession {
    return new AcpSession(this, args, onEvent);
  }
}

interface PendingPermission {
  rpcId: string | number;
  options: Array<{ optionId: string; name: string; kind: string }>;
  toolCallId?: string;
  /** A form (elicitation/create): its fields, answered by name. */
  form?: FormField[];
}

/**
 * A form an agent asks the user to fill in (ACP elicitation, MCP-style requested schema: OpenCode's
 * question tool) as the app's questions: choices for enums and booleans, free text otherwise.
 */
interface FormField {
  name: string;
  type: string;
  multi?: boolean;
  /** The offered values, and the field for an answer of one's own instead (OpenCode: `<name>_custom`). */
  values?: string[];
  other?: string;
  /** Option labels (what the question card answers with) to the values. */
  labels?: Record<string, string>;
}

export function formQuestions(schema: Rec): { questions: AttentionQuestion[]; fields: FormField[] } {
  const props = rec(schema.properties);
  const questions: AttentionQuestion[] = [];
  const fields: FormField[] = [];
  for (const [name, raw] of Object.entries(props)) {
    if (name.endsWith('_custom') && props[name.slice(0, -'_custom'.length)]) continue; // folded into its question
    const p = rec(raw);
    const type = str(p.type) || 'string';
    const items = rec(p.items);
    const multi = type === 'array';
    const choices = arr(multi ? (items.enum ?? arr(items.anyOf).map((o) => rec(o).const)) : (p.enum ?? arr(p.oneOf).map((o) => rec(o).const))).filter((v) => typeof v === 'string') as string[];
    const titles = arr(multi ? items.anyOf : p.oneOf).map(rec);
    const label = (v: string) => str(titles.find((t) => t.const === v)?.title) || v;
    const options = type === 'boolean' ? [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }] : choices.map((v) => ({ id: v, label: label(v) }));
    const other = props[`${name}_custom`] ? `${name}_custom` : undefined;
    questions.push({ id: name, question: str(p.description) || str(p.title) || name, header: str(p.title) || undefined, options, multiSelect: multi || undefined, allowOther: !options.length || !!other || undefined });
    const labels = Object.fromEntries(options.filter((o) => o.label !== o.id).map((o) => [o.label, o.id]));
    fields.push({ name, type, multi, ...(choices.length ? { values: choices } : {}), ...(other ? { other } : {}), ...(Object.keys(labels).length && type !== 'boolean' ? { labels } : {}) });
  }
  return { questions, fields };
}

class AcpSession implements ProviderSession {
  readonly provider: AgentProvider;
  private conn?: AcpConnection;
  private sessionId?: string;
  private agentCaps: Rec = {};
  private closed = false;
  private working = false;
  private interruptRequested = false;
  private replaying = false;
  private queue: Rec[][] = [];
  private idleWaiters: Array<() => void> = [];
  private lastAgentText = '';
  /** The app's instructions, still to go with the next prompt (an agent without ACP system prompts). */
  private instructionsDue?: string;
  private seg?: { role: 'assistant' | 'thought' | 'user'; id: string; text: string; messageId?: string; images?: HistoryImage[] };
  private tools = new Map<string, AcpTool>();
  private declined = new Set<string>();
  private requests = new Map<string, PendingPermission>();
  private model?: { kind: 'config'; configId: string; current: string; list: ModelOption[] } | { kind: 'legacy'; current: string; list: ModelOption[] };
  /** The model the session started on, before any pick: what "the CLI's default" means here. */
  private defaultModel?: string;
  private permModes?: Partial<Record<PermissionMode, string>>;
  /** Main agent: the bridge serving its workspace tools. */
  private bridge?: McpBridge;
  private lastCost?: number;
  /** The account's plan, as the CLI named it at the start (Antigravity's tier). */
  private plan?: string;
  /** The conversation as said (user, agent and tool lines): what a copy of it carries (side questions, forks without session/fork). */
  readonly said: SaidLine[] = [];
  /** The user's prompts in a replay (with the CLI's message id, if it gives one), and where each starts in `said`. */
  readonly prompts: Array<{ messageId?: string; text: string; index: number }> = [];
  /** Side-question sessions open on this connection, by session id. */
  private sides = new Map<string, { text: string; done?: (error?: Error) => void }>();
  /** In a replay: the agent's "ok" after a conversation copy is not shown. */
  private skipAck = false;

  constructor(
    private adapter: AcpAdapter,
    private args: StartArgs,
    private emit: (event: ProviderEvent) => void,
    /** Only the saved conversation, read (session/load) and nothing else. */
    private historyOnly = false,
  ) {
    this.provider = adapter.provider;
  }

  private get label(): string {
    return this.adapter.spec.label;
  }

  nativeSessionId(): string | undefined {
    return this.sessionId;
  }

  /** A failed request as the user should read it: a missing login says how to sign in. */
  private errorText(error: unknown): string {
    const e = error as RpcError;
    if (e.code === AUTH_REQUIRED || /auth(entication)? required|not (logged|signed) in|unauthori[sz]ed/i.test(e.message ?? ''))
      return this.args.host
        ? `${this.label} on ${this.args.host} is not signed in. Sign in from Settings › Remote machines (or run ${this.adapter.spec.login} there), then try again.`
        : `${this.label} is not signed in. Sign in from Settings › Coding agents (or run ${this.adapter.spec.login} in a terminal), then try again.`;
    return e.message || String(error);
  }

  async start(): Promise<void> {
    // The workspace skills, through the CLI's own configuration (acp-native.ts).
    const native = acpNative(this.adapter.spec, this.args.skills, this.adapter.versions.get(this.args.host ?? ''));
    const conn = this.adapter.spawn(this.args.cwd, this.args.host, native.env);
    this.conn = conn;
    conn.onNotification = (method, p) => {
      if (method === 'session/update') this.update(p);
    };
    conn.onRequest = (id, method, p) => this.request(id, method, p);
    conn.onExit = (reason) => this.exited(reason);
    try {
      const init = rec(
        await conn.rpc('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          // No file system, terminal or terminal-login: the agent uses its own tools and its own sign-in.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
          clientInfo: CLIENT_INFO,
        }),
      );
      this.agentCaps = rec(init.agentCapabilities);
      const sessionCaps = rec(this.agentCaps.sessionCapabilities);
      // Main agent: the workspace tools, as an MCP server this app serves (acp-mcp.ts), and where to find them.
      if (this.args.tools?.length && !this.args.host) this.bridge = await startMcpBridge(this.args.tools);
      const instructions = [this.args.developerInstructions?.trim(), this.bridge ? MCP_TOOLS_NOTE : '', native.instructions].filter(Boolean).join('\n\n') || undefined;
      // System prompts: ACP's own field, or Antigravity's `_meta.antigravity.systemPrompt.append`; else with the first prompt.
      const agyAppend = rec(rec(rec(this.agentCaps._meta).antigravity).systemPrompt).append === true;
      const systemPrompt = !instructions
        ? {}
        : sessionCaps.systemPrompt
          ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: instructions }] } }
          : agyAppend
            ? { _meta: { antigravity: { systemPrompt: { append: instructions } } } }
            : {};
      const dirs = sessionCaps.additionalDirectories && native.additionalDirectories.length ? { additionalDirectories: native.additionalDirectories } : {};
      const base = { cwd: this.args.cwd, mcpServers: this.bridge ? [this.bridge.server] : [], ...systemPrompt, ...dirs };
      const resumeId = this.args.resumeNativeSessionId;
      let result: Rec | undefined;
      let resumed = false;
      if (resumeId && (this.agentCaps.loadSession === true || sessionCaps.resume)) {
        this.sessionId = resumeId;
        try {
          if (this.agentCaps.loadSession === true) {
            // The agent replays the conversation as session/update notifications before it answers.
            this.replaying = true;
            result = rec(await conn.rpc('session/load', { ...base, sessionId: resumeId }, 180_000));
            this.endReplay();
          } else result = rec(await conn.rpc('session/resume', { ...base, sessionId: resumeId }, 180_000));
          resumed = true;
        } catch (error) {
          this.replaying = false;
          if (conn.closed) throw error;
          // Gone on the agent's side: a new conversation, said so.
          this.sessionId = undefined;
          this.emit({ type: 'transcriptItem', itemId: `sys-${randomUUID()}`, role: 'system', text: `Could not reopen the earlier ${this.label} conversation (${this.errorText(error)}); started a new one.` });
        }
      } else if (resumeId)
        this.emit({ type: 'transcriptItem', itemId: `sys-${randomUUID()}`, role: 'system', text: `${this.label} cannot reopen earlier conversations; started a new one.` });
      if (this.historyOnly) {
        if (!resumed) throw new Error(`${this.label} could not read that conversation.`);
        return;
      }
      if (!resumed) {
        result = rec(await conn.rpc('session/new', base, 180_000));
        this.sessionId = str(result.sessionId);
        if (!this.sessionId) throw new Error(`${this.label} did not return a session id.`);
      }
      // Without ACP system prompts: with the first prompt (again after a resume, as they may have changed).
      if (instructions && !sessionCaps.systemPrompt && !agyAppend) this.instructionsDue = instructions;
      this.readModes(result ?? {});
      this.readModels(result ?? {}, true);
      await this.applyPermissionMode().catch(() => undefined);
      if (this.args.model && this.model && this.args.model !== this.model.current) await this.setModel(this.args.model).catch((e: Error) => this.emit({ type: 'progress', text: `Model not changed: ${e.message}` }));
      this.plan = planOf(result ?? {});
      this.emit({ type: 'sessionStarted', nativeSessionId: this.sessionId!, resumed });
      this.refreshLimits();
    } catch (error) {
      conn.kill();
      this.bridge?.close();
      throw new Error(this.errorText(error));
    }
  }

  private exited(reason: string): void {
    for (const id of this.requests.keys()) this.emit({ type: 'requestResolved', requestId: id, reason: 'disconnected' });
    this.requests.clear();
    this.working = false;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    if (this.closed || reason === 'stopped') return;
    // The connection to its host (not the agent) went: the workspace reconnects by itself.
    if (this.args.host && /ssh|connection/i.test(reason)) this.emit({ type: 'sessionFailed', error: reason });
    else this.emit({ type: 'sessionDisconnected', reason });
  }

  // ---------------------------------------------------------------- modes and models

  private readModes(result: Rec): void {
    const modes = rec(result.modes);
    const list = arr(modes.availableModes).map(rec).map((m) => ({ id: str(m.id), name: str(m.name) })).filter((m) => m.id);
    this.permModes = permissionModes(list);
  }

  /** The agent's own permission mode, when it has ones like the app's: then its policy decides, as Claude Code's and Codex's do. */
  private async applyPermissionMode(): Promise<void> {
    // The main agent asks for everything beyond its tools (and is refused): its policy never decides alone.
    const mode = this.permModes?.[this.bridge ? 'ask' : (this.args.permissionMode ?? 'auto')];
    if (!mode || !this.conn || !this.sessionId) return;
    await this.conn.rpc('session/set_mode', { sessionId: this.sessionId, modeId: mode });
  }

  private readModels(result: Rec, atStart = false): void {
    const m = modelsOf(result);
    if (!m) return;
    const before = this.model?.current;
    this.model = m;
    if (atStart && this.defaultModel === undefined) this.defaultModel = m.current;
    const list = m.list.map((o) => ({ ...o, isDefault: o.id === this.defaultModel }));
    this.adapter.models.set(this.args.host ?? '', list);
    if (m.current && m.current !== before) this.emit({ type: 'model', model: m.current });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.args.permissionMode = mode;
    await this.applyPermissionMode();
  }

  /** At once (the next prompt runs on it); unset: the model the session started on. */
  async setModel(model: string | undefined): Promise<void> {
    this.args.model = model;
    if (!this.conn || this.conn.closed || !this.sessionId) return;
    if (!this.model) throw new Error(`${this.label} does not offer a model choice.`);
    const target = model ?? this.defaultModel;
    if (!target || target === this.model.current) return;
    if (this.model.kind === 'config') {
      const r = rec(await this.conn.rpc('session/set_config_option', { sessionId: this.sessionId, configId: this.model.configId, value: target }));
      if (Array.isArray(r.configOptions)) this.readModels(r);
      else this.setCurrentModel(target);
    } else {
      await this.conn.rpc('session/set_model', { sessionId: this.sessionId, modelId: target });
      this.setCurrentModel(target);
    }
  }

  private setCurrentModel(id: string): void {
    if (!this.model || this.model.current === id) return;
    this.model = { ...this.model, current: id };
    this.emit({ type: 'model', model: id });
  }

  // ---------------------------------------------------------------- turns

  private async promptBlocks(text: string, images: ImageInput[]): Promise<Rec[]> {
    const blocks: Rec[] = [];
    const acceptsImages = rec(this.agentCaps.promptCapabilities).image === true;
    let body = text;
    if (images.length && !acceptsImages) body = `${body}\n\n(${images.length} image${images.length === 1 ? '' : 's'} left out: ${this.label} does not accept images.)`;
    if (body.trim() || !images.length || !acceptsImages) blocks.push({ type: 'text', text: body });
    if (acceptsImages) for (const img of images) blocks.push({ type: 'image', mimeType: img.mediaType, data: (await readFile(img.path)).toString('base64') });
    // @-mentioned files (as the message box writes them) also go as resource links, every ACP agent's baseline: the agent knows which files are meant.
    if (!this.args.host) for (const path of mentionedFiles(text, this.args.cwd)) blocks.push({ type: 'resource_link', uri: pathToFileURL(path).href, name: relative(this.args.cwd, path) || path });
    return blocks;
  }

  async send(text: string, opts?: { interrupt?: boolean; images?: ImageInput[] }): Promise<Delivery> {
    if (!this.conn || this.conn.closed || !this.sessionId) throw new Error(`${this.label} session is not connected.`);
    const blocks = await this.promptBlocks(text, opts?.images ?? []);
    if (this.working && opts?.interrupt) {
      await this.waitForIdle(() => this.cancel());
      this.startTurn([...this.queue.splice(0).flat(), ...blocks]);
      return 'interrupt';
    }
    if (this.working) {
      // ACP has no steering: kept, and sent as the next prompt the moment this turn ends.
      this.queue.push(blocks);
      return 'steer';
    }
    this.startTurn(blocks);
    return 'turn';
  }

  private startTurn(blocks: Rec[]): void {
    const conn = this.conn;
    if (!conn || conn.closed || !this.sessionId) return;
    this.working = true;
    this.interruptRequested = false;
    this.lastAgentText = '';
    this.emit({ type: 'turnStarted' });
    const said = blocks.filter((b) => b.type === 'text').map((b) => str(b.text)).join('\n').trim();
    if (said) this.said.push({ role: 'user', text: said });
    const prompt = this.instructionsDue ? [{ type: 'text', text: `<system-reminder>\n${this.instructionsDue}\n</system-reminder>` }, ...blocks] : blocks;
    this.instructionsDue = undefined;
    conn.rpc('session/prompt', { sessionId: this.sessionId, prompt }, 0).then(
      (r) => this.finishTurn(rec(r)),
      (error: unknown) => this.finishTurn(undefined, error),
    );
  }

  private finishTurn(result: Rec | undefined, error?: unknown): void {
    if (!this.working) return;
    this.flush();
    for (const id of this.requests.keys()) this.emit({ type: 'requestResolved', requestId: id, reason: 'turn ended' });
    this.requests.clear();
    this.working = false;
    if (error && this.conn?.closed) {
      // The process went: reported once, by exited().
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      return;
    }
    const stop = str(result?.stopReason);
    const usage = rec(result?.usage);
    const n = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
    if (Object.keys(usage).length)
      this.emit({ type: 'usage', add: { input: n('inputTokens'), output: n('outputTokens'), cacheRead: n('cachedReadTokens'), cacheWrite: n('cachedWriteTokens'), reasoning: n('thoughtTokens') } });
    if (error) {
      const message = this.errorText(error);
      this.emit({ type: 'turnCompleted', status: 'failed', finalText: this.lastAgentText, error: message, transient: transientKind(message) });
    } else if (stop === 'cancelled' || this.interruptRequested) this.emit({ type: 'turnCompleted', status: 'interrupted', finalText: this.lastAgentText });
    else if (stop === 'refusal') this.emit({ type: 'turnCompleted', status: 'failed', finalText: this.lastAgentText, error: `${this.label} refused to continue.` });
    else {
      if (stop === 'max_tokens' || stop === 'max_turn_requests') this.emit({ type: 'progress', text: `${this.label} stopped: ${stop === 'max_tokens' ? 'token limit reached' : 'step limit reached'}.` });
      this.emit({ type: 'turnCompleted', status: 'completed', finalText: this.lastAgentText });
    }
    this.refreshLimits();
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    // Messages sent while it worked go next.
    if (this.queue.length && !this.closed) this.startTurn(this.queue.splice(0).flat());
  }

  /** The account's limits, for a CLI that prints them: after the start and after turns (at most once a minute per machine). */
  private refreshLimits(): void {
    if (!this.adapter.spec.limits || this.historyOnly) return;
    void this.adapter.limits.read(this.args.host).then((l) => {
      if (l && !this.closed) this.emit({ type: 'limits', windows: l.windows, ...(this.plan ? { plan: this.plan } : {}) });
    });
  }

  private waitForIdle(stop?: () => void): Promise<void> {
    if (!this.working) return Promise.resolve();
    const done = new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    stop?.();
    return Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 15_000))]);
  }

  /** session/cancel; open permission requests are answered "cancelled", as ACP requires. */
  private cancel(): void {
    if (!this.conn || this.conn.closed || !this.sessionId || !this.working) return;
    this.interruptRequested = true;
    for (const [id, r] of this.requests) {
      try {
        this.conn.reply(r.rpcId, { outcome: { outcome: 'cancelled' } });
      } catch {
        /* gone */
      }
      this.emit({ type: 'requestResolved', requestId: id, reason: 'cancelled' });
    }
    this.requests.clear();
    this.conn.notify('session/cancel', { sessionId: this.sessionId });
  }

  async interrupt(): Promise<void> {
    this.queue = [];
    this.cancel();
  }

  async respond(requestId: string, response: ApprovalResponse): Promise<void> {
    const r = this.requests.get(requestId);
    if (!r || !this.conn) throw new Error(`This ${this.label} request is no longer pending.`);
    if (r.form) {
      const answers = response.answers;
      const content: Rec = {};
      for (const f of r.form) {
        const given = answers?.[f.name];
        if (given === undefined) continue;
        const v = f.multi ? given.split(/\s*,\s*/).map((x) => f.labels?.[x] ?? x).join(',') : (f.labels?.[given] ?? given);
        if (f.other && f.values && !f.multi && !f.values.includes(v)) content[f.other] = v;
        else content[f.name] = f.type === 'boolean' ? /^(true|yes)$/i.test(v) : f.type === 'number' || f.type === 'integer' ? Number(v) : f.multi ? v.split(',').filter(Boolean) : v;
      }
      this.conn.reply(r.rpcId, answers ? { action: 'accept', content } : { action: 'decline' });
      this.requests.delete(requestId);
      this.emit({ type: 'requestResolved', requestId, reason: answers ? 'answered' : 'declined' });
      return;
    }
    const chosen = r.options.find((o) => o.optionId === response.decision);
    // Anything but an offered option is a refusal (the agent's own reject option, else "cancelled").
    const reject = r.options.find((o) => o.kind === 'reject_once') ?? r.options.find((o) => o.kind.startsWith('reject'));
    const pick = chosen ?? reject;
    this.conn.reply(r.rpcId, { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } });
    this.requests.delete(requestId);
    if ((!pick || pick.kind.startsWith('reject')) && r.toolCallId) this.declined.add(r.toolCallId);
    this.emit({ type: 'requestResolved', requestId, reason: response.decision ?? 'answered' });
  }

  /**
   * A side question: answered in a session of its own, so the conversation (and a turn under way) is
   * untouched. With session/fork (OpenCode) that session is a copy of this one, deleted afterwards;
   * else a new session given the conversation as text. Either way it may not use tools that change
   * anything (refused), and its answer goes nowhere else.
   */
  async askSide(question: string, history: Array<{ question: string; response: string }>): Promise<string> {
    const conn = this.conn;
    if (!conn || conn.closed || !this.sessionId) throw new Error(`${this.label} session is not connected.`);
    const caps = rec(this.agentCaps.sessionCapabilities);
    const earlier = history.slice(-10).map((h) => `Earlier side question: ${h.question}\nYour answer: ${h.response}`).join('\n\n');
    const ask = `${SIDE_NOTE}\n\n${earlier ? `${earlier}\n\n` : ''}${question}`;
    let sideId: string;
    let text: string;
    if (caps.fork) {
      sideId = str(rec(await conn.rpc('session/fork', { sessionId: this.sessionId, cwd: this.args.cwd, mcpServers: [] })).sessionId);
      text = ask;
    } else {
      // Not in the agent's folder (nothing to change there, and kept out of its list of sessions there).
      sideId = str(rec(await conn.rpc('session/new', { cwd: this.adapter.scratchDir(this.args.host), mcpServers: [] })).sessionId);
      text = conversationCopy(this.said, ask);
    }
    if (!sideId) throw new Error(`${this.label} did not open a session for the side question.`);
    const side: { text: string; done?: (error?: Error) => void } = { text: '' };
    this.sides.set(sideId, side);
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${this.label} did not answer the side question in time.`)), 180_000);
        conn.rpc('session/prompt', { sessionId: sideId, prompt: [{ type: 'text', text }] }, 0).then(
          (r) => {
            clearTimeout(timer);
            const stop = str(rec(r).stopReason);
            if (stop === 'refusal') reject(new Error(`${this.label} refused to answer.`));
            else resolve(side.text.trim() || '(no answer)');
          },
          (e: unknown) => {
            clearTimeout(timer);
            reject(new Error(this.errorText(e)));
          },
        );
      });
      return answer;
    } finally {
      this.sides.delete(sideId);
      // Gone again where the CLI can delete sessions; else at least closed.
      if (!conn.closed) {
        if (caps.delete) await conn.rpc('session/delete', { sessionId: sideId }, 15_000).catch(() => undefined);
        else if (caps.close) await conn.rpc('session/close', { sessionId: sideId }, 15_000).catch(() => undefined);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.conn?.kill();
    this.bridge?.close();
  }

  // ---------------------------------------------------------------- the agent's requests

  private request(rpcId: string | number, method: string, p: Rec): void {
    if (method === 'elicitation/create') return this.elicit(rpcId, p);
    if (method !== 'session/request_permission') {
      // No file system or terminal was offered; anything else is refused, never silently allowed.
      this.conn?.replyError(rpcId, -32601, `Agent Workspace does not support ${method}.`);
      return;
    }
    if (this.sides.has(str(p.sessionId))) {
      // A side question only answers: nothing it would change is allowed.
      const reject = arr(p.options).map(rec).find((o) => str(o.kind).startsWith('reject'));
      return void this.conn?.reply(rpcId, { outcome: reject ? { outcome: 'selected', optionId: str(reject.optionId) } : { outcome: 'cancelled' } });
    }
    if (str(p.sessionId) !== this.sessionId) return void this.conn?.reply(rpcId, { outcome: { outcome: 'cancelled' } });
    const options = arr(p.options)
      .map(rec)
      .map((o) => ({ optionId: str(o.optionId), name: str(o.name), kind: str(o.kind) }))
      .filter((o) => o.optionId);
    const u = rec(p.toolCall);
    const toolCallId = str(u.toolCallId) || undefined;
    const tool = toolCallId ? this.toolUpdate(u) : mergeAcpTool(undefined, u);
    if (!this.working) return void this.conn?.reply(rpcId, { outcome: { outcome: 'cancelled' } });
    const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always');
    if (this.bridge) {
      // Main agent: its workspace tools and looking around, nothing else; never put to the user.
      const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind.startsWith('reject'));
      const ok = allow && this.mainAgentAllowed(tool);
      if (!ok && toolCallId) this.declined.add(toolCallId);
      return void this.conn?.reply(rpcId, { outcome: ok ? { outcome: 'selected', optionId: allow.optionId } : reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } });
    }
    if (allow && this.autoAllowed(tool)) return void this.conn?.reply(rpcId, { outcome: { outcome: 'selected', optionId: allow.optionId } });
    const requestId = `acp-${String(rpcId)}-${toolCallId ?? randomUUID().slice(0, 6)}`;
    this.requests.set(requestId, { rpcId, options, toolCallId });
    const info = acpToolInfo(tool, this.args.cwd);
    this.emit({
      type: 'approvalRequested',
      requestId,
      headline: acpApprovalHeadline(tool, this.args.cwd),
      details: '',
      options: options.map((o) => ({ id: o.optionId, label: o.name || o.optionId, kind: PERMISSION_KINDS.find((k) => k === o.kind) })),
      highRisk: tool.kind === 'delete',
      toolCallId,
      preview: info.content.filter((c) => c.type === 'diff' || c.type === 'terminal'),
    });
  }

  /** A form to fill in: put to the user as questions (refused for side questions, the main agent, and anything but forms). */
  private elicit(rpcId: string | number, p: Rec): void {
    const sid = str(p.sessionId);
    const { questions, fields } = formQuestions(rec(p.requestedSchema));
    if (p.mode !== 'form' || (sid && sid !== this.sessionId) || this.bridge || !this.working || !questions.length) return void this.conn?.reply(rpcId, { action: 'decline' });
    const requestId = `acp-form-${String(rpcId)}`;
    this.requests.set(requestId, { rpcId, options: [], form: fields });
    this.emit({ type: 'userInputRequested', requestId, headline: str(p.message) || `${this.label} has a question`, questions, toolCallId: str(p.toolCallId) || undefined });
  }

  /** The main agent's own tools (by name, as the CLI prefixes them) and read-only kinds. */
  private mainAgentAllowed(tool: AcpTool): boolean {
    if (tool.kind === 'read' || tool.kind === 'search' || tool.kind === 'think') return true;
    if (tool.kind === 'edit' || tool.kind === 'delete' || tool.kind === 'move' || tool.kind === 'execute') return false;
    return [tool.name, tool.title].some((n) => !!n && this.bridge!.owns(n));
  }

  /**
   * Decided here, without asking, when the agent has no permission modes of its own (OpenCode): what
   * only looks (read, search, think) always; edits inside the agent's folder unless the mode is `ask`;
   * in `auto`, plain read-only commands too. Other commands, deletions, moves or anything else: the user.
   */
  private autoAllowed(tool: AcpTool): boolean {
    if (this.permModes) return false; // the agent's own mode already decided; it asks only what it will not do
    if (tool.kind === 'read' || tool.kind === 'search' || tool.kind === 'think') return true;
    const mode = this.args.permissionMode ?? 'auto';
    // Decide automatically: commands that only look run (as Codex's and Claude Code's auto modes let them).
    if (tool.kind === 'execute') return mode === 'auto' && readOnlyCommand(commandOf(tool));
    if (tool.kind !== 'edit' || mode === 'ask') return false;
    const paths = [...arr(tool.content).map(rec).filter((c) => c.type === 'diff').map((c) => str(c.path)), ...arr(tool.locations).map((l) => str(rec(l).path))].filter(Boolean);
    return paths.length > 0 && paths.every((path) => inside(path, this.args.cwd));
  }

  // ---------------------------------------------------------------- session/update

  private update(p: Rec): void {
    const side = this.sides.get(str(p.sessionId));
    if (side) {
      const u = rec(p.update);
      if (u.sessionUpdate === 'agent_message_chunk') side.text += acpBlockText(u.content);
      return;
    }
    if (this.sessionId && str(p.sessionId) && str(p.sessionId) !== this.sessionId) return;
    const u = rec(p.update);
    switch (str(u.sessionUpdate)) {
      case 'agent_message_chunk':
        return this.chunk('assistant', u);
      case 'agent_thought_chunk':
        return this.chunk('thought', u);
      case 'user_message_chunk':
        // Live, the user's message is already shown; in a replay it is history.
        if (this.replaying) this.chunk('user', u);
        return;
      case 'tool_call':
      case 'tool_call_update': {
        const known = this.tools.has(str(u.toolCallId));
        const tool = this.toolUpdate(u);
        if (!known && !this.replaying && tool.title) this.emit({ type: 'progress', text: tool.title });
        return;
      }
      case 'plan': {
        if (this.replaying) return;
        const entries = acpPlan(u.entries);
        this.emit({ type: 'planUpdated', entries });
        const active = entries.find((e) => e.status === 'in_progress');
        if (active) this.emit({ type: 'progress', text: active.content });
        return;
      }
      case 'plan_removed':
        if (!this.replaying) this.emit({ type: 'planUpdated', entries: [] });
        return;
      case 'usage_update': {
        if (this.replaying) return;
        const cost = rec(u.cost);
        const amount = str(cost.currency).toUpperCase() === 'USD' && typeof cost.amount === 'number' ? cost.amount : undefined;
        // The cost is the session's total so far: added as the difference.
        const add = amount !== undefined && this.lastCost !== undefined && amount > this.lastCost ? { costUsd: amount - this.lastCost } : undefined;
        if (amount !== undefined) this.lastCost = amount;
        this.emit({ type: 'usage', ...(add ? { add } : {}), ...(typeof u.used === 'number' ? { context: u.used } : {}), ...(typeof u.size === 'number' && u.size > 0 ? { contextWindow: u.size } : {}) });
        return;
      }
      case 'config_option_update':
        this.readModels(u);
        return;
      default:
        // current_mode_update, available_commands_update, session_info_update and future kinds: nothing to show.
        return;
    }
  }

  private chunk(role: 'assistant' | 'thought' | 'user', u: Rec): void {
    const block = rec(u.content);
    // The resource links sent with @-mentions: the message already names those files.
    if (role === 'user' && block.type === 'resource_link') return;
    // An image in a replayed user message: shown with it, as Claude Code's and Codex's are.
    const image = role === 'user' && block.type === 'image' && str(block.data) ? { data: str(block.data), mediaType: str(block.mimeType) || undefined } : undefined;
    const text = image ? '' : acpBlockText(u.content);
    if (!text && !image) return;
    const messageId = str(u.messageId) || undefined;
    if (this.seg && (this.seg.role !== role || (messageId && this.seg.messageId && messageId !== this.seg.messageId))) this.flush();
    if (this.replaying && role === 'user') this.skipAck = false;
    else if (this.replaying && this.skipAck) return;
    if (!this.seg) this.seg = { role, id: `${role}-${messageId ?? randomUUID().slice(0, 12)}`, text: '', messageId };
    this.seg.text += text;
    if (image) (this.seg.images ??= []).push(image);
    if (!this.replaying && role !== 'user') this.emit({ type: 'outputDelta', itemId: this.seg.id, role, delta: text });
  }

  /** The message being streamed is complete (something else came, or the turn ended): its full text. */
  private flush(): void {
    const s = this.seg;
    if (!s) return;
    this.seg = undefined;
    const copy = s.role === 'user' ? parseCopy(s.text) : undefined;
    if (copy) {
      // A conversation copied in (a fork or a side question without session/fork): shown as the conversation it was.
      copy.lines.forEach((l, i) => {
        if (l.role === 'tool') return;
        this.said.push(l);
        if (this.replaying) this.emit({ type: 'transcriptItem', itemId: `${s.id}-copy-${i}`, role: l.role, text: l.text, history: true });
      });
      if (copy.rest) {
        if (this.replaying) this.prompts.push({ messageId: s.messageId, text: copy.rest, index: this.said.length });
        this.said.push({ role: 'user', text: copy.rest });
        if (this.replaying) this.emit({ type: 'transcriptItem', itemId: s.id, role: 'user', text: copy.rest, history: true });
      } else this.skipAck = this.replaying;
      return;
    }
    const text = s.role === 'user' ? cleanUserText(s.text) : s.text;
    if (this.replaying && s.role === 'user' && text.trim()) this.prompts.push({ messageId: s.messageId, text, index: this.said.length });
    if (this.replaying && s.role !== 'thought' && text.trim()) this.said.push({ role: s.role, text });
    else if (!this.replaying && s.role === 'assistant' && text.trim()) this.said.push({ role: 'assistant', text });
    if (this.replaying && !text.trim() && !s.images?.length) return;
    this.emit({ type: 'transcriptItem', itemId: s.id, role: s.role, text, history: this.replaying || undefined, ...(s.images?.length ? { images: s.images } : {}) });
    if (s.role === 'assistant' && !this.replaying) this.lastAgentText = text;
  }

  private toolUpdate(u: Rec): AcpTool {
    this.flush();
    const id = str(u.toolCallId);
    const known = this.tools.get(id);
    const tool = mergeAcpTool(known, u);
    if (!known && tool.title) this.said.push({ role: 'tool', text: tool.title });
    this.tools.set(id, tool);
    this.emitTool(tool);
    return tool;
  }

  private emitTool(tool: AcpTool, status = acpToolStatus(tool.status)): void {
    const toolStatus = this.declined.has(tool.id) && status === 'failed' ? 'declined' : status;
    this.emit({ type: 'transcriptItem', itemId: tool.id, role: 'tool', text: '', toolStatus, tool: acpToolInfo(tool, this.args.cwd), history: this.replaying || undefined });
  }

  /** The replay is over: tool calls it left open were cut short back then. */
  private endReplay(): void {
    this.flush();
    for (const tool of this.tools.values()) if (tool.status === 'pending' || tool.status === 'in_progress') this.emitTool(tool, 'interrupted');
    this.replaying = false;
    this.tools.clear();
  }
}
