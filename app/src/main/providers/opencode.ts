import type { AttentionQuestion, NativeSessionInfo, PermissionMode, ProviderCapabilities } from '../../shared/types';
import { privateFolders } from '../private-folders';
import { findExecutable, run } from '../util/exec';
import { arr, openCodeDiff, openCodeHistory, openCodePart, openCodeToolId, rec, str } from './opencode-content';
import { OpenCodeServer } from './opencode-server';
import { OpenCodeV2Session } from './opencode-v2';
import type { ApprovalResponse, Delivery, ProviderAdapter, ProviderEvent, ProviderSession, StartArgs } from './types';

// OpenCode permission patterns use * and ? wildcards, not filesystem globs.
const matches = (value: string, pattern: string) =>
  new RegExp('^' + pattern.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's').test(value);

// Public HTTP/SSE API: 1.x uses the legacy SDK wire format documented at
// https://opencode.ai/docs/server/; 2.x uses /api and is handled by opencode-v2.ts.
// The legacy SDK's "v2" namespace is not the OpenCode 2.x server protocol.
// Each worker owns a server
// bound to loopback, with a random password, in its workspace worktree. No SDK or
// credentials are bundled; the installed CLI selects its configured model/login.

export class OpenCodeAdapter implements ProviderAdapter {
  readonly provider = 'opencode' as const;

  async capabilities(): Promise<ProviderCapabilities> {
    const exe = findExecutable('opencode');
    const result = exe ? await run(exe, ['--version'], { timeoutMs: 15_000 }) : undefined;
    const available = !!exe && result?.code === 0;
    return {
      provider: this.provider, available, version: result?.stdout.trim() || undefined,
      detail: !exe ? 'OpenCode CLI not found on PATH. Install opencode and recheck in Settings.' : !available ? 'OpenCode is installed but could not run. Check opencode --version in a terminal.' : 'opencode serve (local HTTP/SSE). Uses your OpenCode model and login. Configure them in opencode or opencode auth login.',
      createSession: available, resumeHistorical: available, importHistory: false,
      attachExternalRunning: false, readOnlyMonitor: false, structuredApprovals: true, structuredQuestions: true,
      // There is no single login flag: free/local models and environment-based
      // providers also work. Never read auth.json or infer signed-out from it.
    };
  }

  async discoverSessions(): Promise<NativeSessionInfo[]> {
    // Managed sessions resume by their persisted id. Importing arbitrary external
    // sessions needs a separate policy migration; do not offer that capability yet.
    return [];
  }

  createSession(args: StartArgs, onEvent: (event: ProviderEvent) => void): ProviderSession {
    return new OpenCodeSession(args, onEvent);
  }
}

class OpenCodeSession implements ProviderSession {
  readonly provider = 'opencode' as const;
  private server?: OpenCodeServer;
  private v2?: OpenCodeV2Session;
  private id?: string;
  private working = false;
  private activeObserved = false;
  private interrupted = false;
  private closed = false;
  private ready = false;
  private sendQueue: Promise<unknown> = Promise.resolve();
  private idleWaiters = new Set<() => void>();
  private roles = new Map<string, string>();
  private parts = new Map<string, Record<string, unknown>>();
  private editPatches = new Map<string, string>();
  private turnText = new Map<string, Map<string, string>>();
  private configuredPermissions: Record<string, unknown>[] = [];
  private requests = new Map<string, { kind: 'permission' | 'question'; questions?: AttentionQuestion[]; permission?: Record<string, unknown> }>();
  private deciding = new Set<string>();

  constructor(private args: StartArgs, private emit: (event: ProviderEvent) => void) {}

  nativeSessionId(): string | undefined { return this.v2?.nativeSessionId() ?? this.id; }

