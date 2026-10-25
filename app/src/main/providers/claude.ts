import { randomUUID } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AttentionQuestion, NativeSessionInfo, PermissionMode, ProviderCapabilities } from '../../shared/types';
import { childEnv, findExecutable, run } from '../util/exec';
import { sshError, sshRun } from '../util/ssh';
import { checkRemoteStart, entrypointOf, isSubAgentEntrypoint, remoteSessionStore, remoteSpawn, scanRemoteSessions } from './claude-remote';
import { ClaudePlanTracker, claudeToolCall, claudeToolResult } from './claude-content';
import { cleanUserText } from './user-text';
import type { WorkspaceTool } from '../main-agent';
import type { ApprovalResponse, Delivery, ProviderAdapter, ProviderEvent, ProviderSession, StartArgs } from './types';

// Claude Code integration through the official Agent SDK, driving the user's own
// installed `claude` binary (its login, settings, CLAUDE.md and permission rules).
// Approach to permission/question relay informed by Parallel Code (MIT,
// https://github.com/johannesjo/parallel-code, electron/chat/claude.ts).

type SDK = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkPromise: Promise<SDK> | undefined;
const loadSdk = () => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'));

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function describeToolInput(tool: string, input: Record<string, unknown>): string {
  const command = str(input.command);
  if (command) return command;
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path);
  if (path) return path;
  const pattern = str(input.pattern) || str(input.query) || str(input.url);
  if (pattern) return pattern;
  const description = str(input.description) || str(input.prompt);
  if (description) return description.slice(0, 160);
  return tool;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => str(rec(b).text)).filter(Boolean).join('\n');
  return '';
}

/**
 * Main agent: the workspace tools as an in-process MCP server (they run in this
 * app), pre-approved; tools that change files or run commands are removed.
 */
function mainAgentOptions(sdk: Awaited<ReturnType<typeof loadSdk>>, tools: WorkspaceTool[]) {
  const server = sdk.createSdkMcpServer({
    name: 'workspace',
    version: '1.0.0',
    tools: tools.map((t) =>
      sdk.tool(t.name, t.description, t.schema.shape, async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: 'text' as const, text: await t.run(args) }] };
        } catch (error) {
          return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
        }
      }),
    ),
  });
  return {
    mcpServers: { workspace: server },
    allowedTools: [...tools.map((t) => `mcp__workspace__${t.name}`), 'Read', 'Grep', 'Glob'],
    disallowedTools: ['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'KillShell', 'BashOutput'],
  };
}

/** Entrypoints of saved sessions on this Mac, from the first lines of each transcript. */
async function localEntrypoints(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const wanted = new Set(ids);
  const dirs = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    dirs.map(async (dir) => {
      for (const name of await readdir(join(root, dir)).catch(() => [] as string[])) {
        const id = name.replace(/\.jsonl$/, '');
        if (name === id || !wanted.has(id)) continue;
        const file = await open(join(root, dir, name)).catch(() => undefined);
        if (!file) continue;
        try {
          const { buffer, bytesRead } = await file.read(Buffer.alloc(32 * 1024), 0, 32 * 1024, 0);
          const m = /"entrypoint":"([^"]+)"/.exec(buffer.toString('utf8', 0, bytesRead));
          if (m) out.set(id, m[1]);
        } finally {
          await file.close();
        }
      }
    }),
  );
  return out;
}

const CLAUDE_MODE: Record<PermissionMode, 'auto' | 'acceptEdits' | 'default'> = { auto: 'auto', edits: 'acceptEdits', ask: 'default' };

/** From `claude auth status` (JSON). Only the login flag and method are kept (no email or org). */
function authState(code: number, stdout: string): ProviderCapabilities['auth'] {
  try {
    const s = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
    return { loggedIn: s.loggedIn === true, method: s.authMethod };
  } catch {
    return { loggedIn: code === 0 };
  }
}

