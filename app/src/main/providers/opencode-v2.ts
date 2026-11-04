import type { AttentionQuestion, PermissionMode } from '../../shared/types';
import { privateFolders } from '../private-folders';
import { arr, openCodePart, openCodeToolId, rec, str } from './opencode-content';
import type { OpenCodeServer } from './opencode-server';
import type { ApprovalResponse, Delivery, ProviderEvent, ProviderSession, StartArgs } from './types';

type RecordValue = Record<string, unknown>;
const matches = (value: string, pattern: string) => new RegExp('^' + pattern.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's').test(value);
const errorText = (value: unknown) => str(rec(value).message) || str(rec(value).type) || 'OpenCode turn failed.';

/** OpenCode 2.x uses /api, data envelopes and execution events, not the 1.x SDK wire format. */
export class OpenCodeV2Session implements ProviderSession {
  readonly provider = 'opencode' as const;
  private id?: string;
  private working = false;
  private ready = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private permissions: RecordValue[] = [];
  private parts = new Map<string, RecordValue>();
  private patches = new Map<string, RecordValue>();
  private requests = new Map<string, { permission?: RecordValue; fields?: RecordValue[] }>();
  private deciding = new Set<string>();
  private idleWaiters = new Set<() => void>();

  constructor(private server: OpenCodeServer, private args: StartArgs, private emit: (event: ProviderEvent) => void) {}

  nativeSessionId(): string | undefined { return this.id; }
  private path(suffix = ''): string { return `/api/session/${encodeURIComponent(this.id!)}${suffix}`; }

  async start(): Promise<void> {
    this.server.onExit = (reason) => {
      this.resolveRequests('disconnected');
      this.wakeIdle();
      if (this.ready && !this.closed) this.emit({ type: 'sessionDisconnected', reason });
    };
    const location = new URLSearchParams({ 'location[directory]': this.args.cwd });
    const agents = rec(await this.server.request(`/api/agent?${location}`));
    const build = arr(agents.data).map(rec).find((agent) => agent.id === 'build' || agent.name === 'build');
    if (!build || !str(build.id)) throw new Error('OpenCode did not provide its build agent. Check your OpenCode configuration.');
    this.permissions = arr(build.permissions).map(rec);
    const resume = this.args.resumeNativeSessionId;
    if (resume) {
      this.id = resume;
      const info = rec(rec(await this.server.request(this.path())).data);
      if (!arr(info.permissions).some((rule) => rec(rule).action === '*' && rec(rule).resource === '*' && rec(rule).effect === 'ask'))
        throw new Error('This OpenCode session does not have workspace permission rules. Create a new OpenCode task.');
      let cursor = '';
      do {
        const query = new URLSearchParams(cursor ? { cursor, limit: '200' } : { order: 'asc', limit: '200' });
        const page = rec(await this.server.request(this.path(`/message?${query}`)));
        for (const message of arr(page.data).map(rec)) this.history(message);
        cursor = str(rec(page.cursor).next);
      } while (cursor);
    } else {
      const permissions = [
        { action: '*', resource: '*', effect: 'ask' },
        ...this.permissions.map((rule) => ({ ...rule, effect: rule.effect === 'deny' ? 'deny' : 'ask' })),
        ...privateFolders(this.args.cwd).flatMap((dir) => ['read', 'edit', 'external_directory'].map((action) => ({ action, resource: `${dir}/*`, effect: 'deny' }))),
        { action: 'subagent', resource: '*', effect: 'deny' },
      ];
      const info = rec(rec(await this.server.request('/api/session', 'POST', { title: this.args.title, agent: build.id, location: { directory: this.args.cwd }, permissions })).data);
      this.id = str(info.id);
    }
    if (!this.id) throw new Error('OpenCode did not return a session id.');
    if (this.args.developerInstructions)
      await this.server.request(`/api/experimental/session/${encodeURIComponent(this.id)}/instructions/entries/agent-workspace`, 'PUT', { value: this.args.developerInstructions });
    await this.server.subscribe((event) => this.notification(event));
    this.ready = true;
    this.emit({ type: 'sessionStarted', nativeSessionId: this.id, resumed: !!resume });
  }

