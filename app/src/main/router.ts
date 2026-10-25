import type { RouteDecision } from '../shared/types';

// Voice / coordinator routing. Deterministic rules first (spec 05 §1 "Routing order
// for MVP"); an optional LLM classifier only for what the rules cannot decide, and
// its answers are never trusted enough to auto-send (capped at 'medium').

export interface RouteTask {
  taskId: string;
  alias: string;
  name: string;
  title: string;
  projectId: string;
  projectName: string;
  provider: string;
  status: string;
  summary: string;
  pending: string[];
}

export interface RouteProject {
  projectId: string;
  name: string;
}

export interface RouteContext {
  utterance: string;
  focusedTaskId: string | null;
  tasks: RouteTask[];
  projects: RouteProject[];
}

export interface LlmRouteAnswer {
  target: string; // alias | 'NEW' | 'COORDINATOR' | 'UNSURE'
  candidates: string[];
  reason: string;
}

export type LlmRouter = (ctx: RouteContext) => Promise<LlmRouteAnswer | null>;

const STOP = new Set(
  'the a an to and or of for in on at is are be it this that these those with from by as please can you could would should will just now then also agent task tell ask make let me my our we i not dont don do does did fix add use run'.split(
    ' ',
  ),
);

/** Cross-language synonym groups for common coding-task vocabulary. */
const SYNONYMS: string[][] = [
  ['database', 'db', 'schema', 'migration', 'sql', 'postgres', '数据', '据库', '数据库', '表结构', '迁移'],
  ['frontend', 'ui', 'component', 'components', 'react', 'css', 'dashboard', '前端', '界面', '页面', '组件'],
  ['backend', 'api', 'server', 'endpoint', 'endpoints', '后端', '接口', '服务端'],
  ['test', 'tests', 'testing', 'spec', 'regression', '测试', '用例'],
  ['docs', 'documentation', 'readme', '文档'],
  ['auth', 'login', 'authentication', '登录', '认证'],
  ['experiment', 'experiments', 'benchmark', '实验'],
];

const CJK = /[㐀-鿿]/;

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z][a-z0-9_-]{1,}/g) ?? []) if (!STOP.has(w) && w.length >= 2) out.add(w);
  const cjk = lower.match(/[㐀-鿿]+/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
    if (run.length >= 3) for (let i = 0; i + 2 < run.length; i++) out.add(run.slice(i, i + 3));
  }
  for (const group of SYNONYMS) if (group.some((g) => out.has(g))) for (const g of group) out.add(`#${group[0]}`);
  return out;
}

const DEICTIC = /这个|这里|这段|这块|当前|現在這|this (function|file|change|code|one|test|bug|error|output|diff)|\bhere\b|\bit\b|这一步|上面/i;
const REFERENCE = /那个|刚才|刚刚|之前那|the .{1,30}? (agent|task|one)|that .{1,30}? (agent|task)/i;
const NEW_TASK =
  /(开|新建|创建|起|启动)(一个|个)?(新的?)?.{0,12}(任务|agent|代理|会话|session|claude|codex)|\bnew (task|agent|session)\b|\bstart (a )?new\b|\bspin up\b|\bcreate (a )?(new )?(task|agent)\b/i;
