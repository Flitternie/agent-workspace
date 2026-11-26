import { randomUUID } from 'node:crypto';
import { makeDiff, parseUnifiedHunks } from '../../shared/content';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelOption, ForkPoint, NativeSessionInfo, ProviderCapabilities } from '../../shared/types';
import type { Delivery, ApprovalResponse, ForkSessionOpts, ImageInput, ProviderAdapter, ProviderEvent, ProviderSession, StartArgs } from './types';

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
 *   capacity:<n>         the first <n> turns fail with "model at capacity", then it works
 */
interface MockHistory {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; text: string; itemId: string }>;
}

/** The demo's model list (shaped like a real CLI's). */
const MOCK_MODELS: ModelOption[] = [
  { id: 'mock-large', label: 'Mock Large', description: 'Most capable, for complex work', isDefault: true },
  { id: 'mock-fast', label: 'Mock Fast', description: 'Quick answers for everyday tasks' },
  { id: 'mock-mini', label: 'Mock Mini', description: 'Cheapest, for simple edits' },
];

export class MockAdapter implements ProviderAdapter {
  readonly provider = 'mock' as const;
  constructor(
    private dir: string,
    private delayMs = Number(process.env.AMW_MOCK_DELAY_MS ?? 900),
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async listModels(): Promise<ModelOption[]> {
    return MOCK_MODELS;
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

  async forkPoints(nativeSessionId: string): Promise<ForkPoint[]> {
    const { messages } = this.load(nativeSessionId);
    return messages.flatMap((m, i) => (i > 0 && m.role === 'user' ? [{ upToMessageId: messages[i - 1].itemId, prompt: m.text }] : []));
  }

  async forkSession(nativeSessionId: string, opts: ForkSessionOpts): Promise<string> {
    const source = this.load(nativeSessionId);
    const end = opts.upToMessageId ? source.messages.findIndex((m) => m.itemId === opts.upToMessageId) : source.messages.length - 1;
    if (end === -1) throw new Error(`Message ${opts.upToMessageId} is not in mock session ${nativeSessionId}.`);
    const id = `mock-${randomUUID()}`;
    // Fresh item ids, as Claude Code gives a fork fresh message UUIDs.
    const messages = source.messages.slice(0, end + 1).map((m, i) => ({ ...m, itemId: `${id}:${i}` }));
    const fork: MockHistory = { id, cwd: opts.targetCwd ?? opts.cwd, title: opts.title ?? `${source.title} (fork)`, updatedAt: new Date().toISOString(), messages };
    writeFileSync(sessionFile(this.dir, id), JSON.stringify(fork, null, 2));
    return id;
  }

  private load(id: string): MockHistory {
    const file = sessionFile(this.dir, id);
    if (!existsSync(file)) throw new Error(`Mock session ${id} not found.`);
    return JSON.parse(readFileSync(file, 'utf8')) as MockHistory;
  }
}

function sessionFile(dir: string, id: string): string {
  return join(dir, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`);
}

class MockSession implements ProviderSession {
  readonly provider = 'mock' as const;
  private history?: MockHistory;
  private pending = new Map<string, { kind: 'approval' | 'question'; command?: string }>();
  private closed = false;
  private busy = false;
  /** Messages that arrived mid-turn (steering). */
  private steered: string[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private capacityFailures = 0;

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
    this.emit({ type: 'model', model: this.args.model ?? MOCK_MODELS[0].id });
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

  async send(text: string, opts?: { interrupt?: boolean; images?: ImageInput[] }): Promise<Delivery> {
    if (this.closed || !this.history) throw new Error('Mock session is closed.');
    // Images are not looked at; the message notes how many came, so tests can see they arrived.
    if (opts?.images?.length) text = [text, `[${opts.images.length} image${opts.images.length === 1 ? '' : 's'}: ${opts.images.map((i) => i.mediaType).join(', ')}]`].filter(Boolean).join('\n');
    if (this.busy && !opts?.interrupt) {
      // Like Claude/Codex steering: noted now, acknowledged in this turn's reply.
      this.record('user', text);
      this.steered.push(text);
      return 'steer';
    }
    const delivery: Delivery = this.busy ? 'interrupt' : 'turn';
    if (this.busy) await this.interrupt();
    this.startTurn(text);
    return delivery;
  }

  private startTurn(text: string): void {
    if (!this.history) return;
    this.busy = true;
    const userTurns = this.history.messages.filter((m) => m.role === 'user').length;
    this.record('user', text);
    this.emit({ type: 'turnStarted' });
    const script = this.args.mockScript ?? 'work';
    const first = userTurns === 0;
    // What the work is: the task's title, or (an agent started without one) this message.
    const topic = this.args.title || text.replace(/\s+/g, ' ').trim().slice(0, 80);
    this.later(() => this.emit({ type: 'progress', text: this.zh ? `正在了解“${topic}”的上下文…` : `Reading ${topic} context…` }), 0.3);
    if (this.capacityFailures < Number(/^capacity:(\d+)$/.exec(script)?.[1] ?? 0)) {
      this.capacityFailures++;
      this.later(() => {
        this.busy = false;
        this.emit({ type: 'turnCompleted', status: 'failed', error: 'Selected model is at capacity. Please try a different model.', transient: 'capacity' });
      }, 0.5);
      return;
    }
    if (first && script.startsWith('approval:')) {
      const command = script.slice('approval:'.length);
      this.later(() => {
        const requestId = `mock-approval-${randomUUID()}`;
        this.pending.set(requestId, { kind: 'approval', command });
        this.emit({ type: 'transcriptItem', itemId: `${requestId}:tool`, role: 'tool', text: '', tool: { name: 'Bash', kind: 'execute', title: `$ ${command}`, locations: [], content: [{ type: 'terminal', command, output: '' }] } });
        this.emit({
          type: 'approvalRequested',
          requestId,
          headline: `Run command: ${command}`,
          details: `Bash\n${command}\ncwd: ${this.args.cwd}`,
          options: [
            { id: 'allow', label: 'Allow once', kind: 'allow_once' },
            { id: 'deny', label: 'Deny', kind: 'reject_once' },
          ],
          highRisk: /drop|rm |migrat|delete/i.test(command),
          toolCallId: `${requestId}:tool`,
          preview: [{ type: 'terminal', command, cwd: this.args.cwd, output: '' }],
        });
      }, 1);
      return;
    }
    // Many sub-agents ("swarm:30"): every fourth finishes, one fails, the rest keep working (a long turn).
    const swarm = /^swarm:(\d+)$/.exec(script);
    if (swarm) {
      const n = Math.min(Number(swarm[1]), 200);
      for (let i = 0; i < n; i++) {
        const id = `w${i}`;
        this.later(() => this.emit({ type: 'subtask', id, description: this.zh ? `检查第 ${i + 1} 个模块` : `Check module ${i + 1}`, step: this.zh ? `读 src/module-${i + 1}.ts` : `Reading src/module-${i + 1}.ts`, status: 'running' }), 1 + i * 0.05);
        if (i % 4 === 0) this.later(() => this.emit({ type: 'subtask', id, status: 'done', step: '', result: this.zh ? '没有问题。' : 'Looks fine.' }), 3 + i * 0.05);
        if (i === 1) this.later(() => this.emit({ type: 'subtask', id, status: 'failed', step: '', result: this.zh ? '测试没过。' : 'Tests failed.' }), 3);
      }
      this.later(() => {
        this.busy = false;
        this.emit({ type: 'turnCompleted', status: 'completed', finalText: this.zh ? '模块都查完了。' : 'All modules checked.' });
      }, 400);
      return;
    }
    // One sub-agent with a long run (50 steps and a long report): its page scrolls.
    if (script === 'subagent-long') {
      const zh = this.zh;
      this.later(() => this.emit({ type: 'subtask', id: 'l1', description: zh ? '逐个检查订单模块的调用方' : 'Check every caller of the orders module', step: zh ? '列出 src/ 下的文件' : 'Listing files in src/', status: 'running' }), 0.5);
      for (let i = 1; i < 50; i++)
        this.later(() => this.emit({ type: 'subtask', id: 'l1', step: zh ? `读 src/orders/caller-${i}.ts，第 ${i * 7} 行调用了 /v1/orders` : `Reading src/orders/caller-${i}.ts: line ${i * 7} calls /v1/orders` }), 0.5 + i * 0.03);
      const report = (zh ? '共检查 49 个文件，其中 31 处调用需要迁移到 v2。' : 'Checked 49 files; 31 calls need moving to v2. ').repeat(12);
      this.later(() => this.emit({ type: 'subtask', id: 'l1', status: 'done', step: '', result: report }), 2.5);
      this.later(() => this.finish(zh ? '子 agent 检查完了，结果见它的页面。' : 'The sub-agent is done; see its page.'), 3);
      return;
    }
    // Sub-agents: three helpers, one finishes, two keep working (a long turn, to look at).
    if (script === 'subagents') {
      const zh = this.zh;
      const sub = (id: string, description: string, step: string, at: number) =>
        this.later(() => this.emit({ type: 'subtask', id, description, step, status: 'running' }), at);
      sub('s1', zh ? '查找旧接口的调用方' : 'Find callers of the old API', zh ? '读 src/api/legacy.ts' : 'Reading src/api/legacy.ts', 1);
      sub('s2', zh ? '补充接口测试' : 'Add endpoint tests', zh ? '写 tests/orders.test.ts' : 'Writing tests/orders.test.ts', 1.5);
      sub('s3', zh ? '检查更新日志' : 'Check the changelog', zh ? '读 CHANGELOG.md' : 'Reading CHANGELOG.md', 2);
      this.later(() => this.emit({ type: 'subtask', id: 's3', step: zh ? '对照 v2 的接口变更' : 'Comparing with the v2 API changes' }), 3);
      this.later(
        () =>
          this.emit({
            type: 'subtask',
            id: 's3',
            status: 'done',
            step: '',
            result: zh ? '更新日志里 v2 只改了 /orders 的分页参数（page → cursor），其他接口不变。' : 'The changelog shows v2 only changes /orders pagination (page → cursor); other endpoints are unchanged.',
          }),
        4,
      );
      this.later(() => this.emit({ type: 'subtask', id: 's1', step: zh ? '搜索 /v1/orders' : 'Searching for /v1/orders' }), 5);
      this.later(() => this.emit({ type: 'subtask', id: 's1', step: zh ? '在 3 个文件里找到 7 处调用' : 'Found 7 calls in 3 files' }), 6);
      this.later(() => this.emit({ type: 'subtask', id: 's2', step: zh ? '运行 npm test -- orders' : 'Running npm test -- orders' }), 6.5);
      this.later(() => this.emit({ type: 'progress', text: zh ? '等两个子任务完成…' : 'Waiting on two sub-agents…' }), 5);
      // As Claude Code records them: one Task tool call per sub-agent in the transcript.
      for (const [id, description] of [
        ['s1', zh ? '查找旧接口的调用方' : 'Find callers of the old API'],
        ['s2', zh ? '补充接口测试' : 'Add endpoint tests'],
        ['s3', zh ? '检查更新日志' : 'Check the changelog'],
      ] as const)
        this.later(() => this.emit({ type: 'transcriptItem', itemId: `task-${id}-${userTurns}`, role: 'tool', text: '', toolStatus: 'completed', tool: { name: 'Task', kind: 'other', title: `Subagent: ${description}`, locations: [], content: [] } }), 0.8);
      this.later(() => {
        for (const id of ['s1', 's2']) this.emit({ type: 'subtask', id, status: 'done', step: '' });
        this.busy = false;
        this.emit({ type: 'turnCompleted', status: 'completed', finalText: zh ? '两个子任务都完成了。' : 'Both sub-agents are done.' });
      }, 400);
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
    // A memory update ahead of the message (saved notes changed since the session began): acknowledged
    // with its notes, so tests can see what reached the agent; the message is what follows it.
    const update = /^## Workspace memory update[\s\S]*?\n\n(?=[^-\s])/.exec(text);
    if (update) text = text.slice(update[0].length);
    const noted = update ? `Memory update received: ${update[0].split('\n').filter((l) => l.startsWith('- ')).join(' ')}\n\n` : '';
    this.later(() => {
      let reply: string;
      const memory = this.args.developerInstructions
        ? `Loaded workspace memory:\n${this.args.developerInstructions
            .split('\n')
            .filter((l) => l.startsWith('- '))
            .join('\n')}\n\n`
        : '';
      if (first && script.startsWith('ask:')) {
        reply = this.zh ? `我看了一下“${topic}”。\n\n${script.slice('ask:'.length)}` : `I looked into "${topic}".\n\n${script.slice('ask:'.length)}`;
      } else if (first) {
        this.emitDemoWork();
        // Rich Markdown, as real agents write it: heading, list, task list, table, code.
        reply = this.zh
          ? [
              `“${topic}”第一轮完成：5 个组件做好了 3 个，继续推进。`,
              '',
              '### 改了什么',
              '- `OrderCard` 和 `OrderList` 已改用 **v2** 字段',
              '- 金额统一在一个地方计算：见 [orders.ts](https://example.com/orders)',
              '',
              '- [x] 卡片',
              '- [ ] 图表',
              '',
              '| 组件 | 状态 |',
              '| --- | --- |',
              '| OrderCard | 完成 |',
              '| RevenueChart | 待做 |',
              '',
              '```ts',
              'export const total = (o: Order) => o.items.reduce((sum, i) => sum + i.price, 0);',
              '```',
            ].join('\n')
          : [
          `Done with the first pass on "${topic}". Components 3/5 built; continuing.`,
          '',
          '### What changed',
          '- `OrderCard` and `OrderList` now render the **v2** fields',
          '- Totals are computed in one place: see [orders.ts](https://example.com/orders)',
          '',
          '- [x] Cards',
          '- [ ] Charts',
          '',
          '| Component | Status |',
          '| --- | --- |',
          '| OrderCard | done |',
          '| RevenueChart | todo |',
          '',
          '```ts',
          'export const total = (o: Order) => o.items.reduce((sum, i) => sum + i.price, 0);',
          '```',
        ].join('\n');
      } else {
        // "edit <path>": an applied edit of that file (tests of the changes list and Follow).
        const edit = /^edit (\S+)/.exec(text.trim());
        if (edit)
          this.emit({
            type: 'transcriptItem',
            itemId: `${randomUUID()}:edit`,
            role: 'tool',
            text: '',
            toolStatus: 'completed',
            tool: {
              name: 'Edit',
              kind: 'edit',
              title: `Edit ${edit[1]}`,
              locations: [{ path: edit[1], line: 2 }],
              content: [{ type: 'diff', diff: makeDiff({ path: edit[1], operation: 'modify', phase: 'applied', hunks: parseUnifiedHunks(`@@ -1,1 +1,2 @@\n # ${edit[1]}\n+Edited in request ${userTurns + 1}.\n`) }) }],
            },
          });
        // A short, plausible report. The request number comes from the saved history,
        // so after a resume it shows the mock really kept its earlier conversation.
        const said = text.length > 120 ? `${text.slice(0, 117)}…` : text;
        reply = this.zh
          ? userTurns % 2 === 0
            ? `已完成：“${said}”。改动在我的 worktree 里。（本次会话第 ${userTurns + 1} 个请求）`
            : `收到：“${said}”。要不要顺便加个测试？（本次会话第 ${userTurns + 1} 个请求）`
          : userTurns % 2 === 0
            ? `Done: “${said}”. Changes are in my worktree. (Request ${userTurns + 1} in this session.)`
            : `On it: “${said}”. Want me to add a test for this as well? (Request ${userTurns + 1} in this session.)`;
      }
      this.finish((first ? memory : '') + noted + reply);
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

  /** Stands in for Claude Code's Remote Control in tests: `rc-fail` in the script refuses, as a key login would. */
  async setRemoteControl(on: boolean): Promise<{ url?: string }> {
    if (on && (this.args.mockScript ?? '').includes('rc-fail')) throw new Error('Remote Control requires a claude.ai subscription; API keys are not supported.');
    return { url: on ? `https://claude.ai/code/session_mock${this.args.title ? '_' + this.args.title.replace(/\W+/g, '') : ''}` : undefined };
  }

  /** Side questions in tests: an answer that shows the question and how many earlier ones it saw. */
  async askSide(question: string, history: Array<{ question: string; response: string }>): Promise<string> {
    await new Promise((r) => setTimeout(r, Math.min(400, Number(process.env.AMW_MOCK_DELAY_MS ?? 200) * 2)));
    if (question.includes('fail')) throw new Error('The side question could not be answered.');
    return `Side answer to "${question}" (saw ${history.length} earlier side question${history.length === 1 ? '' : 's'}; main turn ${this.busy ? 'still running' : 'idle'}).`;
  }

  async setModel(model: string | undefined): Promise<void> {
    this.args.model = model;
    this.emit({ type: 'model', model: model ?? MOCK_MODELS[0].id });
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

  /** Demo tasks seeded in a Chinese workspace speak Chinese. */
  private get zh(): boolean {
    return /[\u4e00-\u9fff]/.test(this.args.title);
  }

  /** Structured activity in the same normalized shape real providers produce. */
  private emitDemoWork(): void {
    const id = `${this.history?.id ?? 'mock'}-${Date.now()}`;
    this.emit({
      type: 'planUpdated',
      entries: [
        { content: this.zh ? '阅读现有的看板布局' : 'Read the existing dashboard layout', status: 'completed' },
        { content: this.zh ? '实现 OrdersTable 和 RevenueCard' : 'Build OrdersTable and RevenueCard', status: 'completed' },
        { content: this.zh ? '把组件接到 v2 接口' : 'Wire components to the v2 API', status: 'in_progress' },
        { content: this.zh ? '补组件测试' : 'Add component tests', status: 'pending' },
      ],
    });
    this.emit({
      type: 'transcriptItem',
      itemId: `${id}:read`,
      role: 'tool',
      text: '',
      toolStatus: 'completed',
      tool: { name: 'Read', kind: 'read', title: 'Read src/orders.ts', locations: [{ path: 'src/orders.ts' }], content: [] },
    });
    this.emit({
      type: 'transcriptItem',
      itemId: `${id}:edit`,
      role: 'tool',
      text: '',
      toolStatus: 'completed',
      tool: {
        name: 'Edit',
        kind: 'edit',
        title: 'Edit src/orders.ts',
        locations: [{ path: 'src/orders.ts', line: 1 }],
        content: [
          {
            type: 'diff',
            diff: makeDiff({
              path: 'src/orders.ts',
              operation: 'modify',
              phase: 'applied',
              hunks: parseUnifiedHunks(
                '@@ -1,3 +1,6 @@\n-export function listOrders() {\n-  return [];\n+import { api } from \'./api\';\n+\n+export async function listOrders(page = 1) {\n+  const res = await api.get(`/v2/orders?page=${page}`);\n+  return res.items;\n }\n',
              ),
            }),
          },
        ],
      },
    });
    // A document row, so the demo shows the file preview (the README exists in every demo worktree).
    this.emit({
      type: 'transcriptItem',
      itemId: `${id}:docs`,
      role: 'tool',
      text: '',
      toolStatus: 'completed',
      tool: {
        name: 'Edit',
        kind: 'edit',
        title: 'Edit README.md',
        locations: [{ path: 'README.md', line: 3 }],
        content: [
          {
            type: 'diff',
            diff: makeDiff({ path: 'README.md', operation: 'modify', phase: 'applied', hunks: parseUnifiedHunks('@@ -3,1 +3,3 @@\n A tiny demo repository for Agent Workspace.\n+\n+The dashboard reads orders from the v2 API.\n') }),
          },
        ],
      },
    });
    this.emit({
      type: 'transcriptItem',
      itemId: `${id}:test`,
      role: 'tool',
      text: '',
      toolStatus: 'completed',
      tool: {
        name: 'Bash',
        kind: 'execute',
        title: '$ npm test -- orders',
        locations: [],
        content: [{ type: 'terminal', command: 'npm test -- orders', output: ' ✓ listOrders returns v2 items (4 ms)\n ✓ listOrders paginates (2 ms)\n\nTests: 2 passed, 2 total', exitCode: 0 }],
      },
    });
  }

  private finish(reply: string): void {
    if (this.steered.length) reply = `${reply}\n\nAlso noted while working: ${this.steered.map((s) => `"${s.slice(0, 120)}"`).join(', ')}.`;
    this.steered = [];
    this.record('assistant', reply);
    this.busy = false;
    this.emitUsage();
    this.emit({ type: 'turnCompleted', status: 'completed', finalText: reply });
    // Like Claude Code's prompt suggestions: a guess at the user's next message, after the turn.
    this.emit({ type: 'suggestion', text: this.zh ? '继续，并跑一下测试' : 'Keep going and run the tests' });
  }

  /**
   * Like Claude Code at the end of a turn: fixed token counts for it (35K, 88% read from the cache,
   * $0.12 at API prices), the context growing with the conversation, and the account's limits
   * (`limits-high` in the script: nearly used up).
   */
  private emitUsage(): void {
    const turns = this.history?.messages.filter((m) => m.role === 'user').length ?? 1;
    this.emit({ type: 'usage', add: { input: 1200, cacheWrite: 3000, cacheRead: 30000, output: 800, costUsd: 0.12 }, context: 20000 + turns * 4700, contextWindow: 1_000_000 });
    const high = (this.args.mockScript ?? '').includes('limits-high');
    const at = Date.now();
    this.emit({
      type: 'limits',
      windows: [
        { key: 'five_hour', mins: 300, usedPercent: high ? 86 : 34, resetsAt: at + 2 * 3600_000 },
        { key: 'seven_day', mins: 10080, usedPercent: 35, resetsAt: at + 3 * 86400_000 },
      ],
    });
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
    return sessionFile(this.dir, id);
  }

  private save(): void {
    if (this.history) writeFileSync(this.file(this.history.id), JSON.stringify(this.history, null, 2));
  }
}