  send(text: string, opts?: { interrupt?: boolean }): Promise<Delivery> {
    const send = async (): Promise<Delivery> => {
      if (!this.ready || this.closed || this.server.closed) throw new Error('OpenCode session is not connected.');
      const busy = this.working;
      if (busy && opts?.interrupt) await this.interrupt();
      const delivery = busy ? opts?.interrupt ? 'interrupt' : 'steer' : 'turn';
      if (delivery !== 'steer') {
        this.parts.clear(); this.patches.clear();
        this.working = true;
        this.emit({ type: 'turnStarted' });
      }
      try {
        // 2.x acknowledges durable admission to the session inbox, including
        // real steering. SSE may finish a fast turn before this response arrives.
        await this.server.request(this.path('/prompt'), 'POST', { text, delivery: 'steer' });
      } catch (error) {
        if (delivery !== 'steer') this.finish('failed', (error as Error).message);
        throw error;
      }
      return delivery;
    };
    const result = this.queue.then(send);
    this.queue = result.catch(() => {});
    return result;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.args.permissionMode = mode;
    await Promise.all([...this.requests.values()].flatMap((request) => request.permission ? [this.decidePermission(request.permission, false)] : []));
  }

  async interrupt(): Promise<void> {
    if (!this.working || this.server.closed) return;
    // Wait for the terminal event as well as the acknowledgement, so a late
    // interrupt event cannot finish the follow-up prompt instead of the old one.
    let wake!: () => void;
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<void>((resolve, reject) => {
      wake = resolve; this.idleWaiters.add(wake);
      timer = setTimeout(() => reject(new Error('OpenCode did not become idle after interrupt.')), 15_000);
    });
    try {
      const request = this.server.request(this.path('/interrupt'), 'POST').then((result) => {
        if (rec(result).interrupted === false) this.finish('interrupted');
      });
      await Promise.all([request, idle]);
      if (this.server.closed) throw new Error('OpenCode disconnected during interrupt.');
    } catch (error) {
      await this.close();
      this.emit({ type: 'sessionDisconnected', reason: (error as Error).message });
      throw error;
    } finally {
      clearTimeout(timer); this.idleWaiters.delete(wake);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.server.close();
    this.working = false;
    this.wakeIdle();
    this.resolveRequests('stopped');
  }

  async respond(id: string, response: ApprovalResponse): Promise<void> {
    const pending = this.requests.get(id);
    if (!pending || this.server.closed) throw new Error('This OpenCode request is no longer pending.');
    if (pending.permission) {
      if (!['once', 'reject'].includes(response.decision ?? '')) throw new Error('Choose an OpenCode permission decision.');
      await this.server.request(this.path(`/permission/${encodeURIComponent(id)}/reply`), 'POST', { decision: response.decision });
    } else {
      const answer: Record<string, unknown> = {};
      for (const field of pending.fields ?? []) {
        const key = str(field.key);
        const text = response.answers?.[key]?.trim();
        if (!text) {
          if (field.default !== undefined) answer[key] = field.default;
          else if (field.required !== false && field.type !== 'external') throw new Error('Answer every required OpenCode question before sending.');
          continue;
        }
        const option = (label: string) => str(arr(field.options).map(rec).find((o) => o.label === label || o.value === label)?.value) || label;
        if (field.type === 'multiselect') answer[key] = text.split(', ').map(option);
        else if (field.type === 'boolean') {
          if (!['true', 'false', 'Yes', 'No'].includes(text)) throw new Error(`Choose Yes or No for ${str(field.title) || key}.`);
          answer[key] = text === 'true' || text === 'Yes';
        } else if (field.type === 'number' || field.type === 'integer') {
          const number = Number(text);
          if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) throw new Error(`Enter a valid number for ${str(field.title) || key}.`);
          answer[key] = number;
        } else answer[key] = option(text);
      }
      await this.server.request(this.path(`/form/${encodeURIComponent(id)}/reply`), 'POST', { answer });
    }
    if (this.requests.delete(id)) this.emit({ type: 'requestResolved', requestId: id, reason: response.decision ?? 'answered', answered: true });
  }