function describe(available: boolean, version: string | undefined, auth: ProviderCapabilities['auth'], detail: string): ProviderCapabilities {
  return {
    provider: 'claude',
    auth,
    available,
    version,
    detail,
    createSession: available,
    resumeHistorical: available,
    importHistory: available,
    // Resume re-enters the persisted conversation; it never takes over a PTY
    // that another terminal is running.
    attachExternalRunning: false,
    readOnlyMonitor: false,
    structuredApprovals: true,
    structuredQuestions: true,
  };
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const;
  readonly remote = true;

  async capabilities(): Promise<ProviderCapabilities> {
    const path = findExecutable('claude');
    let version: string | undefined;
    let auth: ProviderCapabilities['auth'];
    if (path) {
      version = (await run(path, ['--version'], { timeoutMs: 15_000 })).stdout.trim() || undefined;
      const status = await run(path, ['auth', 'status'], { timeoutMs: 15_000 });
      auth = authState(status.code, status.stdout);
    }
    return describe(!!path, version, auth, path ? `Agent SDK → ${path}. Uses your existing Claude Code login and settings.` : 'Claude Code CLI not found on PATH.');
  }

  async hostCapabilities(host: string): Promise<ProviderCapabilities> {
    const r = await sshRun(host, 'command -v claude >/dev/null || exit 127; claude --version; echo __AMW_STATUS__; claude auth status 2>/dev/null; echo "__AMW_CODE__$?"');
    if (r.code === 255) throw new Error(sshError(host, r.stderr));
    const found = r.code !== 127;
    const [version, status = ''] = r.stdout.split('__AMW_STATUS__');
    const code = Number(/__AMW_CODE__(\d+)/.exec(status)?.[1] ?? 1);
    return describe(found, version.trim() || undefined, found ? authState(code, status.replace(/__AMW_CODE__\d+/, '')) : undefined, found ? `Agent SDK → claude over SSH on ${host}, with the login and settings there.` : `Claude Code not found on ${host} (in its login shell's PATH).`);
  }

  async discoverSessions(filter: { cwd?: string; limit?: number; host?: string }): Promise<NativeSessionInfo[]> {
    if (filter.host) return this.discoverRemote(filter.host, filter.cwd, filter.limit ?? 50);
    const sdk = await loadSdk();
    // Without `dir` the SDK lists sessions from every project on this machine. Listed twice so
    // a burst of `claude -p` runs (often another agent's sub-agents) cannot crowd out the
    // interactive ones; the headless rest is sorted by entrypoint (app sessions stay visible).
    const limit = filter.limit ?? 50;
    const [interactive, all] = await Promise.all([
      sdk.listSessions({ dir: filter.cwd, limit, includeProgrammatic: false }),
      sdk.listSessions({ dir: filter.cwd, limit: limit * 3, includeProgrammatic: true }),
    ]);
    const mine = new Set(interactive.map((s) => s.sessionId));
    const headless = all.filter((s) => !mine.has(s.sessionId));
    const entrypoints = await localEntrypoints(headless.map((s) => s.sessionId));
    const counts = { shown: 0, sub: 0 };
    const rest = headless.filter((s) => {
      const k = isSubAgentEntrypoint(entrypoints.get(s.sessionId)) ? 'sub' : 'shown';
      return counts[k]++ < limit;
    });
    return [...interactive, ...rest].map((s) => ({
      provider: 'claude' as const,
      nativeSessionId: s.sessionId,
      cwd: s.cwd ?? filter.cwd ?? '',
      title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
      updatedAt: new Date(s.lastModified).toISOString(),
      ...(isSubAgentEntrypoint(entrypoints.get(s.sessionId)) ? { automated: true } : {}),
    }));
  }

  /** The host's newest transcripts, titled by the SDK from a few lines of each. */
  private async discoverRemote(host: string, cwd: string | undefined, limit: number): Promise<NativeSessionInfo[]> {
    const sdk = await loadSdk();
    // Sub-agent runs can far outnumber the user's own sessions, so look further back and keep up to `limit` of each.
    const scanned = await scanRemoteSessions(host, 300);
    const byId = new Map(scanned.map((s) => [s.sessionId, s]));
    const store = { append: async () => {}, load: async (k: { sessionId: string }) => byId.get(k.sessionId)?.entries ?? null };
    const out: NativeSessionInfo[] = [];
    const counts = { user: 0, automated: 0 };
    for (const s of scanned) {
      const automated = isSubAgentEntrypoint(entrypointOf(s.entries as Array<Record<string, unknown>>));
      if (counts[automated ? 'automated' : 'user'] >= limit) continue;
      const info = await sdk.getSessionInfo(s.sessionId, { dir: '/', sessionStore: store }).catch(() => undefined);
      const dir = info?.cwd;
      if (!dir || (cwd && dir !== cwd && !dir.startsWith(`${cwd}/`))) continue;
      counts[automated ? 'automated' : 'user']++;
      out.push({ provider: 'claude', nativeSessionId: s.sessionId, cwd: dir, host, title: info.customTitle || info.summary || info.firstPrompt || s.sessionId, updatedAt: new Date(s.mtime).toISOString(), ...(automated ? { automated } : {}) });
    }
    return out;
  }

  async readHistory(nativeSessionId: string, cwd: string, host?: string): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    await new ClaudeSession({ cwd, host, title: '' }, (e) => events.push(e)).replayHistory(nativeSessionId);
    return events;
  }

  createSession(args: StartArgs, onEvent: (event: ProviderEvent) => void): ProviderSession {
    return new ClaudeSession(args, onEvent);
  }
}

