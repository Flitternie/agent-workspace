import { randomUUID } from 'node:crypto';
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AttentionQuestion, NativeSessionInfo, PermissionMode, ProviderCapabilities } from '../../shared/types';
import { childEnv, findExecutable, run } from '../util/exec';
import { ClaudePlanTracker, claudeToolCall, claudeToolResult } from './claude-content';
import { cleanUserText } from './user-text';
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

const CLAUDE_MODE: Record<PermissionMode, 'auto' | 'acceptEdits' | 'default'> = { auto: 'auto', edits: 'acceptEdits', ask: 'default' };

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const;

  async capabilities(): Promise<ProviderCapabilities> {
    const path = findExecutable('claude');
    let version: string | undefined;
    let auth: ProviderCapabilities['auth'];
    if (path) {
      version = (await run(path, ['--version'], { timeoutMs: 15_000 })).stdout.trim() || undefined;
      // Read-only; prints JSON. Only the login flag and method are kept (no email or org).
      const status = await run(path, ['auth', 'status'], { timeoutMs: 15_000 });
      try {
        const s = JSON.parse(status.stdout) as { loggedIn?: boolean; authMethod?: string };
        auth = { loggedIn: s.loggedIn === true, method: s.authMethod };
      } catch {
        auth = { loggedIn: status.code === 0 };
      }
    }
    return {
      provider: 'claude',
      auth,
      available: !!path,
      version,
      detail: path
        ? `Agent SDK → ${path}. Uses your existing Claude Code login and settings.`
        : 'Claude Code CLI not found on PATH.',
      createSession: !!path,
      resumeHistorical: !!path,
      importHistory: !!path,
      // Resume re-enters the persisted conversation; it never takes over a PTY
      // that another terminal is running.
      attachExternalRunning: false,
      readOnlyMonitor: false,
      structuredApprovals: true,
      structuredQuestions: true,
    };
  }

  async discoverSessions(filter: { cwd?: string; limit?: number }): Promise<NativeSessionInfo[]> {
    const sdk = await loadSdk();
    // Without `dir` the SDK lists sessions from every project on this machine.
    const sessions = await sdk.listSessions({ dir: filter.cwd, limit: filter.limit ?? 50 });
    return sessions.map((s) => ({
      provider: 'claude' as const,
      nativeSessionId: s.sessionId,
      cwd: s.cwd ?? filter.cwd ?? '',
      title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
      updatedAt: new Date(s.lastModified).toISOString(),
    }));
  }

  async readHistory(nativeSessionId: string, cwd: string): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    await new ClaudeSession({ cwd, title: '' }, (e) => events.push(e)).replayHistory(nativeSessionId);
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
    const history = await sdk.getSessionMessages(sessionId, { dir: this.args.cwd });
    for (const m of history) this.receive(m, true);
  }

  async start(): Promise<void> {
    const sdk = await loadSdk();
    const executable = findExecutable('claude');
    if (!executable) throw new Error('Claude Code CLI not found on PATH.');
    const resumeId = this.args.resumeNativeSessionId;
    let resume = false;
    if (resumeId) {
      const info = await sdk.getSessionInfo(resumeId, { dir: this.args.cwd });
      if (!info) throw new Error(`Claude session ${resumeId} was not found for ${this.args.cwd}.`);
      resume = true;
      await this.replayHistory(resumeId);
    }
    this.sessionId = resumeId ?? randomUUID();
    this.query = sdk.query({
      prompt: this.prompts(),
      options: {
        cwd: this.args.cwd,
        env: childEnv(),
        pathToClaudeCodeExecutable: executable,
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