  private resolveRequests(reason: string): void {
    for (const id of this.requests.keys()) this.emit({ type: 'requestResolved', requestId: id, reason });
    this.requests.clear();
  }

  private wakeIdle(): void { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear(); }

  private finish(status: 'completed' | 'interrupted' | 'failed', error?: string): void {
    if (!this.working) return;
    this.working = false;
    this.wakeIdle();
    this.resolveRequests('turn ended');
    const text = [...this.parts.values()].filter((part) => part.type === 'text');
    const last = text.at(-1)?.messageID;
    this.emit({ type: 'turnCompleted', status, finalText: text.filter((part) => part.messageID === last).map((part) => str(part.text)).join('\n\n') || undefined, error });
  }

  private part(messageID: string, ordinal: string, value: RecordValue, history = false): void {
    const state = rec(value.state);
    const callID = str(value.id);
    const input = rec(state.input);
    const output = arr(state.content).map(rec).filter((c) => c.type === 'text').map((c) => str(c.text)).join('\n');
    const part = {
      ...value, id: `${messageID}-${value.type}-${ordinal}`, messageID, callID, tool: value.name,
      state: { ...state, input, output, error: state.error ? errorText(state.error) : undefined, metadata: { ...this.patches.get(openCodeToolId(messageID, callID)), ...rec(state.metadata) } },
    };
    if (!history) this.parts.set(part.id, part);
    const event = openCodePart(part, 'assistant', this.args.cwd, history);
    if (event) this.emit(event);
  }

  private history(message: RecordValue): void {
    if (message.type === 'user') this.emit({ type: 'transcriptItem', itemId: `oc-${str(message.id)}`, role: 'user', text: str(message.text), history: true });
    if (message.type === 'assistant') arr(message.content).map(rec).forEach((part, index) => this.part(str(message.id), part.type === 'tool' ? str(part.id) : String(index), part, true));
  }

  private notification(value: unknown): void {
    if (this.closed) return;
    const event = rec(value);
    const data = rec(event.data);
    const form = rec(data.form);
    if ((data.sessionID ?? form.sessionID) !== this.id) return;
    const type = str(event.type);
    const messageID = str(data.assistantMessageID);
    if (type === 'session.execution.started') {
      if (!this.working) { this.working = true; this.emit({ type: 'turnStarted' }); }
    } else if (type === 'session.execution.succeeded') this.finish('completed');
    else if (type === 'session.execution.interrupted') this.finish('interrupted');
    else if (type === 'session.execution.failed') this.finish('failed', errorText(data.error));
    else if (type === 'session.retry.scheduled') this.emit({ type: 'progress', text: `OpenCode is retrying: ${errorText(data.error)}` });
    else if (/^session\.(text|reasoning)\./.test(type)) {
      const kind = type.split('.')[1];
      const ordinal = String(data.ordinal);
      const saved = this.parts.get(`${messageID}-${kind}-${ordinal}`);
      this.part(messageID, ordinal, { type: kind, text: type.endsWith('.delta') ? str(saved?.text) + str(data.delta) : type.endsWith('.ended') ? str(data.text) : '' });
    } else if (type.startsWith('session.tool.')) {
      const id = str(data.id);
      const saved = this.parts.get(`${messageID}-tool-${id}`) ?? { type: 'tool', name: data.name };
      const state = rec(saved.state);
      let next = state;
      if (type === 'session.tool.input.started') next = { status: 'running', input: {}, metadata: {} };
      if (type === 'session.tool.called') next = { ...state, status: 'running', input: data.input };
      if (type === 'session.tool.progress') next = { ...state, metadata: { ...rec(state.metadata), ...rec(data.metadata) } };
      if (type === 'session.tool.success' || type === 'session.tool.failed') next = { ...state, status: type.endsWith('.success') ? 'completed' : 'error', content: data.content, metadata: { ...rec(state.metadata), ...rec(data.metadata) }, error: data.error };
      this.part(messageID, id, { ...saved, id, state: next });
    } else if (type === 'session.message.content.updated') {
      arr(data.content).map(rec).forEach((part, index) => this.part(str(data.messageID), part.type === 'tool' ? str(part.id) : String(index), part));
    } else if (type === 'permission.asked') this.permission(data);
    else if (type === 'form.created') this.form(form);
    else if (['permission.replied', 'form.replied', 'form.cancelled'].includes(type)) {
      const id = str(data.requestID) || str(data.id);
      if (this.requests.delete(id)) this.emit({ type: 'requestResolved', requestId: id, reason: type, answered: type !== 'form.cancelled' });
    }
  }

