import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeSessionInfo, ProviderCapabilities } from '../../shared/types';
import type { ApprovalResponse, ProviderAdapter, ProviderEvent, ProviderSession, StartArgs } from './types';

/**
 * Deterministic scripted agent used for UI tests and the demo. It behaves like a
 * provider: it owns its own persisted "native" history (so resume restores real
 * prior context), and it raises native-style approval / question requests that
 * can only be answered through respond(), never through chat text.
 *
 * Scripts (StartArgs.mockScript):
 *   ask:<question>       first turn ends by asking <question> in a normal message
 *   approval:<command>   first turn requests approval to run <command>
 *   choice:<question>    first turn raises a structured question with options
 *   work                 first turn reports progress and finishes
 */
interface MockHistory {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; text: string; itemId: string }>;
}

export class MockAdapter implements ProviderAdapter {
  readonly provider = 'mock' as const;
  constructor(
    private dir: string,
    private delayMs = Number(process.env.AMW_MOCK_DELAY_MS ?? 900),
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      provider: 'mock',
      available: true,
      version: 'scripted',
      detail: 'Deterministic demo agent; no model calls.',
      createSession: true,
      resumeHistorical: true,
      importHistory: false,
      attachExternalRunning: false,
      readOnlyMonitor: false,
      structuredApprovals: true,
      structuredQuestions: true,
    };
  }

  async discoverSessions(): Promise<NativeSessionInfo[]> {
    return [];
  }

  createSession(args: StartArgs, onEvent: (event: ProviderEvent) => void): ProviderSession {
    return new MockSession(this.dir, this.delayMs, args, onEvent);
  }
}

class MockSession implements ProviderSession {
  readonly provider = 'mock' as const;
  private history?: MockHistory;
  private pending = new Map<string, { kind: 'approval' | 'question'; command?: string }>();
  private closed = false;
  private busy = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private dir: string,
    private delayMs: number,
    private args: StartArgs,
    private emit: (event: ProviderEvent) => void,
  ) {}

  nativeSessionId(): string | undefined {
    return this.history?.id;
  }

  async start(): Promise<void> {
    const resumeId = this.args.resumeNativeSessionId;
    if (resumeId) {
      const file = this.file(resumeId);
      if (!existsSync(file)) throw new Error(`Mock session ${resumeId} not found.`);
      this.history = JSON.parse(readFileSync(file, 'utf8')) as MockHistory;
      for (const m of this.history.messages)
        this.emit({ type: 'transcriptItem', itemId: m.itemId, role: m.role, text: m.text, history: true });
    } else {
      this.history = {
        id: `mock-${randomUUID()}`,
        cwd: this.args.cwd,
        title: this.args.title,
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      this.save();
    }
    this.emit({ type: 'sessionStarted', nativeSessionId: this.history.id, resumed: !!resumeId });
  }

  async send(text: string): Promise<void> {
    if (this.closed || !this.history) throw new Error('Mock session is closed.');
    if (this.busy) throw new Error('Mock agent is busy; wait for the current turn to finish.');
    this.busy = true;
    const userTurns = this.history.messages.filter((m) => m.role === 'user').length;
    this.record('user', text);
    this.emit({ type: 'turnStarted' });
    const script = this.args.mockScript ?? 'work';
    const first = userTurns === 0;
    this.later(() => this.emit({ type: 'progress', text: `Reading ${this.args.title} context…` }), 0.3);
    if (first && script.startsWith('approval:')) {
      const command = script.slice('approval:'.length);
      this.later(() => {
        const requestId = `mock-approval-${randomUUID()}`;
        this.pending.set(requestId, { kind: 'approval', command });
        this.emit({
          type: 'approvalRequested',
          requestId,
          headline: `Run command: ${command}`,
          details: `Bash\n${command}\ncwd: ${this.args.cwd}`,
          options: [
            { id: 'allow', label: 'Allow once' },
            { id: 'deny', label: 'Deny' },
          ],
          highRisk: /drop|rm |migrat|delete/i.test(command),
        });
      }, 1);
      return;
    }
    if (first && script.startsWith('choice:')) {
      const question = script.slice('choice:'.length);
      this.later(() => {
        const requestId = `mock-question-${randomUUID()}`;
        this.pending.set(requestId, { kind: 'question' });
        this.emit({
          type: 'userInputRequested',
          requestId,
          headline: question,
          questions: [
            {
              id: 'q1',
              question,
              options: [
                { id: 'a', label: 'Option A', description: 'Keep current behaviour' },
                { id: 'b', label: 'Option B', description: 'Change it' },
              ],
            },
          ],
        });
      }, 1);
      return;
    }
    this.later(() => {
      let reply: string;
      const memory = this.args.developerInstructions
        ? `Loaded workspace memory:\n${this.args.developerInstructions
            .split('\n')
            .filter((l) => l.startsWith('- '))
            .join('\n')}\n\n`
        : '';
      if (first && script.startsWith('ask:')) {
        reply = `I looked into "${this.args.title}".\n\n${script.slice('ask:'.length)}`;
      } else if (first) {
        reply = `Done with the first pass on "${this.args.title}". Components 3/5 built; continuing.`;
      } else {
        reply =
          `(turn ${userTurns + 1}, I remember ${this.history?.messages.length ?? 0} prior messages) ` +
          `You said: "${text.slice(0, 200)}". ` +
          (userTurns % 2 === 0 ? 'Understood — applying that.' : 'Should I also update the related tests?');
      }
      this.finish(first ? memory + reply : reply);
    }, 1);
  }

  async respond(requestId: string, response: ApprovalResponse): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('This request is no longer pending.');
    this.pending.delete(requestId);
    this.emit({ type: 'requestResolved', requestId, reason: response.decision ?? 'answered' });
    if (pending.kind === 'approval') {
      const allowed = response.decision === 'allow';
      this.record('tool', allowed ? `$ ${pending.command}\n(mock) command executed` : `Denied: ${pending.command} was not run.`);
      this.later(
        () =>
          this.finish(
            allowed
              ? `Ran \`${pending.command}\`. Everything looks fine.`
              : `Understood, I did not run \`${pending.command}\`. What would you like instead?`,
          ),
        0.5,
      );
    } else {
      const answer = Object.values(response.answers ?? {}).join(', ');
      this.later(() => this.finish(`Thanks — going with "${answer}".`), 0.5);
    }
  }

  async interrupt(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const id of this.pending.keys()) this.emit({ type: 'requestResolved', requestId: id, reason: 'interrupted' });
    this.pending.clear();
    if (this.busy) {
      this.busy = false;
      this.emit({ type: 'turnCompleted', status: 'interrupted' });
    }
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.closed = true;
  }

  private finish(reply: string): void {
    this.record('assistant', reply);
    this.busy = false;
    this.emit({ type: 'turnCompleted', status: 'completed', finalText: reply });
  }

  private record(role: 'user' | 'assistant' | 'tool', text: string): void {
    if (!this.history) return;
    const itemId = `${this.history.id}:${this.history.messages.length}`;
    this.history.messages.push({ role, text, itemId });
    this.history.updatedAt = new Date().toISOString();
    this.save();
    // User messages are already shown optimistically by the workspace.
    if (role !== 'user') this.emit({ type: 'transcriptItem', itemId, role, text });
  }

  private later(fn: () => void, factor: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) fn();
    }, this.delayMs * factor);
    this.timers.add(t);
  }

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`);
  }

  private save(): void {
    if (this.history) writeFileSync(this.file(this.history.id), JSON.stringify(this.history, null, 2));
  }
}
