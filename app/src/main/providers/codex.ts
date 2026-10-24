import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AttentionQuestion, NativeSessionInfo, ProviderCapabilities } from '../../shared/types';
import { childEnv, findExecutable, run } from '../util/exec';
import type { ApprovalResponse, ProviderAdapter, ProviderEvent, ProviderSession, StartArgs } from './types';

// Codex integration through the official `codex app-server` JSON-RPC protocol over
// stdio, using the user's installed CLI and its existing login. Approvals and
// questions are answered by replying to the server's own request id.
// Protocol handling informed by Parallel Code (MIT, electron/ipc/codex-chat.ts) and
// checked against `codex app-server generate-ts` output for codex-cli 0.162.

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const CLIENT_INFO = { name: 'agent_meeting_workspace', title: 'Agent Meeting Workspace', version: '0.1.0' };

/** Minimal JSON-RPC (newline-delimited) client for one app-server process. */
class AppServer {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;
  onNotification: (method: string, params: Rec) => void = () => {};
  onRequest: (id: string | number, method: string, params: Rec) => void = () => {};
  onExit: (reason: string) => void = () => {};

  constructor(private proc: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let msg: Rec;
      try {
        msg = rec(JSON.parse(line));
      } catch {
        return;
      }
      this.receive(msg);
    });
    // stderr can contain private diagnostics or tokens; drain it, never forward it.
    proc.stderr.resume();
    proc.on('exit', (code, signal) => this.shutdown(`Codex app-server exited (${signal ?? code}).`));
    proc.on('error', (err) => this.shutdown(err.message));
    proc.stdin.on('error', (err) => this.shutdown(err.message));
  }

  static spawn(cwd: string): AppServer {
    const exe = findExecutable('codex');
    if (!exe) throw new Error('Codex CLI not found on PATH.');
    const proc = spawn(exe, ['app-server'], { cwd, env: childEnv(), stdio: 'pipe', detached: true });
    return new AppServer(proc);
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
  }

  rpc(method: string, params: Rec, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timed out during ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  reply(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  replyError(id: string | number, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }

  write(msg: unknown): void {
    if (this.closed) throw new Error('Codex app-server is not running.');
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  kill(): void {
    const pid = this.proc.pid;
    try {
      if (pid) process.kill(-pid, 'SIGTERM'); // own process group: includes commands it launched
    } catch {
      /* already gone */
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
    if (!method && typeof id === 'number') {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(str(rec(msg.error).message) || 'Codex request failed.'));
      else p.resolve(msg.result);
      return;
    }
    if (method && (typeof id === 'string' || typeof id === 'number')) this.onRequest(id, method, rec(msg.params));
    else if (method) this.onNotification(method, rec(msg.params));
  }
}

function itemEvents(value: unknown, history: boolean, completed: boolean): ProviderEvent[] {
  const item = rec(value);
  const id = str(item.id);
  if (!id) return [];
  const type = str(item.type);
  if (type === 'agentMessage') {
    const text = str(item.text);
    return text ? [{ type: 'transcriptItem', itemId: id, role: 'assistant', text, history }] : [];
  }
  if (type === 'userMessage') {
    if (!history) return []; // the workspace already shows what the user sent
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.map((c) => str(rec(c).text)).filter(Boolean).join('\n');
    return text ? [{ type: 'transcriptItem', itemId: id, role: 'user', text, history }] : [];
  }
  const status = str(item.status);
  const toolStatus =
    status === 'declined'
      ? 'declined'
      : status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
        ? 'failed'
        : status === 'inProgress' || !completed
          ? 'running'
          : 'completed';
  if (type === 'commandExecution') {
    return [
      {
        type: 'transcriptItem',
        itemId: id,
        role: 'tool',
        text: str(item.aggregatedOutput).slice(-4000),
        toolLabel: `$ ${str(item.command)}`,
        toolStatus: history && toolStatus === 'running' ? 'interrupted' : toolStatus,
        history,
      },
    ];
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.map((c) => str(rec(c).path)).filter(Boolean);
    return [
      {
        type: 'transcriptItem',
        itemId: id,
        role: 'tool',
        text: changes.map((c) => str(rec(c).diff)).join('\n').slice(0, 4000),
        toolLabel: `Edit ${paths.length === 1 ? paths[0] : `${paths.length} files`}`,
        toolStatus: history && toolStatus === 'running' ? 'interrupted' : toolStatus,
        history,
      },
    ];
  }
  if (type === 'mcpToolCall') {
    return [
      {
        type: 'transcriptItem',
        itemId: id,
        role: 'tool',
        text: str(rec(item.error).message),
        toolLabel: `${str(item.server)} / ${str(item.tool)}`,
        toolStatus,
        history,
      },
    ];
  }
  return [];
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const;

  async capabilities(): Promise<ProviderCapabilities> {
    const path = findExecutable('codex');
    let version: string | undefined;
    if (path) version = (await run(path, ['--version'], { timeoutMs: 15_000 })).stdout.trim() || undefined;
    return {
      provider: 'codex',
      available: !!path,
      version,
      detail: path
        ? `codex app-server (stdio) → ${path}. Uses your existing Codex login.`
        : 'Codex CLI not found on PATH.',
      createSession: !!path,
      resumeHistorical: !!path,
      importHistory: !!path,
      attachExternalRunning: false,
      readOnlyMonitor: false,
      structuredApprovals: true,
      structuredQuestions: true,
    };
  }

  async discoverSessions(filter: { cwd: string }): Promise<NativeSessionInfo[]> {
    const server = AppServer.spawn(filter.cwd);
    try {
      await server.initialize();
      const result = rec(await server.rpc('thread/list', { cwd: filter.cwd, limit: 50 }));
      return (Array.isArray(result.data) ? result.data : []).map((t) => {
        const thread = rec(t);
        const updated = typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined;
        return {
          provider: 'codex' as const,
          nativeSessionId: str(thread.id),
          cwd: str(thread.cwd) || filter.cwd,
          title: str(thread.name) || str(thread.preview) || str(thread.id),
          updatedAt: updated ? new Date(updated * 1000).toISOString() : undefined,
        };
      });
    } finally {
      server.kill();
    }
  }

  createSession(args: StartArgs, onEvent: (event: ProviderEvent) => void): ProviderSession {
    return new CodexSession(args, onEvent);
  }
}

class CodexSession implements ProviderSession {
  readonly provider = 'codex' as const;
  private server?: AppServer;
  private threadId?: string;
  private turnId?: string;
  private working = false;
  private interruptRequested = false;
  private lastAgentText = '';
  /** Our string request id -> the server's original JSON-RPC id and request kind. */
  private requests = new Map<string, { rpcId: string | number; method: string; questionIds?: string[] }>();

  constructor(
    private args: StartArgs,
    private emit: (event: ProviderEvent) => void,
  ) {}

  nativeSessionId(): string | undefined {
    return this.threadId;
  }

  async start(): Promise<void> {
    const server = AppServer.spawn(this.args.cwd);
    this.server = server;
    server.onNotification = (m, p) => this.notification(m, p);
    server.onRequest = (id, m, p) => this.request(id, m, p);
    server.onExit = (reason) => {
      for (const id of this.requests.keys()) this.emit({ type: 'requestResolved', requestId: id, reason: 'disconnected' });
      this.requests.clear();
      if (reason !== 'stopped') this.emit({ type: 'sessionDisconnected', reason });
    };
    await server.initialize();
    const resumeId = this.args.resumeNativeSessionId;
    // Explicit, conservative policy: ask before leaving the sandbox; never bypass.
    const policy = { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    const instructions = this.args.developerInstructions
      ? { developerInstructions: this.args.developerInstructions }
      : {};
    const result = rec(
      await server.rpc(
        resumeId ? 'thread/resume' : 'thread/start',
        resumeId
          ? { threadId: resumeId, cwd: this.args.cwd, ...policy, ...instructions }
          : { cwd: this.args.cwd, ...policy, ...instructions },
      ),
    );
    const thread = rec(result.thread);
    this.threadId = str(thread.id);
    if (!this.threadId) throw new Error('Codex did not return a thread id.');
    for (const turn of Array.isArray(thread.turns) ? thread.turns : [])
      for (const item of Array.isArray(rec(turn).items) ? (rec(turn).items as unknown[]) : [])
        for (const e of itemEvents(item, true, true)) this.emit(e);
    this.emit({ type: 'sessionStarted', nativeSessionId: this.threadId, resumed: !!resumeId });
  }

  async send(text: string): Promise<void> {
    if (!this.server || this.server.closed || !this.threadId) throw new Error('Codex session is not connected.');
    if (this.working) throw new Error('Codex is still working on the previous turn. Wait or interrupt first.');
    this.working = true;
    this.interruptRequested = false;
    this.lastAgentText = '';
    this.emit({ type: 'turnStarted' });
    try {
      const result = rec(
        await this.server.rpc('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text, text_elements: [] }],
        }),
      );
      this.turnId = str(rec(result.turn).id) || this.turnId;
    } catch (error) {
      this.working = false;
      throw error;
    }
  }

  async respond(requestId: string, response: ApprovalResponse): Promise<void> {
    const r = this.requests.get(requestId);
    if (!r || !this.server) throw new Error('This Codex request is no longer pending.');
    if (r.method === 'item/tool/requestUserInput') {
      const answers = Object.fromEntries(
        (r.questionIds ?? []).map((q) => [q, { answers: [response.answers?.[q] ?? ''] }]),
      );
      this.server.reply(r.rpcId, { answers });
    } else {
      const allowed = ['accept', 'acceptForSession', 'decline', 'cancel'];
      const decision = allowed.includes(response.decision ?? '') ? response.decision : 'decline';
      this.server.reply(r.rpcId, { decision });
    }
    this.requests.delete(requestId);
    this.emit({ type: 'requestResolved', requestId, reason: response.decision ?? 'answered' });
  }

  async interrupt(): Promise<void> {
    if (!this.server || !this.working || !this.turnId) return;
    this.interruptRequested = true;
    await this.server.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  async close(): Promise<void> {
    this.server?.kill();
  }

  private request(rpcId: string | number, method: string, p: Rec): void {
    const requestId = `codex-${String(rpcId)}-${str(p.itemId) || Date.now()}`;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const command = str(p.command);
      const isCommand = method === 'item/commandExecution/requestApproval';
      this.requests.set(requestId, { rpcId, method });
      this.emit({
        type: 'approvalRequested',
        requestId,
        headline: isCommand ? `Run command: ${command || '(command)'}` : 'Apply file changes',
        details: [
          str(p.reason),
          command && `$ ${command}`,
          str(p.cwd) && `cwd: ${str(p.cwd)}`,
          str(p.grantRoot) && `grant write root: ${str(p.grantRoot)}`,
          p.networkApprovalContext ? `network: ${JSON.stringify(p.networkApprovalContext)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        options: [
          { id: 'accept', label: 'Allow once' },
          { id: 'acceptForSession', label: 'Allow for this session' },
          { id: 'decline', label: 'Deny' },
        ],
      });
      return;
    }
    if (method === 'item/tool/requestUserInput') {
      const questions: AttentionQuestion[] = (Array.isArray(p.questions) ? p.questions : []).map((q) => {
        const r = rec(q);
        return {
          id: str(r.id),
          question: str(r.question),
          header: str(r.header) || undefined,
          isSecret: r.isSecret === true,
          options: (Array.isArray(r.options) ? r.options : []).map((o, i) => ({
            id: str(rec(o).label) || `o${i}`,
            label: str(rec(o).label),
            description: str(rec(o).description) || undefined,
          })),
        };
      });
      this.requests.set(requestId, { rpcId, method, questionIds: questions.map((q) => q.id) });
      this.emit({
        type: 'userInputRequested',
        requestId,
        headline: questions[0]?.question || 'Codex needs your input',
        questions,
      });
      return;
    }
    if (method === 'mcpServer/elicitation/request') {
      this.server?.reply(rpcId, { action: 'cancel', content: null, _meta: null });
      this.emit({ type: 'progress', text: `Cancelled an MCP elicitation from ${str(p.serverName) || 'an MCP server'} (not supported in this MVP).` });
      return;
    }
    // Never leave an unsupported request hanging, and never silently approve it.
    this.server?.replyError(rpcId, `Agent Meeting Workspace does not support ${method} yet.`);
    this.emit({ type: 'progress', text: `Codex requested an unsupported interaction (${method}); it was refused.` });
  }

  private notification(method: string, p: Rec): void {
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started':
        this.turnId = str(rec(p.turn).id) || this.turnId;
        return;
      case 'item/started':
      case 'item/completed': {
        const item = rec(p.item);
        if (item.type === 'agentMessage' && str(item.text)) this.lastAgentText = str(item.text);
        if (method === 'item/started' && item.type === 'commandExecution')
          this.emit({ type: 'progress', text: `$ ${str(item.command)}` });
        for (const e of itemEvents(item, false, method === 'item/completed')) this.emit(e);
        return;
      }
      case 'item/agentMessage/delta':
        this.emit({ type: 'outputDelta', itemId: str(p.itemId), role: 'assistant', delta: str(p.delta) });
        return;
      case 'item/commandExecution/outputDelta':
        this.emit({ type: 'outputDelta', itemId: str(p.itemId), role: 'tool', delta: str(p.delta) });
        return;
      case 'turn/plan/updated': {
        const plan = Array.isArray(p.plan) ? p.plan.map(rec) : [];
        const active = plan.find((s) => s.status === 'inProgress' || s.status === 'in_progress');
        const done = plan.filter((s) => s.status === 'completed').length;
        if (plan.length) this.emit({ type: 'progress', text: `Plan ${done}/${plan.length}${active ? `: ${str(active.step)}` : ''}` });
        return;
      }
      case 'serverRequest/resolved': {
        const rpcId = p.requestId;
        for (const [id, r] of this.requests)
          if (r.rpcId === rpcId) {
            this.requests.delete(id);
            this.emit({ type: 'requestResolved', requestId: id, reason: 'resolved by Codex' });
          }
        return;
      }
      case 'turn/completed': {
        const turn = rec(p.turn);
        const status = str(turn.status);
        this.working = false;
        this.turnId = undefined;
        for (const id of this.requests.keys()) this.emit({ type: 'requestResolved', requestId: id, reason: 'turn ended' });
        this.requests.clear();
        this.emit({
          type: 'turnCompleted',
          status: status === 'interrupted' || this.interruptRequested ? 'interrupted' : status === 'failed' ? 'failed' : 'completed',
          finalText: this.lastAgentText,
          error: str(rec(turn.error).message) || undefined,
        });
        return;
      }
      case 'error':
        this.emit({ type: 'progress', text: `Codex error: ${str(rec(p.error).message) || 'unknown error'}` });
        return;
      default:
        return;
    }
  }
}
