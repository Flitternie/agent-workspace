// Real-CLI smoke test for sub-agents: asks Claude Code / Codex to fan out to a few sub-agents in a
// throwaway repo, and prints the raw sub-agent messages next to the `subtask` events we emit.
// Uses the user's installed CLIs and their existing login; a few short model calls.
//   node out/smoke/subtasks.cjs [claude|codex|all]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../main/providers/claude';
import { CodexAdapter } from '../main/providers/codex';
import type { ProviderAdapter, ProviderEvent, ProviderSession } from '../main/providers/types';

const which = process.argv[2] ?? 'all';
type Rec = Record<string, unknown>;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amw-smoke-sub-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'alpha.txt'), 'Alpha: the billing service retries failed charges three times.\n');
  writeFileSync(join(dir, 'beta.txt'), 'Beta: invoices are emailed on the first business day of the month.\n');
  writeFileSync(join(dir, 'gamma.txt'), 'Gamma: refunds over $500 need a manager approval.\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=smoke', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

const clip = (v: unknown, n = 260) => {
  const s = JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** What a raw message says about sub-agents, or undefined when it is not about them. */
function claudeRaw(m: Rec): string | undefined {
  if (m.type === 'system' && String(m.subtype).startsWith('task_')) {
    const { uuid: _u, session_id: _s, ...rest } = m;
    return `system ${clip(rest)}`;
  }
  if (m.parent_tool_use_id) {
    const blocks = (m.message as Rec | undefined)?.content;
    const kinds = Array.isArray(blocks) ? blocks.map((b) => `${(b as Rec).type}${(b as Rec).name ? `:${(b as Rec).name}` : ''}`).join(',') : typeof blocks;
    const handback = Array.isArray(blocks) ? (blocks as Rec[]).find((b) => b.name === 'SubagentHandback') : undefined;
    return `inner(${String(m.parent_tool_use_id).slice(-8)}) ${m.type} [${kinds}]${handback ? ` input=${clip(handback.input, 400)}` : ''}`;
  }
  const blocks = (m.message as Rec | undefined)?.content;
  if (Array.isArray(blocks))
    for (const b of blocks as Rec[]) {
      if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) return `main tool_use ${b.name} ${String(b.id).slice(-8)} ${clip(b.input, 160)}`;
      if (b.type === 'tool_result') return undefined;
    }
  return undefined;
}

function codexRaw(method: string, p: Rec, main: string | undefined): string | undefined {
  const item = (p.item ?? {}) as Rec;
  if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') return `${method} ${clip(item, 400)}`;
  if (p.threadId && main && p.threadId !== main) return `other-thread(${String(p.threadId).slice(-8)}) ${method} ${item.type ?? ''}`;
  return undefined;
}

async function scenario(adapter: ProviderAdapter, prompt: string): Promise<void> {
  console.log(`\n=== ${adapter.provider}`);
  const cwd = makeRepo();
  console.log('repo', cwd);
  const subtasks: ProviderEvent[] = [];
  let done!: (e: ProviderEvent) => void;
  const finished = new Promise<ProviderEvent>((r) => (done = r));
  let session!: ProviderSession;
  const push = (e: ProviderEvent) => {
    if (e.type === 'subtask') {
      subtasks.push(e);
      console.log('   EVENT', clip(e, 200));
    }
    if (e.type === 'approvalRequested') {
      console.log('   approval →', e.headline);
      void session.respond(e.requestId, { decision: e.options.find((o) => /allow|accept|approve/.test(o.id))?.id ?? 'allow' });
    }
    if (e.type === 'turnStarted' || e.type === 'turnCompleted') console.log('   TURN', e.type, e.type === 'turnCompleted' ? `${e.status} — ${String(e.finalText).slice(0, 120)}` : '');
    if (e.type === 'turnCompleted') done(e);
  };
  session = adapter.createSession({ cwd, title: 'sub-agent smoke', permissionMode: 'auto' }, push);
  // Tap the raw stream (private methods, looked up per call).
  const s = session as unknown as Rec;
  if (adapter.provider === 'claude') {
    const receive = (s.receive as (v: unknown, h: boolean) => void).bind(session);
    s.receive = (v: unknown, h: boolean) => {
      const line = h ? undefined : claudeRaw((v ?? {}) as Rec);
      if (line) console.log('   raw', line);
      receive(v, h);
    };
  } else {
    const notification = (s.notification as (m: string, p: Rec) => void).bind(session);
    s.notification = (m: string, p: Rec) => {
      const line = codexRaw(m, p ?? {}, s.threadId as string | undefined);
      if (line) console.log('   raw', line);
      notification(m, p);
    };
  }
  await session.start();
  await session.send(prompt);
  const end = (await Promise.race([finished, new Promise<null>((r) => setTimeout(() => r(null), 420_000))])) as Extract<ProviderEvent, { type: 'turnCompleted' }> | null;
  console.log('turn:', end ? `${end.status} — ${String(end.finalText).slice(0, 200)}` : 'TIMEOUT');
  // Background sub-agents outlive the turn: keep listening until every one has ended (or 4 minutes).
  const ended = () => {
    const st = new Map<string, string>();
    for (const e of subtasks) if (e.type === 'subtask' && e.status) st.set(e.id, e.status);
    return st.size > 0 && [...st.values()].every((x) => x !== 'running');
  };
  const until = Date.now() + 240_000;
  while (!ended() && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
  console.log(ended() ? 'all sub-agents ended' : 'sub-agents still running after 4 min');
  await new Promise((r) => setTimeout(r, 30_000)); // the follow-up turn that reports them, if any
  // What the workspace would hold, folded the way handleEvent folds them.
  const list = new Map<string, Rec>();
  for (const e of subtasks) {
    if (e.type !== 'subtask') continue;
    const cur = list.get(e.id) ?? { id: e.id, steps: 0 };
    if (e.description) cur.description = e.description;
    if (e.status) cur.status = e.status;
    if (e.step) cur.steps = (cur.steps as number) + 1;
    if (e.result) cur.result = e.result.slice(0, 80);
    list.set(e.id, cur);
  }
  console.log(`SUMMARY ${adapter.provider}: ${list.size} sub-agents`);
  for (const v of list.values()) console.log('  ', clip(v, 240));
  await session.close().catch(() => {});
}

const PROMPT =
  'Use three sub-agents in parallel, one per file (alpha.txt, beta.txt, gamma.txt). Each sub-agent reads its one file and reports its single sentence back. Start all three at once, wait for all of them, then reply with the three sentences. Do not read the files yourself.';

async function main(): Promise<void> {
  if (which === 'claude' || which === 'all') await scenario(new ClaudeAdapter(), PROMPT).catch((e) => console.log('claude failed', e));
  if (which === 'codex' || which === 'all') await scenario(new CodexAdapter(), PROMPT.replace('sub-agents', 'sub-agents (spawn_agent)')).catch((e) => console.log('codex failed', e));
  process.exit(0);
}
void main();