  async start(): Promise<void> {
    if (this.args.host) throw new Error('OpenCode agents currently run on local projects only.');
    if (this.args.tools?.length) throw new Error('OpenCode is a coding provider; choose Claude Code or Codex for the main agent.');
    const server = new OpenCodeServer(this.args.cwd);
    this.server = server;
    server.onExit = (reason) => {
      this.resolveRequests('disconnected');
      this.wakeIdle();
      if (this.ready && !this.closed) this.emit({ type: 'sessionDisconnected', reason });
    };
    try {
      await server.start();
      if (server.apiVersion === 2) {
        this.v2 = new OpenCodeV2Session(server, this.args, this.emit);
        return await this.v2.start();
      }
      const build = arr(await server.request('/agent')).map(rec).find((a) => a.name === 'build');
      if (!build) throw new Error('OpenCode did not provide its build agent. Check your OpenCode configuration.');
      this.configuredPermissions = arr(build.permission).map(rec);
      const resume = this.args.resumeNativeSessionId;
      if (resume) {
        const session = rec(await server.request(`/session/${encodeURIComponent(resume)}`));
        this.id = str(session.id);
        // Only our managed sessions are resumable through this adapter. They keep
        // all actions gated so changing the app's mode also works after a restart.
        if (!arr(session.permission).some((r) => rec(r).permission === '*' && rec(r).pattern === '*' && rec(r).action === 'ask'))
          throw new Error('This OpenCode session does not have workspace permission rules. Create a new OpenCode task.');
        for (const event of openCodeHistory(await server.request(this.path('/message')), this.args.cwd)) this.emit(event);
      } else {
        // Gate actions through the workspace without overriding the build agent's
        // explicit deny rules. Native auto mode replies once to non-denied
        // requests; keeping the gate lets modes change without restarting.
        // Keep order: built-in deny rules can have later allow exceptions (notably
        // question). Convert allowances to asks without resurrecting older denies.
        const rules = this.configuredPermissions.map((rule) => {
          return { ...rule, action: rule.action === 'deny' ? 'deny' : 'ask' };
        });
        const privacy = privateFolders(this.args.cwd).flatMap((dir) => ['read', 'edit', 'external_directory'].map((permission) => ({ permission, pattern: `${dir}/*`, action: 'deny' })));
        // Native subagents have independent policies/requests. Until their relay
        // is supported, create additional workers through workspace create_agent.
        const permission = [{ permission: '*', pattern: '*', action: 'ask' }, ...rules, ...privacy, { permission: 'task', pattern: '*', action: 'deny' }];
        const session = rec(await server.request('/session', 'POST', { title: this.args.title, permission }));
        this.id = str(session.id);
      }
      if (!this.id) throw new Error('OpenCode did not return a session id.');
      await server.subscribe((event) => this.notification(event));
      this.ready = true;
      this.emit({ type: 'sessionStarted', nativeSessionId: this.id, resumed: !!resume });
    } catch (error) {
      server.close();
      throw error;
    }
  }

  private path(suffix = ''): string {
    if (!this.id) throw new Error('OpenCode session is not connected.');
    return `/session/${encodeURIComponent(this.id)}${suffix}`;
  }

