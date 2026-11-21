// The research tree managed through conversation: tools for the agents of a project's research (and
// the main agent), so what the user says becomes aspects, methods, experiments and results. Each call
// checks who is calling: the main agent may do anything; an aspect's agent works within its aspect;
// an experiment's agent records its own result. The page only shows the tree.
import { z } from 'zod';
import type { Task } from '../shared/types';
import {
  addFinding,
  addNode,
  aspectOf,
  bestExperiment,
  childrenOf,
  contributions,
  formatValue,
  judge,
  methodStatus,
  removeNode,
  resultsSince,
  routeFor,
  runStats,
  DEFAULT_MODE,
  type ResearchMode,
  updateNode,
  type ResearchDoc,
  type ResearchNode,
  type ResearchNotes,
} from '../shared/research';
import type { WorkspaceTool } from './main-agent';

/** What the tools need from the workspace (implemented by Workspace). */
export interface ResearchHost {
  researchProjects(): Array<{ projectId: string; name: string }>;
  allProjects(): Array<{ projectId: string; name: string }>;
  researchGet(projectId: string): ResearchDoc | null;
  researchSave(projectId: string, doc: ResearchDoc): ResearchDoc;
  researchCreate(projectId: string, title: string, goal: string, sample: boolean): Promise<ResearchDoc>;
  /** Starts an agent for a node (an aspect's, or an experiment's in its own worktree), briefed, and links it. */
  researchStartAgent(projectId: string, nodeId: string, opts: { isolate: boolean; message?: string }): Promise<Task>;
  findTaskById(taskId: string): Task | undefined;
  researchNotes(projectId: string): ResearchNotes;
  /** Resolves when the research can be read as it is now (pending writes done; fetched from an SSH host). */
  researchReady(projectId: string): Promise<void>;
  researchWriteNote(projectId: string, scope: string, text: string): void;
  /** An agent by its name or role (as the main agent's tools find them). */
  findAgent(name: string): Task | undefined;
  language(): 'en' | 'zh';
}

export type ResearchCaller = { kind: 'main' } | { kind: 'agent'; taskId: string };

// ------------------------------------------------------------------ briefs (what a new agent is told)

/** How much to ask the user, as this research's policy says (the user's call). */
export function modeText(mode: ResearchMode | undefined, lang: 'en' | 'zh'): string {
  const zh = lang === 'zh';
  switch (mode ?? DEFAULT_MODE) {
    case 'auto':
      return zh ? '研究方式：自主推进。在预算内自己开实验，开了什么告诉用户。' : 'How this research runs: on its own. Start experiments yourself within the budget and say what you started.';
    case 'direction':
      return zh ? '研究方式：问方向。要开一个新方向前先问用户往哪走；方向定了之后自己推进。' : 'How this research runs: ask for direction. Before exploring a new direction, ask the user which way to go; within a chosen one, go ahead.';
    case 'collaborative':
      return zh ? '研究方式：协作。开新方向前问用户，开实验前也等用户同意。' : 'How this research runs: collaboratively. Ask before a new direction, and wait for the user to agree before starting experiments.';
    default:
      return zh ? '研究方式：先审。先提出要做的实验，用户同意后再开。' : 'How this research runs: review first. Propose experiments and start them when the user agrees.';
  }
}

/** A note shortened for a brief: the start, where the current state is written. */
const excerpt = (text: string | undefined, n = 1800) => (text ? (text.length > n ? `${text.slice(0, n)}\n…` : text).trim() : '');

