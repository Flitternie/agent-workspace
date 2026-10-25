import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { AttentionQuestion, NativeSessionInfo, PermissionMode, ProviderCapabilities } from '../../shared/types';
import { childEnv, findExecutable, needsShell, run } from '../util/exec';
import { shq, sshError, sshRun, sshSpawn } from '../util/ssh';
import { z } from 'zod';
import { codexFileDiffs, codexItem, codexPlan } from './codex-content';
import type { ApprovalResponse, Delivery, ProviderAdapter, ProviderEvent, ProviderSession, StartArgs } from './types';

// Codex integration through the official `codex app-server` JSON-RPC protocol over
// stdio, using the user's installed CLI and its existing login. Approvals and
// questions are answered by replying to the server's own request id. On an SSH host
// the same protocol runs over the SSH channel against the codex installed there, so
// its sessions (and the ChatGPT app's remote-project threads) stay on that machine.
// Protocol handling informed by Parallel Code (MIT, electron/ipc/codex-chat.ts) and
// checked against `codex app-server generate-ts` output for codex-cli 0.162.

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const CLIENT_INFO = { name: 'agent_workspace', title: 'Agent Workspace', version: '0.1.0' };

/** Minimal JSON-RPC (newline-delimited) client for one app-server process. */
class AppServer {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;
  onNotification: (method: string, params: Rec) => void = () => {};
  onRequest: (id: string | number, method: string, params: Rec) => void = () => {};
  onExit: (reason: string) => void = () => {};

  private stderrTail = '';

  constructor(
    private proc: ChildProcessWithoutNullStreams,
    private host?: string,
  ) {
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
    // stderr can contain private diagnostics or tokens; never forward it. Over SSH,
    // keep its last lines only to explain a failed connection (ssh's own messages).
    if (host) proc.stderr.on('data', (d: Buffer) => (this.stderrTail = (this.stderrTail + d.toString()).slice(-2000)));
    else proc.stderr.resume();
    proc.on('exit', (code, signal) =>
      this.shutdown(host && code === 255 ? sshError(host, this.stderrTail) : `Codex app-server${host ? ` on ${host}` : ''} exited (${signal ?? code}).`),
    );
    proc.on('error', (err) => this.shutdown(err.message));
    proc.stdin.on('error', (err) => this.shutdown(err.message));
  }