  private permission(data: RecordValue): void {
    const id = str(data.id);
    if (!id || this.requests.has(id)) return;
    this.requests.set(id, { permission: data });
    const source = rec(data.source);
    if (source.id) this.patches.set(openCodeToolId(str(source.messageID), str(source.id)), rec(data.metadata));
    void this.decidePermission(data);
  }

  private async decidePermission(data: RecordValue, showPending = true): Promise<void> {
    const id = str(data.id);
    if (!this.requests.has(id) || this.deciding.has(id)) return;
    const action = str(data.action);
    const effects = (arr(data.resources).length ? arr(data.resources).map(str) : ['*']).map((resource) => this.permissions.findLast((rule) => matches(action, str(rule.action)) && matches(resource, str(rule.resource)))?.effect);
    const reject = action === 'subagent' || effects.includes('deny');
    // Match OpenCode --auto: approve requests, including configured asks, while
    // retaining denies and using one-shot replies rather than saved allowances.
    const allow = (this.args.permissionMode ?? 'auto') === 'auto' || (!effects.includes('ask') && (['read', 'glob', 'grep', 'list', 'lsp', 'todowrite', 'todoread', 'question'].includes(action) || (action === 'edit' && this.args.permissionMode !== 'ask')));
    if (reject || allow) {
      this.deciding.add(id);
      try { await this.respond(id, { decision: reject ? 'reject' : 'once' }); }
      catch {
        if (!this.requests.has(id)) return;
        if (reject) { await this.close(); this.emit({ type: 'sessionFailed', error: 'OpenCode could not reject a prohibited action; the session was stopped.' }); }
        else this.showPermission(data);
      } finally { this.deciding.delete(id); }
    } else if (showPending) this.showPermission(data);
  }

  private showPermission(data: RecordValue): void {
    const source = rec(data.source);
    const resources = arr(data.resources).map(str);
    const metadata = rec(data.metadata);
    const tool = openCodePart({ type: 'tool', id: 'preview', messageID: source.messageID, callID: source.id, tool: data.action === 'shell' ? 'shell' : data.action, state: { status: 'running', input: { command: str(metadata.command) || resources.join('\n'), path: resources[0] }, metadata } }, 'assistant', this.args.cwd);
    this.emit({ type: 'approvalRequested', requestId: str(data.id), headline: `OpenCode: ${str(data.action)} ${resources.join(', ')}`, details: str(data.message) || resources.join('\n'), toolCallId: source.id ? openCodeToolId(str(source.messageID), str(source.id)) : undefined,
      options: [{ id: 'once', label: 'Allow once', kind: 'allow_once' }, { id: 'reject', label: 'Deny', kind: 'reject_once' }], preview: tool?.type === 'transcriptItem' ? tool.tool?.content : undefined });
  }

  private form(form: RecordValue): void {
    const id = str(form.id);
    if (!id || this.requests.has(id)) return;
    const fields = arr(form.fields).map(rec);
    const questions: AttentionQuestion[] = fields.filter((field) => !field.hidden).map((field) => ({
      id: str(field.key), question: [str(field.title) || str(field.key), str(field.description), str(field.url)].filter(Boolean).join('\n'),
      multiSelect: field.type === 'multiselect', allowOther: field.custom !== false && field.type !== 'boolean',
      options: field.type === 'boolean' ? [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }] : arr(field.options).map(rec).map((option) => ({ id: str(option.value), label: str(option.label), description: str(option.description) })),
    }));
    this.requests.set(id, { fields });
    this.emit({ type: 'userInputRequested', requestId: id, headline: str(form.title) || 'OpenCode needs your input', questions });
  }
}
