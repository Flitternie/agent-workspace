// Real-CLI check that both adapters emit the same structured content
// (plans, diffs, terminal output, approval previews). Approves everything the
// agent asks for, inside a throwaway repo under app/.cache.
//   npm run smoke:content [claude|codex|all]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ClaudeAdapter } from '../main/providers/claude';
import { CodexAdapter } from '../main/providers/codex';
import type { ProviderAdapter, ProviderEvent } from '../main/providers/types';
import type { ToolCallInfo, ToolContent } from '../shared/content';

const which = process.argv[2] ?? 'all';
const root = process.env.AMW_SMOKE_DIR ?? resolve(__dirname, '../../.cache');

const PROMPT = process.env.AMW_CONTENT_PROMPT ?? [
  'This is a test of tool reporting. Do exactly these steps, in order, then stop:',
  '1. Record a two-step plan/todo list with your planning tool (steps: "create notes", "edit notes").',
  '2. Create the file notes.txt containing three lines: alpha, beta, delta.',
  '3. Edit notes.txt to change the line beta to gamma (a targeted edit, not a rewrite).',
  '4. Run the shell command: cat notes.txt',
  '5. Mark both plan steps completed, then reply DONE.',
].join('\n');

function makeRepo(): string {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'amw-content-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# content smoke\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=smoke', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function describe(c: ToolContent): string {
  if (c.type === 'diff') return `diff(${c.diff.phase} ${c.diff.operation} ${c.diff.path} +${c.diff.added}/-${c.diff.removed}${c.diff.snippet ? ' snippet' : ''})`;
  if (c.type === 'terminal') return `terminal($ ${c.command.slice(0, 50)} → ${JSON.stringify(c.output.slice(0, 40))}${c.exitCode !== undefined ? ` exit ${c.exitCode}` : ''})`;
  if (c.type === 'search') return `search(${c.query} ${c.files.length} files)`;
  if (c.type === 'fetch') return `fetch(${c.url ?? c.query})`;
  return `text(${c.text.slice(0, 40)})`;
}

async function scenario(adapter: ProviderAdapter): Promise<boolean> {
  console.log(`\n=== ${adapter.provider}`);
  const cwd = makeRepo();
  const tools = new Map<string, { tool: Partial<ToolCallInfo>; status?: string }>();
  let plans = 0;
  let lastPlan = '';
  const previews: string[] = [];
  let done!: (e: Extract<ProviderEvent, { type: 'turnCompleted' }>) => void;
  const finished = new Promise<Extract<ProviderEvent, { type: 'turnCompleted' }>>((r) => (done = r));
  const session = adapter.createSession({ cwd, title: 'content smoke' }, (e) => {
    if (e.type === 'transcriptItem' && e.role === 'tool') {
      const prev = tools.get(e.itemId) ?? { tool: {} };
      tools.set(e.itemId, { tool: { ...prev.tool, ...Object.fromEntries(Object.entries(e.tool ?? {}).filter(([, v]) => v !== undefined)) }, status: e.toolStatus ?? prev.status });
    }
    if (e.type === 'planUpdated') {
      plans++;
      lastPlan = e.entries.map((x) => `${x.status}:${x.content}`).join(' | ');
    }
    if (e.type === 'approvalRequested') {
      previews.push(`${e.headline} → [${(e.preview ?? []).map(describe).join(', ')}] linked=${!!e.toolCallId}`);
      const allow = e.options.find((o) => o.kind === 'allow_once') ?? e.options[0];
      void session.respond(e.requestId, { decision: allow.id });
    }
    if (e.type === 'userInputRequested') void session.respond(e.requestId, { decision: 'deny' });
    if (e.type === 'turnCompleted') done(e);
  });
  await session.start();
  await session.send(PROMPT);
  const end = await Promise.race([finished, new Promise<null>((r) => setTimeout(() => r(null), 300_000))]);
  await session.close();

  console.log('turn:', end?.status, '|', end?.finalText?.slice(0, 80));
  console.log('approvals:', previews.length ? '' : 'none');
  for (const p of previews) console.log('  ', p);
  console.log('plan updates:', plans, lastPlan);
  console.log('tool calls:');
  for (const [, t] of tools) console.log(`   [${t.tool.kind}] ${t.tool.title} (${t.status}) ${(t.tool.content ?? []).map(describe).join(', ')}`);
  let file = '';
  try {
    file = readFileSync(join(cwd, 'notes.txt'), 'utf8');
  } catch {
    /* missing */
  }
  const contents = [...tools.values()].flatMap((t) => t.tool.content ?? []);
  const checks = {
    'file edited on disk': /alpha\s+gamma\s+delta/.test(file),
    'applied diff reported': contents.some((c) => c.type === 'diff' && c.diff.phase === 'applied' && c.diff.added > 0),
    'edit diff shows beta→gamma': contents.some((c) => c.type === 'diff' && c.diff.hunks.some((h) => h.lines.includes('-beta') && h.lines.includes('+gamma'))),
    'terminal output captured': contents.some((c) => c.type === 'terminal' && /gamma/.test(c.output)),
    'plan published': plans > 0,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`   ${v ? 'OK ' : 'XX '} ${k}`);
  return Object.values(checks).every(Boolean);
}

(async () => {
  const adapters: ProviderAdapter[] = [];
  if (which === 'claude' || which === 'all') adapters.push(new ClaudeAdapter());
  if (which === 'codex' || which === 'all') adapters.push(new CodexAdapter());
  for (const a of adapters) {
    try {
      if (!(await scenario(a))) process.exitCode = 1;
    } catch (error) {
      console.error(`!! ${a.provider} content smoke failed:`, error);
      process.exitCode = 1;
    }
  }
  setTimeout(() => process.exit(), 500);
})();