class ClaudeSession implements ProviderSession {
  readonly provider = 'claude' as const;
  private query?: Query;
  private sessionId?: string;
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  /** User turns sent but not yet answered by a result message. */
  /** A turn is running. Messages sent meanwhile are folded into it by Claude Code. */
  private active = false;
  private interruptRequested = false;
  private permissions = new Map<
    string,
    { input: Record<string, unknown>; suggestions?: PermissionUpdate[]; question: boolean; finish: (r: PermissionResult) => void }
  >();
  /** Open streamed text item and its accumulated text. */
  private stream?: { id: string; text: string };
  private lastAssistantText = '';
  /** tool_use id → call, to interpret its result. */
  private tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private plans = new ClaudePlanTracker();

  constructor(
    private args: StartArgs,
    private emit: (event: ProviderEvent) => void,
  ) {}

  nativeSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Emits the saved conversation as history items (read-only; no process is started). */
  async replayHistory(sessionId: string): Promise<void> {
    const sdk = await loadSdk();
    const history = await sdk.getSessionMessages(sessionId, { dir: this.args.cwd, ...this.store() });
    for (const m of history) this.receive(m, true);
  }

  /** On an SSH host, transcripts are read from there. */
  private store() {
    return this.args.host ? { sessionStore: remoteSessionStore(this.args.host) } : {};
  }