const COORDINATOR =
  /^(status|状态)|(大家|所有|全部|哪些|有谁|谁).{0,10}(状态|在等|等待|进度)|\b(list|show) (all|the)? ?(tasks|agents|pending)\b|\bwhat('?s| is) (pending|waiting)\b|\bsummar(ize|y) (all|the workspace|pending)\b|总结一下(所有|全部)/i;
const MEMORY = /^(记住|请记住|保存|remember|save (this|that)? ?(as|to)?)/i;
const SENSITIVE = /\b(delete|drop|rm -rf|truncate|force[- ]push|reset --hard|migrat\w*|deploy\w*|publish\w*)\b|删除|删掉|清空|迁移|部署|发布|强推/i;

function explicitTargets(ctx: RouteContext): RouteTask[] {
  const u = ctx.utterance;
  const hits = new Map<string, RouteTask>();
  for (const t of ctx.tasks) {
    const a = t.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Named agents ("Alice", "小王"): the name anywhere is a handle.
    if (CJK.test(t.alias) ? u.includes(t.alias) : t.alias.length > 2 && new RegExp(`\\b${a}\\b`, 'i').test(u)) hits.set(t.taskId, t);
    // Letter aliases from older workspaces ("Agent A", "A号", "@A").
    const patterns = [
      new RegExp(`\\b(agent|task|代理|助手)\\s*${a}\\b`, 'i'),
      new RegExp(`(^|[^A-Za-z])${a}\\s*(agent|号|代理)`), // case-sensitive: "A agent", "A号"
      new RegExp(`(^|[^A-Za-z])@${a}\\b`, 'i'),
      new RegExp(`(给|让|叫|告诉)\\s*${a}(?![A-Za-z])`),
    ];
    if (patterns.some((p) => p.test(u))) hits.set(t.taskId, t);
    const name = t.name.trim();
    if (name.length >= 3 && name.toLowerCase() !== t.alias.toLowerCase()) {
      const re = CJK.test(name)
        ? new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        : new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*(agent|task|代理)?`, 'i');
      // A custom name counts as explicit only when used as a handle ("database agent", "@database").
      const handle = CJK.test(name)
        ? re.test(u)
        : new RegExp(`(@${name}\\b|\\b${name}\\s+(agent|task)\\b|\\b(agent|task)\\s+${name}\\b)`, 'i').test(u);
      if (handle) hits.set(t.taskId, t);
    }
  }
  return [...hits.values()];
}

function score(task: RouteTask, utter: Set<string>): number {
  const strong = tokens(`${task.title} ${task.name} ${task.projectName}`);
  const weak = tokens(`${task.summary} ${task.pending.join(' ')}`);
  let s = 0;
  for (const t of utter) {
    if (strong.has(t)) s += t.startsWith('#') ? 2 : 2;
    else if (weak.has(t)) s += 1;
  }
  return s;
}

function sensitive(decision: RouteDecision, utterance: string): RouteDecision {
  if (decision.kind === 'existing' && decision.confidence === 'high' && SENSITIVE.test(utterance))
    return { ...decision, confidence: 'medium', reason: `${decision.reason}; sensitive command — confirm before sending` };
  return decision;
}

export function decideDeterministic(ctx: RouteContext): RouteDecision | null {
  const u = ctx.utterance.trim();
  const focused = ctx.tasks.find((t) => t.taskId === ctx.focusedTaskId) ?? null;

  // 1. Explicit alias / handle.
  const explicit = explicitTargets(ctx);
  if (explicit.length === 1)
    return sensitive({ kind: 'existing', taskId: explicit[0].taskId, confidence: 'high', reason: `explicitly named ${explicit[0].alias}` }, u);
  if (explicit.length > 1)
    return {
      kind: 'clarify',
      candidateTaskIds: explicit.map((t) => t.taskId),
      question: `You named several agents (${explicit.map((t) => t.alias).join(', ')}). Which one should receive this?`,
    };

  // 2. Explicit new-task instruction.
  if (NEW_TASK.test(u)) {
    const provider = /codex/i.test(u) ? 'codex' : /claude/i.test(u) ? 'claude' : undefined;
    const utter = tokens(u);
    const projectHits = ctx.projects.filter((p) => [...tokens(p.name)].some((t) => utter.has(t)) || u.toLowerCase().includes(p.name.toLowerCase()));
    const projectId =
      projectHits.length === 1 ? projectHits[0].projectId : focused?.projectId ?? (ctx.projects.length === 1 ? ctx.projects[0].projectId : undefined);
    return {
      kind: 'create',
      proposedTitle: u.replace(NEW_TASK, '').replace(/^[\s,，:：帮我给]+/, '').trim() || u,
      projectId,
      provider,
      reason: 'explicit request for a new task',
    };
  }

  // 6 (checked early). Workspace / memory commands go to the coordinator, not a worker.
  if (MEMORY.test(u)) return { kind: 'coordinator', reason: 'save to scoped memory' };
  if (COORDINATOR.test(u)) return { kind: 'coordinator', reason: 'workspace status question' };

  // 3. Strong semantic reference to exactly one task overrides focus.
  const utter = tokens(u);
  const scored = ctx.tasks.map((t) => ({ t, s: score(t, utter) })).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s);
  if (scored.length) {
    const top = scored[0];
    const close = scored.filter((x) => x.s >= top.s * 0.6);
    if (close.length === 1) {
      const isFocused = top.t.taskId === focused?.taskId;
      const high = top.s >= 4 || REFERENCE.test(u) || isFocused;
      return sensitive(
        {
          kind: 'existing',
          taskId: top.t.taskId,
          confidence: high ? 'high' : 'medium',
          reason: isFocused ? `matches the focused task "${top.t.title}"` : `refers to "${top.t.title}" (${top.t.alias})`,
        },
        u,
      );
    }
    // 5. Several plausible tasks: ask before sending anything.
    return {
      kind: 'clarify',
      candidateTaskIds: close.map((x) => x.t.taskId),
      question: `This could be for ${close.map((x) => `${x.t.alias} (${x.t.title})`).join(' or ')}. Which one?`,
    };
  }

  // 4. Deictic local reference defaults to the focused task.
  if (focused && DEICTIC.test(u))
    return sensitive({ kind: 'existing', taskId: focused.taskId, confidence: 'high', reason: `"this/这个" refers to the focused agent ${focused.alias}`, context: true }, u);
  return null;
}

/** Full routing: deterministic rules, then the optional LLM, then a safe fallback. */
export async function decideRoute(ctx: RouteContext, llm?: LlmRouter): Promise<RouteDecision> {
  const d = decideDeterministic(ctx);
  if (d) return d;
  const focused = ctx.tasks.find((t) => t.taskId === ctx.focusedTaskId) ?? null;
  if (llm && ctx.tasks.length) {
    try {
      const a = await llm(ctx);
      if (a) {
        const byAlias = (alias: string) => ctx.tasks.find((t) => t.alias.toLowerCase() === alias.toLowerCase());
        if (a.target === 'COORDINATOR') return { kind: 'coordinator', reason: `classifier: ${a.reason}` };
        if (a.target === 'NEW')
          return { kind: 'create', proposedTitle: ctx.utterance, projectId: focused?.projectId, reason: `classifier: ${a.reason}` };
        const target = byAlias(a.target);
        if (target) return { kind: 'existing', taskId: target.taskId, confidence: 'medium', reason: `classifier: ${a.reason}` };
        const candidates = a.candidates.map(byAlias).filter((t): t is RouteTask => !!t);
        if (candidates.length)
          return {
            kind: 'clarify',
            candidateTaskIds: candidates.map((t) => t.taskId),
            question: `Not sure who this is for (${a.reason}). Pick a target.`,
          };
      }
    } catch {
      /* classifier unavailable: fall through to the safe default */
    }
  }
  if (focused)
    return sensitive({ kind: 'existing', taskId: focused.taskId, confidence: 'medium', reason: `no other task referenced; defaulting to focused agent ${focused.alias}`, context: true }, ctx.utterance);
  if (ctx.tasks.length === 0) return { kind: 'coordinator', reason: 'no tasks yet' };
  return {
    kind: 'clarify',
    candidateTaskIds: ctx.tasks.map((t) => t.taskId),
    question: 'Which agent is this for?',
  };
}