  static spawn(cwd: string, host?: string): AppServer {
    if (host) return new AppServer(sshSpawn(host, `cd ${cwd === '~' ? '' : shq(cwd)} 2>/dev/null; exec codex app-server`), host);
    const exe = findExecutable('codex');
    if (!exe) throw new Error('Codex CLI not found on PATH.');
    const proc = spawn(needsShell(exe) ? `"${exe}"` : exe, ['app-server'], { cwd, env: childEnv(), stdio: 'pipe', detached: process.platform !== 'win32', shell: needsShell(exe) });
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

function itemEvents(value: unknown, history: boolean, completed: boolean, cwd: string): ProviderEvent[] {
  const v = codexItem(value, { history, completed, cwd });
  if (!v) return [];
  return [{ type: 'transcriptItem', itemId: v.id, role: v.role, text: v.text, toolStatus: v.status, tool: v.tool, history }];
}

/** From `codex login status`; only the method is kept (e.g. "ChatGPT", "an API key"), never the key. */
function loginState(code: number, text: string): ProviderCapabilities['auth'] {
  const using = /Logged in using ([^-\n]+)/i.exec(text)?.[1]?.trim();
  return { loggedIn: code === 0 && !/not logged in/i.test(text), method: using };
}

/** Thread sources beyond the interactive default (see ThreadSourceKind). */
const OTHER_SOURCES = ['appServer', 'exec', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'];

/** Spawned by an agent inside another task: a Codex sub-agent thread, or a `codex exec` run. */
function isSubAgentThread(thread: Rec): boolean {
  const source = thread.source;
  return !!str(thread.parentThreadId) || source === 'exec' || (!!source && typeof source === 'object' && 'subagent' in source);
}

/** auto: Codex's auto_review approves or denies escalations; otherwise they come to the user. */
function codexPolicy(mode: PermissionMode): { approvalPolicy: string; approvalsReviewer: string } {
  if (mode === 'ask') return { approvalPolicy: 'untrusted', approvalsReviewer: 'user' };
  return { approvalPolicy: 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user' };
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const;
  readonly remote = true;

  async hostCapabilities(host: string): Promise<ProviderCapabilities> {
    const r = await sshRun(host, 'command -v codex >/dev/null || exit 127; codex --version; echo __AMW_STATUS__; codex login status 2>&1; echo "__AMW_CODE__$?"');
    if (r.code === 255) throw new Error(sshError(host, r.stderr));
    const found = r.code !== 127;
    const [version, status = ''] = r.stdout.split('__AMW_STATUS__');
    const code = Number(/__AMW_CODE__(\d+)/.exec(status)?.[1] ?? 1);
    return this.describe(found, version.trim() || undefined, found ? loginState(code, status) : undefined, found ? `codex app-server over SSH on ${host}, with the login there.` : `Codex CLI not found on ${host} (in its login shell's PATH).`);
  }

  private describe(available: boolean, version: string | undefined, auth: ProviderCapabilities['auth'], detail: string): ProviderCapabilities {
    return {
      provider: 'codex',
      auth,
      available,
      version,
      detail,
      createSession: available,
      resumeHistorical: available,
      importHistory: available,
      attachExternalRunning: false,
      readOnlyMonitor: false,
      structuredApprovals: true,
      structuredQuestions: true,
    };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    const path = findExecutable('codex');
    let version: string | undefined;
    let auth: ProviderCapabilities['auth'];
    if (path) {
      version = (await run(path, ['--version'], { timeoutMs: 15_000 })).stdout.trim() || undefined;
      // Read-only; exits 0 and prints e.g. "Logged in using ChatGPT" when signed in.
      const status = await run(path, ['login', 'status'], { timeoutMs: 15_000 });
      auth = loginState(status.code, `${status.stdout}\n${status.stderr}`);
    }
    return this.describe(!!path, version, auth, path ? `codex app-server (stdio) → ${path}. Uses your existing Codex login.` : 'Codex CLI not found on PATH.');
  }

  async discoverSessions(filter: { cwd?: string; limit?: number; host?: string }): Promise<NativeSessionInfo[]> {
    // Listing is read-only; without a cwd filter it covers every folder.
    const server = AppServer.spawn(filter.cwd ?? (filter.host ? '~' : homedir()), filter.host);
    try {
      await server.initialize();
      const list = async (sourceKinds?: string[]) =>
        rec(await server.rpc('thread/list', { ...(filter.cwd ? { cwd: filter.cwd } : {}), limit: filter.limit ?? 50, sortKey: 'updated_at', ...(sourceKinds ? { sourceKinds } : {}) })).data;
      // Without sourceKinds the server lists interactive threads only (CLI, IDE, the ChatGPT app);
      // app-server clients, `codex exec` and sub-agents come from a second, optional call.
      const arr = (v: unknown) => (Array.isArray(v) ? v : []);
      const interactive = arr(await list());
      const other = arr(await list(OTHER_SOURCES).catch(() => []));
      const seen = new Set<string>();
      return [...interactive, ...other].flatMap((t) => {
        const thread = rec(t);
        const id = str(thread.id);
        if (!id || seen.has(id)) return [];
        seen.add(id);
        const updated = typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined;
        const isAutomated = isSubAgentThread(thread);
        return [
          {
            provider: 'codex' as const,
            nativeSessionId: id,
            cwd: str(thread.cwd) || filter.cwd || '',
            host: filter.host,
            title: str(thread.name) || str(thread.preview) || id,
            updatedAt: updated ? new Date(updated * 1000).toISOString() : undefined,
            ...(isAutomated ? { automated: true } : {}),
          },
        ];
      });
    } finally {
      server.kill();
    }
  }

  async readHistory(nativeSessionId: string, cwd: string, host?: string): Promise<ProviderEvent[]> {
    // thread/read loads the rollout without resuming the thread.
    const server = AppServer.spawn(host || existsSync(cwd) ? cwd : homedir(), host);
    try {
      await server.initialize();
      const thread = rec(rec(await server.rpc('thread/read', { threadId: nativeSessionId, includeTurns: true })).thread);
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      return turns.flatMap((turn) => (Array.isArray(rec(turn).items) ? (rec(turn).items as unknown[]) : []).flatMap((item) => itemEvents(item, true, true, cwd)));
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
  private modeChanged = false;
  private idleWaiters: Array<() => void> = [];
  private lastAgentText = '';
  /** Our string request id -> the server's original JSON-RPC id and request kind. */
  private requests = new Map<string, { rpcId: string | number; method: string; questionIds?: string[] }>();
  /** fileChange itemId → latest changes, for approval previews. */
  private fileChanges = new Map<string, unknown>();

  constructor(
    private args: StartArgs,
    private emit: (event: ProviderEvent) => void,
  ) {}

  nativeSessionId(): string | undefined {
    return this.threadId;
  }

  async start(): Promise<void> {
    const server = AppServer.spawn(this.args.cwd, this.args.host);
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
    // Always sandboxed to the workspace; never bypass. The mode decides who reviews escalations.
    const tools = this.args.tools ?? [];
    // Main agent: read-only sandbox, never asks, plus the workspace tools (answered via item/tool/call).
    const policy = tools.length
      ? { approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema) })) }
      : { ...codexPolicy(this.args.permissionMode ?? 'auto'), sandbox: 'workspace-write' };
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
        for (const e of itemEvents(item, true, true, this.args.cwd)) this.emit(e);
    this.emit({ type: 'sessionStarted', nativeSessionId: this.threadId, resumed: !!resumeId });
  }

  async send(text: string, opts?: { interrupt?: boolean }): Promise<Delivery> {
    if (!this.server || this.server.closed || !this.threadId) throw new Error('Codex session is not connected.');
    const input = [{ type: 'text', text, text_elements: [] }];
    if (this.working && this.turnId && !opts?.interrupt) {
      // turn/steer adds the message to the running turn; Codex reads it right away.
      try {
        await this.server.rpc('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input });
        return 'steer';
      } catch (error) {
        // The turn ended or cannot be steered (e.g. a review turn): start a new one instead.
        if (process.env.AMW_DEBUG_CODEX) console.error('[codex] steer failed', (error as Error).message);
        if (this.working) await this.waitForIdle(() => this.interrupt());
      }
    } else if (this.working) {
      await this.waitForIdle(() => this.interrupt());
      await this.startTurn(input);
      return 'interrupt';
    }
    await this.startTurn(input);
    return 'turn';
  }

  /** Resolves once the current turn has completed (after `stop`, if given). */
  private waitForIdle(stop?: () => Promise<void>): Promise<void> {
    if (!this.working) return Promise.resolve();
    const done = new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    void stop?.();
    return Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 15_000))]);
  }

  private async startTurn(input: unknown[]): Promise<void> {
    if (!this.server || !this.threadId) throw new Error('Codex session is not connected.');
    this.working = true;
    this.interruptRequested = false;
    this.lastAgentText = '';
    this.emit({ type: 'turnStarted' });
    try {
      const result = rec(
        await this.server.rpc('turn/start', {
          threadId: this.threadId,
          input,
          // Applies to this turn and later ones (a mode change takes effect here).
          ...(this.modeChanged && !this.args.tools?.length ? codexPolicy(this.args.permissionMode ?? 'auto') : {}),
        }),
      );
      this.turnId = str(rec(result.turn).id) || this.turnId;
      this.modeChanged = false;
    } catch (error) {
      this.working = false;
      throw error;
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.args.permissionMode = mode;
    this.modeChanged = true;
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
    if (method === 'item/tool/call') {
      // A workspace tool call from the main agent: run it here and answer.
      const tool = this.args.tools?.find((t) => t.name === str(p.tool));
      const reply = (text: string, success: boolean) => this.server?.reply(rpcId, { contentItems: [{ type: 'inputText', text }], success });
      if (!tool) return reply(`Unknown tool ${str(p.tool)}`, false);
      void tool
        .run(rec(p.arguments))
        .then((text) => reply(text, true))
        .catch((error: unknown) => reply((error as Error).message, false));
      return;
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const command = str(p.command);
      const isCommand = method === 'item/commandExecution/requestApproval';
      const itemId = str(p.itemId) || undefined;
      this.requests.set(requestId, { rpcId, method });
      // A fileChange approval carries no diff; it lives on the item with the same id.
      const preview = isCommand
        ? [{ type: 'terminal' as const, command, cwd: str(p.cwd) || undefined, output: '' }]
        : codexFileDiffs(itemId ? this.fileChanges.get(itemId) : undefined, 'proposed', this.args.cwd);
      this.emit({
        type: 'approvalRequested',
        requestId,
        headline: isCommand ? `Run command: ${command || '(command)'}` : `Apply changes to ${preview.length === 1 && preview[0].type === 'diff' ? preview[0].diff.path : `${preview.length || 'some'} files`}`,
        details: [
          str(p.reason),
          str(p.grantRoot) && `Grants write access to: ${str(p.grantRoot)}`,
          p.networkApprovalContext ? `Network access: ${JSON.stringify(p.networkApprovalContext)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        options: [
          { id: 'accept', label: 'Allow once', kind: 'allow_once' },
          { id: 'acceptForSession', label: 'Allow for this session', kind: 'allow_always' },
          { id: 'decline', label: 'Deny', kind: 'reject_once' },
        ],
        toolCallId: itemId,
        preview,
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
          allowOther: r.isOther === true || !Array.isArray(r.options) || !r.options.length,
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
        toolCallId: str(p.itemId) || undefined,
      });
      return;
    }
    if (method === 'mcpServer/elicitation/request') {
      this.server?.reply(rpcId, { action: 'cancel', content: null, _meta: null });
      this.emit({ type: 'progress', text: `Cancelled an MCP elicitation from ${str(p.serverName) || 'an MCP server'} (not supported in this MVP).` });
      return;
    }
    // Never leave an unsupported request hanging, and never silently approve it.
    this.server?.replyError(rpcId, `Agent Workspace does not support ${method} yet.`);
    this.emit({ type: 'progress', text: `Codex requested an unsupported interaction (${method}); it was refused.` });
  }

  private notification(method: string, p: Rec): void {
    if (process.env.AMW_DEBUG_CODEX) console.error('[codex]', method, method.includes('plan') ? JSON.stringify(p).slice(0, 300) : '');
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started':
        this.turnId = str(rec(p.turn).id) || this.turnId;
        return;
      case 'guardianWarning': {
        // Codex auto-review decided an escalation itself; keep that visible in the transcript.
        const message = str(p.message);
        if (message) this.emit({ type: 'transcriptItem', itemId: `review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role: 'system', text: message.slice(0, 300) });
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = rec(p.item);
        if (item.type === 'agentMessage' && str(item.text)) this.lastAgentText = str(item.text);
        if (item.type === 'fileChange') this.fileChanges.set(str(item.id), item.changes);
        for (const e of itemEvents(item, false, method === 'item/completed', this.args.cwd)) {
          this.emit(e);
          if (method === 'item/started' && e.type === 'transcriptItem' && e.tool?.title) this.emit({ type: 'progress', text: e.tool.title });
        }
        return;
      }
      case 'item/agentMessage/delta':
        this.emit({ type: 'outputDelta', itemId: str(p.itemId), role: 'assistant', delta: str(p.delta) });
        return;
      case 'item/commandExecution/outputDelta':
        this.emit({ type: 'outputDelta', itemId: str(p.itemId), role: 'tool', delta: str(p.delta) });
        return;
      case 'item/reasoning/summaryTextDelta':
        this.emit({ type: 'outputDelta', itemId: str(p.itemId), role: 'thought', delta: str(p.delta) });
        return;
      case 'item/fileChange/patchUpdated':
        this.fileChanges.set(str(p.itemId), p.changes);
        this.emit({ type: 'transcriptItem', itemId: str(p.itemId), role: 'tool', text: '', tool: { content: codexFileDiffs(p.changes, 'proposed', this.args.cwd) } });
        return;
      case 'turn/plan/updated': {
        const entries = codexPlan(p.plan);
        this.emit({ type: 'planUpdated', entries, explanation: str(p.explanation) || undefined });
        const active = entries.find((e) => e.status === 'in_progress');
        if (active) this.emit({ type: 'progress', text: active.content });
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
        for (const resolve of this.idleWaiters.splice(0)) resolve();
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