  async start(): Promise<void> {
    const sdk = await loadSdk();
    const host = this.args.host;
    // On a host the SDK only needs some path here; the host's own `claude` runs.
    const executable = findExecutable('claude') ?? (host ? process.execPath : null);
    if (!executable) throw new Error('Claude Code CLI not found on PATH.');
    if (host) await checkRemoteStart(host, this.args.cwd);
    const resumeId = this.args.resumeNativeSessionId;
    let resume = false;
    if (resumeId) {
      const info = await sdk.getSessionInfo(resumeId, { dir: this.args.cwd, ...this.store() });
      if (!info) throw new Error(`Claude session ${resumeId} was not found for ${this.args.cwd}${host ? ` on ${host}` : ''}.`);
      resume = true;
      await this.replayHistory(resumeId);
    }
    this.sessionId = resumeId ?? randomUUID();
    const env = childEnv();
    this.query = sdk.query({
      prompt: this.prompts(),
      options: {
        cwd: this.args.cwd,
        env,
        pathToClaudeCodeExecutable: executable,
        ...(host ? { spawnClaudeCodeProcess: remoteSpawn(host, this.args.cwd, env) } : {}),
        ...(resume ? { resume: this.sessionId } : { sessionId: this.sessionId }),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          ...(this.args.developerInstructions ? { append: this.args.developerInstructions } : {}),
        },
        // Load the user's own settings, CLAUDE.md and permission rules as the CLI would.
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        // Never bypass. 'auto' is Claude Code's own classifier (as in the CLI); whatever it
        // will not approve, and everything in 'default', reaches canUseTool → the tile.
        permissionMode: CLAUDE_MODE[this.args.permissionMode ?? 'auto'],
        canUseTool: this.canUseTool,
        ...(this.args.tools?.length ? mainAgentOptions(sdk, this.args.tools) : {}),
        stderr: () => {
          /* diagnostics may contain private tool arguments; never forwarded */
        },
      },
    });
    void this.read();
    this.emit({ type: 'sessionStarted', nativeSessionId: this.sessionId, resumed: resume });
  }

  private async *prompts(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }

  async send(text: string, opts?: { interrupt?: boolean }): Promise<Delivery> {
    if (this.closed || !this.query) throw new Error('Claude session is not connected.');
    let delivery: Delivery = 'turn';
    if (this.active && opts?.interrupt) {
      // Stop now; the message below then starts the next turn.
      this.interruptRequested = true;
      await this.query.interrupt();
      delivery = 'interrupt';
    } else if (this.active) {
      // Claude Code folds a queued message into the running turn at the next tool boundary.
      delivery = 'steer';
    } else {
      this.beginTurn();
    }
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.wake?.();
    return delivery;
  }

  private beginTurn(): void {
    if (this.active) return;
    this.active = true;
    this.interruptRequested = false;
    this.emit({ type: 'turnStarted' });
  }

  async respond(requestId: string, response: ApprovalResponse): Promise<void> {
    const p = this.permissions.get(requestId);
    if (!p) throw new Error('This Claude request is no longer pending.');
    if (p.question) {
      if (response.decision === 'deny') {
        p.finish({ behavior: 'deny', message: 'User declined to answer.' });
      } else {
        p.finish({ behavior: 'allow', updatedInput: { ...p.input, answers: response.answers ?? {} } });
      }
    } else if (response.decision === 'allow' || response.decision === 'allow_always') {
      const remember = response.decision === 'allow_always' && !!p.suggestions?.length;
      p.finish({
        behavior: 'allow',
        updatedInput: p.input,
        ...(remember ? { updatedPermissions: p.suggestions } : {}),
      });
    } else {
      p.finish({ behavior: 'deny', message: 'User denied this request in Agent Workspace.' });
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.args.permissionMode = mode;
    await this.query?.setPermissionMode(CLAUDE_MODE[mode]);
  }

  async interrupt(): Promise<void> {
    if (!this.query || !this.active) return;
    this.interruptRequested = true;
    await this.query.interrupt();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelPermissions('session closed');
    this.wake?.();
    this.query?.close();
  }

  private cancelPermissions(reason: string): void {
    for (const [id, p] of this.permissions) {
      p.finish({ behavior: 'deny', message: 'Request cancelled.' });
      this.emit({ type: 'requestResolved', requestId: id, reason });
    }
    this.permissions.clear();
  }

  private async read(): Promise<void> {
    try {
      for await (const message of this.query as Query) this.receive(message, false);
      if (!this.closed) this.emit({ type: 'sessionDisconnected', reason: 'Claude process ended.' });
    } catch (error) {
      if (!this.closed)
        this.emit({ type: 'sessionFailed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.cancelPermissions('disconnected');
      this.closed = true;
    }
  }

  private canUseTool: CanUseTool = async (tool, input, options) => {
    if (options.signal.aborted) return { behavior: 'deny', message: 'Request cancelled.' };
    const requestId = options.requestId || randomUUID();
    const isQuestion = tool === 'AskUserQuestion' && Array.isArray(input.questions);
    return new Promise<PermissionResult>((resolve) => {
      const finish = (result: PermissionResult) => {
        if (!this.permissions.has(requestId)) return;
        this.permissions.delete(requestId);
        options.signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => {
        finish({ behavior: 'deny', message: 'Request cancelled.' });
        this.emit({ type: 'requestResolved', requestId, reason: 'cancelled by Claude' });
      };
      const suggestions = options.suppressAlwaysAllowRule ? undefined : options.suggestions;
      this.permissions.set(requestId, { input, suggestions, question: isQuestion, finish });
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (isQuestion) {
        const questions: AttentionQuestion[] = (input.questions as unknown[]).map((q, i) => {
          const r = rec(q);
          return {
            // Claude's AskUserQuestion answers are keyed by question text.
            id: str(r.question) || `q${i}`,
            question: str(r.question),
            header: str(r.header) || undefined,
            multiSelect: r.multiSelect === true,
            allowOther: true,
            options: (Array.isArray(r.options) ? r.options : []).map((o, j) => ({
              id: str(rec(o).label) || `o${j}`,
              label: str(rec(o).label),
              description: str(rec(o).description) || undefined,
            })),
          };
        });
        this.emit({
          type: 'userInputRequested',
          requestId,
          headline: questions[0]?.question || 'Claude has a question',
          questions,
        });
      } else {
        const call = claudeToolCall(tool, input, this.args.cwd);
        // The permission ask can precede the tool_use message; label the tool row now.
        if (options.toolUseID) {
          this.tools.set(options.toolUseID, { name: tool, input });
          this.emit({ type: 'transcriptItem', itemId: options.toolUseID, role: 'tool', text: '', toolStatus: 'awaiting_approval', tool: call });
        }
        const plan = tool === 'ExitPlanMode';
        this.emit({
          type: 'approvalRequested',
          requestId,
          headline: plan ? 'Claude proposes a plan. Approve it to start coding?' : options.title || call.title,
          details: [options.description, options.decisionReason, options.blockedPath && `Outside the allowed paths: ${options.blockedPath}`, call.content.length ? '' : `${tool}\n${JSON.stringify(input, null, 2)}`]
            .filter(Boolean)
            .join('\n'),
          options: plan
            ? [
                { id: 'allow', label: 'Approve plan', kind: 'allow_once' },
                { id: 'deny', label: 'Keep planning', kind: 'reject_once' },
              ]
            : [
                { id: 'allow', label: 'Allow once', kind: 'allow_once' },
                ...(suggestions?.length ? [{ id: 'allow_always', label: 'Always allow (Claude rule)', kind: 'allow_always' as const }] : []),
                { id: 'deny', label: 'Deny', kind: 'reject_once' },
              ],
          highRisk: options.defaultToNo === true,
          toolCallId: options.toolUseID,
          preview: call.content,
        });
      }
    });
  };

  private receive(value: unknown, history: boolean): void {
    const m = rec(value);
    if (m.parent_tool_use_id) return; // subagent internals are summarized by the parent tool item
    const type = str(m.type);
    if (type === 'system' && m.subtype === 'init') {
      const id = str(m.session_id);
      if (id && id !== this.sessionId) {
        this.sessionId = id;
        this.emit({ type: 'sessionStarted', nativeSessionId: id, resumed: !!this.args.resumeNativeSessionId });
      }
      return;
    }
    // Output after a result means a queued message started a new turn.
    if ((type === 'stream_event' || type === 'assistant') && !history) this.beginTurn();
    if (type === 'stream_event') {
      const event = rec(m.event);
      if (event.type === 'content_block_start' && rec(event.content_block).type === 'text') {
        this.stream = { id: `stream-${randomUUID()}`, text: '' };
      } else if (event.type === 'content_block_delta' && rec(event.delta).type === 'text_delta' && this.stream) {
        const delta = str(rec(event.delta).text);
        this.stream.text += delta;
        this.emit({ type: 'outputDelta', itemId: this.stream.id, role: 'assistant', delta });
      }
      return;
    }
    if (type === 'assistant') {
      const content = rec(m.message).content;
      const blocks = Array.isArray(content) ? content : [];
      blocks.forEach((b, i) => {
        const block = rec(b);
        if (block.type === 'text') {
          const text = str(block.text);
          if (!text.trim()) return;
          let itemId = `${str(m.uuid)}:${i}`;
          if (this.stream && text.startsWith(this.stream.text)) {
            itemId = this.stream.id;
            this.stream = undefined;
          }
          this.lastAssistantText = text;
          this.emit({ type: 'transcriptItem', itemId, role: 'assistant', text, history });
        } else if (block.type === 'thinking') {
          const text = str(block.thinking);
          if (text.trim()) this.emit({ type: 'transcriptItem', itemId: `${str(m.uuid)}:${i}`, role: 'thought', text, history });
        } else if (block.type === 'tool_use') {
          const tool = str(block.name);
          if (tool === 'AskUserQuestion') return;
          const id = str(block.id);
          const input = rec(block.input);
          this.tools.set(id, { name: tool, input });
          const call = claudeToolCall(tool, input, this.args.cwd);
          // Don't downgrade a row that is already waiting on the user's approval.
          this.emit({ type: 'transcriptItem', itemId: id, role: 'tool', text: '', toolStatus: history ? 'completed' : undefined, tool: call, history });
          if (!history) this.emit({ type: 'progress', text: call.title });
          const plan = this.plans.onToolUse(id, tool, input);
          if (plan && !history) this.emit({ type: 'planUpdated', entries: plan });
        }
      });
      return;
    }
    if (type === 'user') {
      const content = rec(m.message).content;
      if (typeof content === 'string') {
        const text = history ? cleanUserText(content) : '';
        if (text) this.emit({ type: 'transcriptItem', itemId: str(m.uuid), role: 'user', text, history });
        return;
      }
      const blocks = Array.isArray(content) ? content : [];
      // Structured output belongs to the message; it is unambiguous only with one tool_result.
      const structured = blocks.filter((b) => rec(b).type === 'tool_result').length === 1 ? (m as { tool_use_result?: unknown }).tool_use_result : undefined;
      for (const b of blocks) {
        const block = rec(b);
        if (block.type === 'tool_result') {
          const id = str(block.tool_use_id);
          const text = toolResultText(block.content).slice(0, 4000);
          const isError = block.is_error === true;
          const denied = /denied|declined|cancelled|rejected/i.test(text) && isError;
          const call = this.tools.get(id);
          const result = call ? claudeToolResult(call.name, call.input, structured, text, isError, this.args.cwd) : undefined;
          this.emit({
            type: 'transcriptItem',
            itemId: id,
            role: 'tool',
            text,
            toolStatus: denied ? 'declined' : isError ? 'failed' : 'completed',
            tool: result && !denied ? { content: result } : undefined,
            history,
          });
          if (call) {
            const plan = this.plans.onToolResult(id, call.name, structured);
            if (plan && !history) this.emit({ type: 'planUpdated', entries: plan });
          }
        } else if (block.type === 'text' && history) {
          const text = cleanUserText(str(block.text));
          if (text) this.emit({ type: 'transcriptItem', itemId: `${str(m.uuid)}:t`, role: 'user', text, history });
        }
      }
      return;
    }
    if (type === 'result') {
      if (history) return;
      // One result per turn, however many messages were folded into it.
      this.active = false;
      const success = m.subtype === 'success' && m.is_error !== true;
      const status = this.interruptRequested ? 'interrupted' : success ? 'completed' : 'failed';
      this.interruptRequested = false;
      this.emit({
        type: 'turnCompleted',
        status,
        finalText: str(m.result) || this.lastAssistantText,
        error: success ? undefined : (Array.isArray(m.errors) ? m.errors.map(str).join('\n') : '') || str(m.subtype),
      });
      this.lastAssistantText = '';
    }
  }
}