  send(text: string, opts?: { interrupt?: boolean }): Promise<Delivery> {
    if (this.v2) return this.v2.send(text, opts);
    const send = async (): Promise<Delivery> => {
      if (this.closed || !this.ready || !this.server || this.server.closed) throw new Error('OpenCode session is not connected.');
      const wasWorking = this.working;
      // The HTTP API has no steer acknowledgement. Finish aborting the current
      // turn before starting the follow-up, and report the actual delivery.
      if (wasWorking) await this.interrupt();
      this.turnText.clear();
      this.parts.clear();
      this.editPatches.clear();
      this.roles.clear();
      this.working = true;
      this.activeObserved = false;
      this.interrupted = false;
      this.emit({ type: 'turnStarted' });
      try {
        await this.server.request(this.path('/prompt_async'), 'POST', {
          agent: 'build', system: this.args.developerInstructions,
          parts: [{ type: 'text', text }],
        });
      } catch (error) {
        this.finish('failed', (error as Error).message);
        throw error;
      }
      return wasWorking ? 'interrupt' : 'turn';
    };
    const result = this.sendQueue.then(send);
    this.sendQueue = result.catch(() => {});
    return result;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.v2) return this.v2.setPermissionMode(mode);
    this.args.permissionMode = mode;
    await Promise.all([...this.requests.values()].flatMap((request) => request.permission ? [this.decidePermission(request.permission, false)] : []));
  }

  async respond(requestId: string, response: ApprovalResponse): Promise<void> {
    if (this.v2) return this.v2.respond(requestId, response);
    const pending = this.requests.get(requestId);
    if (!pending || !this.server || this.server.closed) throw new Error('This OpenCode request is no longer pending.');
    if (pending.kind === 'permission') {
      if (!['once', 'reject'].includes(response.decision ?? '')) throw new Error('Choose an OpenCode permission decision.');
      await this.server.request(`/permission/${encodeURIComponent(requestId)}/reply`, 'POST', { reply: response.decision });
    } else {
      const answers = (pending.questions ?? []).map((q) => {
        const answer = response.answers?.[q.id]?.trim();
        if (!answer) throw new Error('Answer every OpenCode question before sending.');
        // The shared attention UI represents multi-select as comma-separated labels.
        return q.multiSelect ? answer.split(', ').filter(Boolean) : [answer];
      });
      await this.server.request(`/question/${encodeURIComponent(requestId)}/reply`, 'POST', { answers });
    }
    if (this.requests.delete(requestId)) this.emit({ type: 'requestResolved', requestId, reason: response.decision ?? 'answered', answered: true });
  }

  async interrupt(): Promise<void> {
    if (this.v2) return this.v2.interrupt();
    if (!this.working || !this.server || this.server.closed) return;
    this.interrupted = true;
    let wake!: () => void;
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<void>((resolve, reject) => {
      wake = resolve;
      this.idleWaiters.add(wake);
      timer = setTimeout(() => reject(new Error('OpenCode did not become idle after interrupt.')), 15_000);
    });
    try {
      await Promise.all([this.server.request(this.path('/abort'), 'POST'), idle]);
    } catch (error) {
      this.server.close();
      this.resolveRequests('interrupted');
      this.emit({ type: 'sessionDisconnected', reason: (error as Error).message });
      throw error;
    } finally {
      clearTimeout(timer);
      this.idleWaiters.delete(wake);
    }
  }

  async close(): Promise<void> {
    if (this.v2) return this.v2.close();
    this.closed = true;
    this.server?.close();
    this.resolveRequests('stopped');
    this.working = false;
    this.wakeIdle();
  }

  private wakeIdle(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private resolveRequests(reason: string): void {
    for (const id of this.requests.keys()) this.emit({ type: 'requestResolved', requestId: id, reason });
    this.requests.clear();
  }

  private finish(status: 'completed' | 'interrupted' | 'failed', error?: string): void {
    if (!this.working) return;
    // status.idle and the legacy session.idle can both arrive for the old turn.
    if (status === 'completed' && !this.interrupted && !this.activeObserved) return;
    this.working = false;
    this.resolveRequests('turn ended');
    const last = [...this.turnText.values()].at(-1);
    this.emit({ type: 'turnCompleted', status: this.interrupted ? 'interrupted' : status, finalText: last ? [...last.values()].join('\n\n') : undefined, error });
    this.wakeIdle();
  }

  private part(value: unknown): void {
    let part = rec(value);
    if (part.type === 'tool') {
      const patch = this.editPatches.get(openCodeToolId(str(part.messageID), str(part.callID)));
      const state = rec(part.state);
      const metadata = rec(state.metadata);
      if (patch && !metadata.diff && !metadata.filediff) part = { ...part, state: { ...state, metadata: { ...metadata, diff: patch } } };
    }
    this.parts.set(str(part.id), part);
    const role = this.roles.get(str(part.messageID));
    if (!role) return; // a snapshot can arrive before its message metadata
    const event = openCodePart(part, role, this.args.cwd);
    if (event) this.emit(event);
    if (this.working && role === 'assistant' && part.type === 'text' && !part.synthetic && !part.ignored) {
      const messageID = str(part.messageID);
      const text = this.turnText.get(messageID) ?? new Map<string, string>();
      text.set(str(part.id), str(part.text));
      this.turnText.set(messageID, text);
    }
  }

  private notification(value: unknown): void {
    if (this.closed) return;
    const event = rec(value);
    const p = rec(event.properties);
    const info = rec(p.info);
    const part = rec(p.part);
    const sessionIDs = [str(p.sessionID), str(info.sessionID), str(part.sessionID)].filter(Boolean);
    if (!this.id || !sessionIDs.length || sessionIDs.some((id) => id !== this.id)) return; // never mix child or other sessions into this worker
    switch (event.type) {
      case 'message.updated':
        if (info.role === 'assistant') this.activeObserved = true;
        this.roles.set(str(info.id), str(info.role));
        for (const saved of this.parts.values()) if (saved.messageID === info.id) this.part(saved);
        if (info.error) this.finish(rec(info.error).name === 'MessageAbortedError' ? 'interrupted' : 'failed', str(rec(rec(info.error).data).message) || str(rec(info.error).name));
        break;
      case 'message.part.updated':
        this.part(part);
        break;
      case 'message.part.delta': {
        const saved = this.parts.get(str(p.partID));
        if (saved && p.field === 'text') this.part({ ...saved, text: str(saved.text) + str(p.delta) });
        break;
      }
      case 'session.status':
        if (rec(p.status).type === 'idle') this.finish('completed');
        else {
          this.activeObserved = true;
          if (rec(p.status).type === 'retry') this.emit({ type: 'progress', text: str(rec(p.status).message) || 'OpenCode is retrying the model request.' });
        }
        break;
      case 'session.idle':
        this.finish('completed');
        break;
      case 'session.error':
        this.finish(rec(p.error).name === 'MessageAbortedError' ? 'interrupted' : 'failed', str(rec(rec(p.error).data).message) || str(rec(p.error).name) || 'OpenCode turn failed.');
        break;
      case 'todo.updated':
        this.emit({ type: 'planUpdated', entries: arr(p.todos).map((todo, i) => {
          const t = rec(todo);
          return { id: String(i), content: str(t.content), status: t.status === 'in_progress' ? 'in_progress' : t.status === 'completed' || t.status === 'cancelled' ? 'completed' : 'pending' };
        }) });
        break;
      case 'session.diff':
        this.emit({ type: 'transcriptItem', itemId: `oc-diff-${this.id}`, role: 'tool', text: '', toolStatus: 'completed', tool: { name: 'session.diff', kind: 'edit', title: 'Session changes', locations: [], content: arr(p.diff).map((diff) => ({ type: 'diff', diff: openCodeDiff(diff, 'applied', this.args.cwd) })) } });
        break;
      case 'permission.asked':
        this.permission(p);
        break;
      case 'question.asked': {
        const id = str(p.id);
        if (!id || this.requests.has(id)) break;
        const questions: AttentionQuestion[] = arr(p.questions).map((value, index) => {
          const q = rec(value);
          return { id: String(index), question: str(q.question), header: str(q.header), multiSelect: q.multiple === true, allowOther: q.custom !== false, options: arr(q.options).map((o, i) => ({ id: String(i), label: str(rec(o).label), description: str(rec(o).description) })) };
        });
        this.requests.set(id, { kind: 'question', questions });
        const tool = rec(p.tool);
        this.emit({ type: 'userInputRequested', requestId: id, headline: questions[0]?.question || 'OpenCode needs your input', questions, toolCallId: tool.callID ? openCodeToolId(str(tool.messageID), str(tool.callID)) : undefined });
        break;
      }
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected': {
        const id = str(p.requestID);
        if (this.requests.delete(id)) this.emit({ type: 'requestResolved', requestId: id, reason: str(event.type), answered: event.type !== 'question.rejected' });
        break;
      }
    }
  }

  private permission(p: Record<string, unknown>): void {
    const id = str(p.id);
    if (!id || this.requests.has(id)) return;
    this.requests.set(id, { kind: 'permission', permission: p });
    const tool = rec(p.tool);
    const patch = str(rec(p.metadata).diff);
    if (tool.callID && patch) this.editPatches.set(openCodeToolId(str(tool.messageID), str(tool.callID)), patch);
    void this.decidePermission(p);
  }

  private async decidePermission(p: Record<string, unknown>, showPending = true): Promise<void> {
    const id = str(p.id);
    if (!this.requests.has(id) || this.deciding.has(id)) return;
    const permission = str(p.permission);
    const actions = (arr(p.patterns).length ? arr(p.patterns).map(str) : ['*']).map((pattern) =>
      this.configuredPermissions.findLast((rule) => matches(permission, str(rule.permission)) && matches(pattern, str(rule.pattern)))?.action,
    );
    const safe = ['read', 'glob', 'grep', 'list', 'lsp', 'todowrite', 'todoread', 'question'];
    const reject = permission === 'task' || actions.includes('deny');
    // OpenCode --auto approves asks too; explicit deny rules still win.
    const allow = (this.args.permissionMode ?? 'auto') === 'auto' || (!actions.includes('ask') && (safe.includes(permission) || (permission === 'edit' && this.args.permissionMode !== 'ask')));
    if (reject || allow) {
      this.deciding.add(id);
      try { await this.respond(id, { decision: reject ? 'reject' : 'once' }); }
      catch {
        if (!this.requests.has(id)) return;
        if (reject) {
          await this.close();
          this.emit({ type: 'sessionFailed', error: 'OpenCode could not reject a prohibited action; the session was stopped.' });
        } else this.showPermission(p);
      } finally { this.deciding.delete(id); }
    } else if (showPending) this.showPermission(p);
  }

  private showPermission(p: Record<string, unknown>): void {
    const metadata = rec(p.metadata);
    const tool = rec(p.tool);
    const command = str(metadata.command);
    const diff = str(metadata.diff);
    this.emit({
      type: 'approvalRequested', requestId: str(p.id), headline: `OpenCode: ${str(p.permission)} ${arr(p.patterns).map(str).join(', ')}`,
      details: command || arr(p.patterns).map(str).join('\n'),
      toolCallId: tool.callID ? openCodeToolId(str(tool.messageID), str(tool.callID)) : undefined,
      options: [{ id: 'once', label: 'Allow once', kind: 'allow_once' }, { id: 'reject', label: 'Deny', kind: 'reject_once' }],
      preview: command ? [{ type: 'terminal', command, cwd: this.args.cwd, output: '' }] : diff ? [{ type: 'diff', diff: openCodeDiff({ file: arr(p.patterns)[0], diff }, 'proposed', this.args.cwd) }] : undefined,
    });
  }
}