/** The research's lead: the user talks to it about the whole research, and lays the tree out with it step by step. */
export function leadBrief(doc: ResearchDoc, lang: 'en' | 'zh', message?: string, notes?: ResearchNotes): string {
  const zh = lang === 'zh';
  const empty = !doc.nodes.length;
  return [
    zh ? `你是研究「${doc.title}」的负责人。目标：${doc.goal || '（还没写）'}` : `You lead the research "${doc.title}". Goal: ${doc.goal || '(not written yet)'}`,
    zh
      ? '用户会和你一起把研究的结构一步步展开：有哪些方面会影响结果、每个方面怎么验证、各有哪些方法。用研究工具把谈定的东西落到树上（research_add、research_derive、research_evidence、research_update），用 research_settings 记下用户想要的研究方式。每个方面有自己的 agent，方面内的工作交给它们。研究总结（research_notes，scope "summary"）由你维护。用户也可能让你把已有的对话整理进来：先读（read_agent 不可用时问用户），再 research_attach。'
      : 'The user lays the research out with you step by step: which aspects may move the result, how each is validated, which methods each has. Put what you agree on into the tree with the research tools (research_add, research_derive, research_evidence, research_update), and record how the user wants the research run with research_settings. Each aspect has its own agent; leave the work within an aspect to it. You keep the research summary (research_notes, scope "summary"). The user may also ask you to bring earlier conversations in: attach them with research_attach.',
    zh ? '具体怎么做研究由用户决定，按用户的要求来；回复保持简短，研究页面上能看到整棵树。' : 'How the research is done is the user’s call: follow what they ask. Keep replies short; the research page shows the tree.',
    modeText(doc.policy?.mode, lang),
    empty ? (zh ? '现在树还是空的。' : 'The tree is empty so far.') : '',
    notes?.summary ? (zh ? `目前的总结：\n${excerpt(notes.summary.text)}` : `The summary so far:\n${excerpt(notes.summary.text)}`) : '',
    message ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function researchBrief(doc: ResearchDoc, node: ResearchNode, lang: 'en' | 'zh', message?: string, notes?: ResearchNotes): string {
  const zh = lang === 'zh';
  const L = (en: string, cn: string) => (zh ? cn : en);
  const aspect = aspectOf(doc, node);
  const m = aspect?.metric;
  const how = m
    ? L(`Validation: ${m.name} (${m.higherIsBetter ? 'higher is better' : 'lower is better'})${m.baseline != null ? `, starting at ${formatValue(m, m.baseline)}` : ''}.`, `验证方式：${m.name}（${m.higherIsBetter ? '越高越好' : '越低越好'}）${m.baseline != null ? `，起点 ${formatValue(m, m.baseline)}` : ''}。`)
    : L('Validation: judged by the user (works / does not work).', '验证方式：由用户判断（有效 / 无效）。');
  const parts =
    node.type === 'aspect'
      ? [
          L(`You own the "${node.title}" aspect of the research "${doc.title}" (${doc.goal}).`, `你负责研究「${doc.title}」（${doc.goal}）中的「${node.title}」方面。`),
          how,
          L(
            'The research tools: research_overview shows the tree; research_add lists a method (as an idea, with its design); research_try starts variants of a method in parallel, one agent each in its own worktree; research_derive combines or mutates methods; research_record records results; research_notes keeps this aspect’s notes (markdown in the repository), which new agents here start from. How the research is done is the user’s call: follow what they ask. Keep replies short; the research page shows the tree.',
            '可用的研究工具：research_overview 查看研究树；research_add 加一个方法（先作为想法，附上设计）；research_try 对一个方法并行开几个变体，每个变体一个 agent、各自独立 worktree；research_derive 组合或变异方法；research_record 记录结果；research_notes 维护这个方面的笔记（存在仓库里的 markdown），这个方面新开的 agent 会从笔记开始。具体怎么做研究由用户决定，按用户的要求来。回复保持简短，研究页面上能看到整棵树。',
          ),
          modeText(doc.policy?.mode, lang),
          notes?.aspects[node.id] ? L(`Your notes so far:\n${excerpt(notes.aspects[node.id].text)}`, `目前的笔记：\n${excerpt(notes.aspects[node.id].text)}`) : '',
        ]
      : [
          L(`Research "${doc.title}" · aspect "${aspect?.title ?? ''}" · method "${doc.nodes.find((n) => n.id === node.parent)?.title ?? ''}".`, `研究「${doc.title}」· 方面「${aspect?.title ?? ''}」· 方法「${doc.nodes.find((n) => n.id === node.parent)?.title ?? ''}」。`),
          doc.nodes.find((n) => n.id === node.parent)?.design ? L(`Design: ${doc.nodes.find((n) => n.id === node.parent)!.design}`, `设计：${doc.nodes.find((n) => n.id === node.parent)!.design}`) : '',
          L(`Try this variant: ${node.config ?? node.title}`, `尝试这个变体：${node.config ?? node.title}`),
          how,
          aspect && notes?.aspects[aspect.id] ? L(`What is known in this aspect so far (its notes):\n${excerpt(notes.aspects[aspect.id].text)}`, `这个方面目前已知的情况（它的笔记）：\n${excerpt(notes.aspects[aspect.id].text)}`) : '',
          notes?.summary ? L(`The research so far (its summary):\n${excerpt(notes.summary.text, 1200)}`, `整项研究目前的情况（总结）：\n${excerpt(notes.summary.text, 1200)}`) : '',
          L(
            `When done, call research_record with the result${m ? ` (${m.name})` : ' (works or not)'} and one finding worth keeping. Then reply in a line or two.`,
            `完成后调用 research_record 记录结果${m ? `（${m.name}）` : '（有效或无效）'}和一条值得留下的发现，然后用一两句话回复。`,
          ),
        ];
  return [...parts, message ?? ''].filter(Boolean).join('\n\n');
}

/** The prefix that tells an agent which nodes a message is about. */
export function aboutPrefix(nodes: ResearchNode[], doc: ResearchDoc, lang: 'en' | 'zh', whole: boolean): string {
  const zh = lang === 'zh';
  const list = nodes.map((n) => `${zh ? '「' : '"'}${n.title}${zh ? '」' : '"'} [${n.id}]`).join(zh ? '、' : ', ');
  if (nodes.length) return zh ? `关于研究「${doc.title}」里的 ${list}：` : `About ${list} in the research "${doc.title}": `;
  return whole ? (zh ? `关于研究「${doc.title}」（${doc.goal}）：` : `About the research "${doc.title}" (${doc.goal}): `) : '';
}

// ------------------------------------------------------------------ the tree as text

export function treeText(doc: ResearchDoc, taskName: (taskId?: string) => string | undefined): string {
  const out: string[] = [`Research "${doc.title}": ${doc.goal}`];
  if (doc.endMetric) out.push(`End metric: ${doc.endMetric.name} (${doc.endMetric.higherIsBetter ? 'higher' : 'lower'} is better${doc.endMetric.baseline != null ? `, baseline ${doc.endMetric.baseline}` : ''})`);
  const c = contributions(doc).filter((x) => x.estimate != null);
  if (c.length) out.push(`Which aspects matter (from ablations): ${c.map((x) => `${x.aspect.title} ${x.estimate! >= 0 ? '+' : ''}${formatValue(doc.endMetric, x.estimate!)} (${x.evidence} ablation${x.evidence === 1 ? '' : 's'})`).join('; ')}`);
  for (const e of doc.evidence) out.push(`  evidence [${e.kind}] ${e.title}: ${e.value} (${e.delta >= 0 ? '+' : ''}${e.delta})`);
  const agent = (n: ResearchNode) => (n.taskId ? ` · agent ${taskName(n.taskId) ?? n.taskId}` : '');
  for (const a of childrenOf(doc, null)) {
    const m = a.metric;
    out.push(`[${a.id}] aspect "${a.title}"${a.combos ? ' (combinations across aspects, validated end to end)' : ''} · validated by ${m ? `${m.name}, ${m.higherIsBetter ? 'higher' : 'lower'} is better${m.baseline != null ? `, start ${m.baseline}` : ''}${m.noise ? `, noise ±${m.noise}` : ''}` : 'judgement'}${a.metrics?.length ? ` · also watched: ${a.metrics.map((x) => x.name).join(', ')}` : ''}${agent(a)}`);
    for (const meth of childrenOf(doc, a.id)) {
      const best = bestExperiment(doc, meth);
      const links = (meth.links ?? []).map((l) => `${l.kind} from [${l.from}]`).join(', ');
      out.push(`  [${meth.id}] method "${meth.title}" · ${methodStatus(doc, meth)}${best ? ` · best ${formatValue(m, best.value)} (${best.title})` : ''}${links ? ` · ${links}` : ''}${meth.design ? ` · design: ${meth.design.replace(/\n/g, ' ')}` : ''}`);
      for (const e of childrenOf(doc, meth.id)) {
        const st = e.runs && e.runs.length > 1 ? runStats(e.runs) : undefined;
        const others = Object.entries(e.values ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
        out.push(`    [${e.id}] experiment "${e.title}" · ${e.status}${e.value != null ? ` ${formatValue(m, e.value)}` : ''}${st ? ` ± ${formatValue(m, st.sd)} (${st.n} runs)` : ''}${others ? ` · ${others}` : ''}${agent(e)}`);
        for (const f of e.findings ?? []) out.push(`      finding: ${f.text}`);
      }
    }
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ tools

export function researchTools(host: ResearchHost, caller: ResearchCaller): WorkspaceTool[] {
  const isMain = caller.kind === 'main';
  /** The research the caller works in: an agent's project's; the main agent's by name or id (or the only one). */
  const projectOf = (given?: unknown): string => {
    if (caller.kind === 'agent') {
      const t = host.findTaskById(caller.taskId);
      if (!t || !host.researchGet(t.projectId)) throw new Error('This agent is not in a project with a research.');
      return t.projectId;
    }
    const all = host.researchProjects();
    const want = String(given ?? '').trim().toLowerCase();
    if (!want) {
      if (all.length === 1) return all[0].projectId;
      throw new Error(all.length ? `Say which project: ${all.map((p) => p.name).join(', ')}.` : 'No project has a research yet (research_create starts one).');
    }
    const hit = all.find((p) => p.projectId.toLowerCase() === want || p.name.toLowerCase() === want);
    if (!hit) throw new Error(`No research in a project named "${String(given)}". With a research: ${all.map((p) => p.name).join(', ') || 'none'}.`);
    return hit.projectId;
  };
  /** The research to work on, read once pending writes are done (and, on an SSH host, once fetched). */
  const load = async (given?: unknown) => {
    const projectId = projectOf(given);
    await host.researchReady(projectId);
    return { projectId, doc: host.researchGet(projectId)! };
  };
  const nodeIn = (doc: ResearchDoc, id: unknown, type?: ResearchNode['type']): ResearchNode => {
    const n = doc.nodes.find((x) => x.id === String(id ?? ''));
    if (!n) throw new Error(`No node [${String(id)}]. research_overview lists the ids.`);
    if (type && n.type !== type) throw new Error(`[${n.id}] is ${n.type === 'aspect' ? 'an aspect' : `a ${n.type}`}, not ${type === 'aspect' ? 'an aspect' : `a ${type}`}.`);
    return n;
  };
  /** The caller's own node, if it is one of the research's agents. */
  const me = (doc: ResearchDoc) => (caller.kind === 'agent' ? doc.nodes.find((n) => n.taskId === caller.taskId) : undefined);
  /** Anything in this research: the main agent, or the research's own lead. */
  const full = (doc: ResearchDoc) => isMain || (caller.kind === 'agent' && doc.leadTaskId === caller.taskId);
  /** May the caller change things in this node's aspect? The main agent or the lead anywhere; an aspect's agent in its aspect. */
  const mayChange = (doc: ResearchDoc, node: ResearchNode) => {
    if (full(doc)) return;
    const mine = me(doc);
    const aspect = aspectOf(doc, node);
    if (mine?.type === 'aspect' && aspect?.id === mine.id) return;
    throw new Error(mine?.type === 'experiment' ? 'An experiment’s agent records its own result (research_record); its aspect’s agent changes the tree.' : 'Only this aspect’s agent (or the research’s lead) can change it.');
  };
  const name = (taskId?: string) => (taskId ? host.findTaskById(taskId)?.alias : undefined);
  // Agents work in their own project's research; the main agent names one when several have one.
  const projectArg = { project: z.string().optional().describe(isMain ? 'Project name or id (needed when several projects have a research).' : 'Ignored: your own project’s research.') };

  const tools: WorkspaceTool[] = [
    {
      name: 'research_overview',
      description: 'The research tree: its goal, which aspects matter (from ablations), every aspect with its validation and agent, its methods (status, best result, design, what they come from) and their experiments with results and findings. Node ids are in [brackets].',
      schema: z.object({ ...projectArg }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const notes = host.researchNotes(projectId);
        const parts = [treeText(doc, name)];
        if (notes.summary) parts.push(`--- summary.md (${resultsSince(doc, notes.summary.updatedAt)} results since it was written)\n${excerpt(notes.summary.text, 4000)}`);
        for (const a2 of childrenOf(doc, null)) {
          const n = notes.aspects[a2.id];
          if (n) parts.push(`--- notes for "${a2.title}" [${a2.id}] (${resultsSince(doc, n.updatedAt, a2.id)} results since)\n${excerpt(n.text, 3000)}`);
        }
        return parts.join('\n\n');
      },
    },
    {
      name: 'research_add',
      description: 'Adds a method to an aspect (as an idea not tried yet: no agent starts), or, for the main agent, a new aspect with how it is validated. Give a method its design in a line or two.',
      schema: z.object({
        ...projectArg,
        type: z.enum(['method', 'aspect']),
        parent_id: z.string().optional().describe('For a method: the aspect it belongs to.'),
        title: z.string().min(1).max(200),
        design: z.string().max(4000).optional().describe('A method: how it works, its key parameters.'),
        source: z.string().max(300).optional().describe('A method: where the idea comes from (a paper, an earlier finding).'),
        metric: z.string().max(200).optional().describe('An aspect: the metric that validates it (omit to judge by hand).'),
        higher_is_better: z.boolean().optional(),
        baseline: z.number().optional().describe('An aspect: where its metric starts.'),
        noise: z.number().min(0).optional().describe('An aspect, if the user says how noisy one run is (a typical standard deviation): results closer than this to the start count as unclear.'),
        other_metrics: z.array(z.object({ name: z.string().max(200), higher_is_better: z.boolean().optional() })).max(10).optional().describe('An aspect: more metrics to watch besides the main one (shown, not used to judge).'),
      }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        if (a.type === 'aspect') {
          if (!full(doc)) throw new Error('Only the research’s lead adds aspects.');
          const others = (a.other_metrics as Array<{ name: string; higher_is_better?: boolean }> | undefined)?.map((x) => ({ name: x.name, higherIsBetter: x.higher_is_better !== false }));
          const r = addNode(doc, { type: 'aspect', parent: null, title: String(a.title), status: 'running', ...(a.metric ? { metric: { name: String(a.metric), higherIsBetter: a.higher_is_better !== false, ...(typeof a.baseline === 'number' ? { baseline: a.baseline } : {}), ...(typeof a.noise === 'number' ? { noise: a.noise } : {}) } } : {}), ...(others?.length ? { metrics: others } : {}) });
          host.researchSave(projectId, r.doc);
          return `Added aspect [${r.node.id}] "${r.node.title}". Its agent starts when the user first talks to it on the research page.`;
        }
        const aspect = a.parent_id ? nodeIn(doc, a.parent_id, 'aspect') : me(doc)?.type === 'aspect' ? me(doc)! : undefined;
        if (!aspect) throw new Error('Give parent_id: the aspect the method belongs to.');
        mayChange(doc, aspect);
        const r = addNode(doc, { type: 'method', parent: aspect.id, title: String(a.title), status: 'idea', ...(a.design ? { design: String(a.design) } : {}), ...(a.source ? { source: String(a.source) } : {}) });
        host.researchSave(projectId, r.doc);
        return `Added method [${r.node.id}] "${r.node.title}" to "${aspect.title}" (not tried yet).`;
      },
    },
    {
      name: 'research_try',
      description: 'Starts variants of a method in parallel: one experiment each, with its own agent in its own worktree, briefed with the design and how the aspect is validated. Use after the user agrees which variants to try.',
      schema: z.object({
        ...projectArg,
        method_id: z.string(),
        variants: z.array(z.object({ title: z.string().min(1).max(200), config: z.string().max(4000).optional().describe('What exactly this variant changes.') })).min(1).max(8),
        repeats: z.number().int().min(2).max(20).optional().describe('Only when the user asks for repeated runs: each variant runs this many times (different seeds) and records every value.'),
      }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const method = nodeIn(doc, a.method_id, 'method');
        mayChange(doc, method);
        let next = doc;
        const made: ResearchNode[] = [];
        for (const v of a.variants as Array<{ title: string; config?: string }>) {
          const config = [v.config, a.repeats ? `Run it ${a.repeats} times (different seeds) and record every value (research_record runs).` : ''].filter(Boolean).join('\n');
          const r = addNode(next, { type: 'experiment', parent: method.id, title: v.title, status: 'running', ...(config ? { config } : {}) });
          next = r.doc;
          made.push(r.node);
        }
        if (method.status === 'idea') next = updateNode(next, method.id, { status: 'running' });
        host.researchSave(projectId, next);
        const started: string[] = [];
        for (const e of made) {
          try {
            const t = await host.researchStartAgent(projectId, e.id, { isolate: true });
            started.push(`[${e.id}] "${e.title}" → ${t.alias}`);
          } catch (error) {
            host.researchSave(projectId, updateNode(host.researchGet(projectId)!, e.id, { status: 'idea' }));
            started.push(`[${e.id}] "${e.title}" not started: ${(error as Error).message}`);
          }
        }
        return `Started ${made.length} variant${made.length === 1 ? '' : 's'} of "${method.title}":\n${started.join('\n')}`;
      },
    },
    {
      name: 'research_record',
      description: 'Records an experiment’s result: a value on its aspect’s metric (judged against the aspect’s start), or several runs’ values when the user asked for repeats (their mean is the result; within their spread of the start it is unclear), or works / does not work when the aspect has none, or no result; values of the aspect’s other metrics; and optionally a finding that stays on the experiment. An experiment’s own agent records its own (experiment_id may be left out).',
      schema: z.object({
        ...projectArg,
        experiment_id: z.string().optional(),
        value: z.number().optional(),
        runs: z.array(z.number()).min(2).max(200).optional().describe('Each run’s value, when it was run several times (only if the user asked for repeats).'),
        metrics: z.record(z.string(), z.number()).optional().describe('Values of the aspect’s other metrics, by name.'),
        works: z.boolean().optional().describe('For an aspect judged by hand.'),
        no_result: z.boolean().optional().describe('It ran but produced no usable result.'),
        finding: z.string().max(2000).optional(),
      }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const mine = me(doc);
        const e = a.experiment_id ? nodeIn(doc, a.experiment_id, 'experiment') : mine?.type === 'experiment' ? mine : undefined;
        if (!e) throw new Error('Give experiment_id.');
        if (!full(doc) && mine?.id !== e.id) mayChange(doc, e);
        const metric = aspectOf(doc, e)?.metric;
        let next = doc;
        const at = new Date().toISOString();
        if (a.no_result) next = updateNode(next, e.id, { status: 'error', value: undefined, runs: undefined, resultAt: at });
        else if (Array.isArray(a.runs) && a.runs.length > 1) {
          const runs = a.runs as number[];
          const mean = runStats(runs).mean;
          next = updateNode(next, e.id, { value: mean, runs, status: judge(metric, mean, runs), resultAt: at });
        } else if (typeof a.value === 'number') next = updateNode(next, e.id, { value: a.value, runs: undefined, status: judge(metric, a.value), resultAt: at });
        else if (typeof a.works === 'boolean') next = updateNode(next, e.id, { status: a.works ? 'pass' : 'fail', resultAt: at });
        if (a.metrics && Object.keys(a.metrics as object).length) next = updateNode(next, e.id, { values: { ...(next.nodes.find((n) => n.id === e.id)!.values ?? {}), ...(a.metrics as Record<string, number>) } });
        if (a.finding) next = addFinding(next, e.id, String(a.finding), name(caller.kind === 'agent' ? caller.taskId : undefined) ?? (isMain ? 'main agent' : undefined));
        if (next === doc) throw new Error('Nothing to record: give value, runs, metrics, works, no_result or finding.');
        host.researchSave(projectId, next);
        const now = next.nodes.find((n) => n.id === e.id)!;
        const spread = now.runs && now.runs.length > 1 ? ` ± ${formatValue(metric, runStats(now.runs).sd)} over ${now.runs.length} runs` : '';
        return `Recorded on "${e.title}": ${now.status}${now.value != null ? ` (${formatValue(metric, now.value)}${spread})` : ''}${a.finding ? ', with a finding' : ''}.`;
      },
    },
    {
      name: 'research_derive',
      description: 'Makes a new method from existing ones: combine (two or more; from different aspects it goes under the cross-aspect row, validated end to end) or mutate (one: a changed version, in the same aspect). It starts as an idea; try it with research_try.',
      schema: z.object({ ...projectArg, kind: z.enum(['combine', 'mutate']), from_ids: z.array(z.string()).min(1).max(6), title: z.string().min(1).max(200), design: z.string().max(4000).optional() }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const from = (a.from_ids as string[]).map((id) => nodeIn(doc, id, 'method'));
        if (a.kind === 'combine' && from.length < 2) throw new Error('Combine needs two or more methods.');
        if (a.kind === 'mutate' && from.length !== 1) throw new Error('Mutate takes one method.');
        const aspects = [...new Set(from.map((m) => aspectOf(doc, m)!.id))];
        let next = doc;
        let where: ResearchNode | undefined;
        if (aspects.length === 1) {
          where = aspectOf(doc, from[0])!;
          for (const m of from) mayChange(doc, m);
        } else {
          if (!full(doc)) throw new Error('Combining across aspects is the research lead’s (validated end to end).');
          where = childrenOf(next, null).find((x) => x.combos);
          if (!where) {
            const r = addNode(next, { type: 'aspect', parent: null, title: host.language() === 'zh' ? '跨方面组合' : 'Across aspects', status: 'running', combos: true, ...(doc.endMetric ? { metric: doc.endMetric } : {}) });
            next = r.doc;
            where = r.node;
          }
        }
        const r = addNode(next, { type: 'method', parent: where.id, title: String(a.title), status: 'idea', ...(a.design ? { design: String(a.design) } : {}), links: from.map((m) => ({ from: m.id, kind: a.kind as 'combine' | 'mutate' })) });
        host.researchSave(projectId, r.doc);
        return `Made method [${r.node.id}] "${r.node.title}" in "${where.title}" (${a.kind} of ${from.map((m) => `"${m.title}"`).join(', ')}).`;
      },
    },
    {
      name: 'research_notes',
      description: 'Writes a note, in markdown, kept in the repository next to the tree: an aspect’s notes (what was tried, what works and what does not, findings that matter, what to try next) or, for the main agent, the research summary (where things stand, which aspects matter, what one aspect taught another, next steps). The whole note: it replaces the last version (git keeps them). New agents start from these notes.',
      schema: z.object({ ...projectArg, scope: z.string().optional().describe('"summary" (the lead’s), or an aspect id (an aspect’s agent: its own, the default).'), markdown: z.string().min(1).max(40_000) }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const mine = me(doc);
        const scope = String(a.scope ?? (mine?.type === 'aspect' ? mine.id : ''));
        if (!scope) throw new Error('Give scope: "summary" or an aspect id.');
        if (scope === 'summary') {
          if (!full(doc)) throw new Error('The research summary is the lead’s; write your aspect’s notes.');
        } else {
          const aspect = nodeIn(doc, scope, 'aspect');
          if (!full(doc) && mine?.id !== aspect.id) throw new Error('An agent writes its own aspect’s notes.');
        }
        host.researchWriteNote(projectId, scope, String(a.markdown));
        return scope === 'summary' ? 'Summary updated.' : `Notes for "${doc.nodes.find((n) => n.id === scope)!.title}" updated.`;
      },
    },
    {
      name: 'research_update',
      description: 'Changes a node: its title or design, notes that a method borrows an idea from another, or removes it (with everything under it; git history keeps it).',
      schema: z.object({ ...projectArg, node_id: z.string(), title: z.string().min(1).max(200).optional(), design: z.string().max(4000).optional(), borrows_from: z.string().optional(), note: z.string().max(300).optional(), noise: z.number().min(0).optional().describe('An aspect: how noisy one run is, as the user says (0 to forget it).'), remove: z.boolean().optional() }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const n = nodeIn(doc, a.node_id);
        if (n.type === 'aspect' && !full(doc)) throw new Error('Only the research’s lead changes aspects.');
        mayChange(doc, n);
        if (a.remove) {
          host.researchSave(projectId, removeNode(doc, n.id));
          return `Removed "${n.title}" and what was under it.`;
        }
        let next = doc;
        if (a.title || a.design !== undefined) next = updateNode(next, n.id, { ...(a.title ? { title: String(a.title) } : {}), ...(a.design !== undefined ? { design: String(a.design) || undefined } : {}) });
        if (typeof a.noise === 'number') {
          if (n.type !== 'aspect' || !n.metric) throw new Error('Noise belongs to an aspect with a metric.');
          next = updateNode(next, n.id, { metric: { ...n.metric, noise: a.noise || undefined } });
        }
        if (a.borrows_from) {
          const src = nodeIn(doc, a.borrows_from, 'method');
          if (n.type !== 'method') throw new Error('Only a method borrows from another.');
          next = updateNode(next, n.id, { links: [...(n.links ?? []).filter((l) => l.from !== src.id), { from: src.id, kind: 'borrow', ...(a.note ? { note: String(a.note) } : {}) }] });
        }
        if (next === doc) throw new Error('Nothing to change.');
        host.researchSave(projectId, next);
        return `Updated "${n.title}".`;
      },
    },
  ];
  tools.push(
    {
      name: 'research_settings',
      description: 'Records how the user wants this research run (the lead’s): mode auto (agents go ahead within the budget), direction (ask before a new direction), review (propose experiments, start when the user agrees), collaborative (both); whether aspects’ agents are reminded to update their notes when a batch has its results; how often (minutes, 0 = never) the lead is reminded to update the summary. New agents are told the mode.',
      schema: z.object({ ...projectArg, mode: z.enum(['auto', 'direction', 'review', 'collaborative']).optional(), auto_notes: z.boolean().optional(), summary_every_minutes: z.number().min(0).max(100_000).optional() }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        if (!full(doc)) throw new Error('How the research runs is set with its lead.');
        const policy = { ...doc.policy, ...(a.mode ? { mode: a.mode as ResearchMode } : {}), ...(typeof a.auto_notes === 'boolean' ? { autoNotes: a.auto_notes } : {}), ...(typeof a.summary_every_minutes === 'number' ? { summaryEvery: a.summary_every_minutes } : {}) };
        host.researchSave(projectId, { ...doc, policy, updatedAt: new Date().toISOString() });
        return `Settings: mode ${policy.mode ?? DEFAULT_MODE}, notes reminders ${policy.autoNotes === false ? 'off' : 'on'}, summary every ${policy.summaryEvery ?? 30} min${policy.summaryEvery === 0 ? ' (never)' : ''}.`;
      },
    },
  );
  if (isMain)
    tools.push(
      {
        name: 'research_create',
        description: 'Starts a research in a project: its title and goal (what should improve, measured how end to end). It is kept in the project’s repository and shown on its research page. Then add its aspects with research_add.',
        schema: z.object({ project: z.string().describe('Project name or id.'), title: z.string().min(1).max(200), goal: z.string().max(2000), end_metric: z.string().max(200).optional(), higher_is_better: z.boolean().optional(), baseline: z.number().optional() }),
        run: async (a) => {
          const want = String(a.project).toLowerCase();
          const p = host.allProjects().find((x) => x.projectId.toLowerCase() === want || x.name.toLowerCase() === want);
          if (!p) throw new Error(`No project named "${String(a.project)}".`);
          let doc = await host.researchCreate(p.projectId, String(a.title), String(a.goal ?? ''), false);
          if (a.end_metric) doc = host.researchSave(p.projectId, { ...doc, endMetric: { name: String(a.end_metric), higherIsBetter: a.higher_is_better !== false, ...(typeof a.baseline === 'number' ? { baseline: a.baseline } : {}) } });
          return `Started research "${doc.title}" in ${p.name}. It shows as one row in that project's team in the sidebar.`;
        },
      },
    );
  tools.push(
      {
        name: 'research_attach',
        description: 'Puts an existing conversation into the research, keeping it as it is (no new agent): as an aspect’s agent, or as an experiment under a method, with what it found. Use it to turn one or several earlier conversations into a research: read them first (read_agent), lay out aspects and methods, then attach each.',
        schema: z.object({
          project: z.string().optional(),
          agent: z.string().describe('The agent’s name or role.'),
          as: z.enum(['aspect_agent', 'experiment']),
          node_id: z.string().describe('aspect_agent: the aspect. experiment: the method it tried.'),
          title: z.string().max(200).optional().describe('experiment: what it tried (default: the agent’s task).'),
          outcome: z.enum(['works', 'does_not_work', 'no_result', 'in_progress']).optional().describe('experiment: what it came to.'),
          value: z.number().optional().describe('experiment: its result on the aspect’s metric, if it has one.'),
          finding: z.string().max(2000).optional(),
        }),
        run: async (a) => {
          const { projectId, doc } = await load(a.project);
          if (!full(doc)) throw new Error('Bringing conversations into the research is the lead’s.');
          const agent = host.findAgent(String(a.agent));
          if (!agent) throw new Error(`No agent named "${String(a.agent)}".`);
          if (agent.projectId !== projectId) throw new Error(`${agent.alias} works in another project; a research holds its own project’s agents.`);
          const taken = doc.nodes.find((n) => n.taskId === agent.taskId);
          if (taken) throw new Error(`${agent.alias} is already in the research, at [${taken.id}] "${taken.title}".`);
          if (a.as === 'aspect_agent') {
            const aspect = nodeIn(doc, a.node_id, 'aspect');
            host.researchSave(projectId, updateNode(doc, aspect.id, { taskId: agent.taskId }));
            return `${agent.alias} now owns the aspect "${aspect.title}".`;
          }
          const method = nodeIn(doc, a.node_id, 'method');
          if (!a.outcome) throw new Error('Say its outcome: works, does_not_work, no_result or in_progress.');
          const metric = aspectOf(doc, method)?.metric;
          const status = a.outcome === 'in_progress' ? 'running' : a.outcome === 'no_result' ? 'error' : typeof a.value === 'number' && metric?.baseline != null ? judge(metric, a.value) : a.outcome === 'works' ? 'pass' : 'fail';
          const r = addNode(doc, { type: 'experiment', parent: method.id, title: String(a.title || agent.title || agent.name), status, taskId: agent.taskId, ...(typeof a.value === 'number' ? { value: a.value } : {}), ...(status !== 'running' ? { resultAt: new Date().toISOString() } : {}) });
          let next = r.doc;
          if (a.finding) next = addFinding(next, r.node.id, String(a.finding), agent.alias);
          if (method.status === 'idea') next = updateNode(next, method.id, { status: 'running' });
          host.researchSave(projectId, next);
          return `Attached ${agent.alias} as experiment [${r.node.id}] "${r.node.title}" under "${method.title}" (${status}). It now lives on the research page, not in the sidebar's team.`;
        },
      },
      {
        name: 'research_evidence',
        description: 'Records an end-to-end run, or an ablation (an aspect’s changes taken out), with its end-metric value and change against what it is compared with. Ablations are what say which aspects matter.',
        schema: z.object({ project: z.string().optional(), kind: z.enum(['e2e', 'ablation']), title: z.string().min(1).max(200), value: z.number(), delta: z.number(), aspect_id: z.string().optional().describe('For an ablation: the aspect taken out.') }),
        run: async (a) => {
          const { projectId, doc } = await load(a.project);
          if (!full(doc)) throw new Error('End-to-end runs and ablations are recorded by the lead.');
          if (a.kind === 'ablation') nodeIn(doc, a.aspect_id, 'aspect');
          host.researchSave(projectId, { ...doc, evidence: [...doc.evidence, { id: `ev-${Date.now().toString(36)}`, kind: a.kind as 'e2e' | 'ablation', title: String(a.title), value: Number(a.value), delta: Number(a.delta), ...(a.kind === 'ablation' ? { aspect: String(a.aspect_id) } : {}), at: new Date().toISOString() }], updatedAt: new Date().toISOString() });
          return `Recorded ${a.kind === 'e2e' ? 'an end-to-end run' : 'an ablation'}: ${String(a.title)}.`;
        },
      },
    );
  return tools;
}

export { routeFor };
