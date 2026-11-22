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
  parseResearchId,
  researchId,
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
  type ResearchResult,
} from '../shared/research';
import type { WorkspaceTool } from './main-agent';
import { parseView, viewKey, VIEW_TEMPLATES } from '../shared/research-views';
import { changeUi, parseUiFile, undoUi, type UiFile } from '../shared/research-ui';

/** What the tools need from the workspace (implemented by Workspace). */
export interface ResearchHost {
  // A research is named by its id (shared/research.ts researchId); a project may hold several, one per folder.
  researchList(): Array<{ id: string; projectId: string; project: string; dir?: string; title: string; taskIds: string[] }>;
  allProjects(): Array<{ projectId: string; name: string }>;
  researchGet(id: string): ResearchDoc | null;
  /** `by`: the agent whose tool call it is (it is not told about its own change). */
  researchSave(id: string, doc: ResearchDoc, by?: string): ResearchDoc;
  /** One agent of the research tells another something; resolves to the receiver's name. */
  researchTell(fromTaskId: string | undefined, toTaskId: string, text: string): Promise<string>;
  researchCreate(projectId: string, title: string, goal: string, sample: boolean, dir?: string): Promise<ResearchDoc>;
  /** Starts an agent for a node (an aspect's, or an experiment's in its own worktree), briefed, and links it. */
  researchStartAgent(projectId: string, nodeId: string, opts: { isolate: boolean; message?: string }): Promise<Task>;
  findTaskById(taskId: string): Task | undefined;
  /** A conversation as text (its recent items): for the lead bringing conversations into the research. */
  transcriptText(taskId: string, limit: number): string;
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
/**
 * How the research runs, as an agent is told. `aspect`: for an aspect's agent under a lead, whatever is to be
 * agreed goes to the lead, who gathers the proposals and asks the user once (not every agent asking at once).
 */
export function modeText(mode: ResearchMode | undefined, lang: 'en' | 'zh', aspect?: { lead: boolean }): string {
  const zh = lang === 'zh';
  const m = mode ?? DEFAULT_MODE;
  const toLead =
    aspect?.lead && m !== 'auto'
      ? zh
        ? '要用户同意的提案先交给负责人（research_tell 发给 "lead"），由它汇总后统一问用户；不要自己直接问用户。'
        : 'Proposals that need the user’s agreement go to the lead (research_tell to "lead"), who gathers them and asks the user once; do not ask the user yourself.'
      : '';
  return [modeLine(m, zh), toLead].filter(Boolean).join(' ');
}

function modeLine(mode: ResearchMode, zh: boolean): string {
  switch (mode) {
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
/**
 * How a research's agents work, whatever the research: the tree is the shared state (changed only through
 * the tools, as things happen), work is handed out as agents of the research, and agents tell each other.
 */
function rules(role: 'lead' | 'aspect', lang: 'en' | 'zh'): string {
  const zh = lang === 'zh';
  return [
    zh
      ? '几条固定的做法（工具名都以 mcp__research__ 开头）：'
      : 'How it works here, always (the tools’ names start with mcp__research__):',
    zh
      ? '· 研究树是大家共享的状态，用户在页面上实时看它。只通过研究工具读写：看树用 research_overview，不要直接读或改 .research/ 里的文件。'
      : '· The tree is everyone’s shared state, and the user watches it live. Read and change it only through the research tools: research_overview to see it; never read or edit the files in .research/ directly.',
    zh
      ? '· 边做边更新，不要攒到最后：要试一个新做法，先 research_add 把它加到树上；有了结果马上 research_record（带一句话结论）；结论变了就 research_update 改 takeaway。'
      : '· Keep it current as you go, not at the end: before trying something new, put it on the tree (research_add); record a result as soon as there is one (research_record, with a one-line takeaway); when a conclusion changes, update its takeaway (research_update).',
    zh
      ? `· 要把工作分出去并行做，用 research_try${role === 'lead' ? '（或让对应方面的 agent 去做）' : ''}：每个变体是研究里的一个 agent，会出现在页面上，用户能看到、能和它对话。你没有内置的子 agent 工具，也不要用别的办法在后台偷偷分工。`
      : `· To hand work out in parallel, use research_try${role === 'lead' ? ' (or have that aspect’s agent do it)' : ''}: each variant is an agent of the research, shown on the page, that the user can see and talk to. You have no built-in sub-agent tool; do not hand work out behind the page some other way.`,
    zh
      ? '· agent 之间用 research_tell 通信：把别的部分需要知道的事告诉它的 agent 或负责人（会改变对方计划的发现、对方在等的结果），需要对方做事也用它。实验记录的结果会自动送到所属方面的 agent。'
      : '· Agents talk with research_tell: tell another part’s agent, or the lead, what it needs to know (a finding that changes its plan, a result it waits for), or ask it to do something. Results recorded by experiments reach their aspect’s agent by themselves.',
  ].join('\n');
}

/** The user reads the agents' replies: in the workspace's language. */
const replyIn = (lang: 'en' | 'zh') => (lang === 'zh' ? '回复用户和其他 agent 时都用中文。' : '');

export function leadBrief(doc: ResearchDoc, lang: 'en' | 'zh', message?: string, notes?: ResearchNotes): string {
  const zh = lang === 'zh';
  const empty = !doc.nodes.length;
  return [
    zh ? `你是研究「${doc.title}」的负责人。目标：${doc.goal || '（还没写）'}` : `You lead the research "${doc.title}". Goal: ${doc.goal || '(not written yet)'}`,
    zh
      ? '用户会和你一起把研究的结构一步步展开：有哪些方面会影响结果、每个方面怎么验证、各有哪些方法。用研究工具把谈定的东西落到树上（research_add、research_derive、research_evidence、research_update），用 research_settings 记下用户想要的研究方式。每个方面有自己的 agent，方面内的工作交给它们。研究总结（research_notes，scope "summary"）由你维护。用户也可能让你把已有的对话整理进来：先用 research_read 读，再 research_attach。'
      : 'The user lays the research out with you step by step: which aspects may move the result, how each is validated, which methods each has. Put what you agree on into the tree with the research tools (research_add, research_derive, research_evidence, research_update), and record how the user wants the research run with research_settings. Each aspect has its own agent; leave the work within an aspect to it. You keep the research summary (research_notes, scope "summary"). The user may also ask you to bring earlier conversations in: read them with research_read, then attach them with research_attach.',
    rules('lead', lang),
    zh
      ? '树的粒度（用户没有别的要求时）：方面是研究的几个大的维度（比如数据、方法、评估，具体看这个研究本身），通常只有少数几个；同一类的东西放进同一个方面，不要每个子课题开一个方面。方法是一个方面里可以相互替代的做法。实验是一次具体的运行或检查；为某个方法做的前期分析和验证，是这个方法下面的实验，不单独成为方面。'
      : 'The tree’s grain (unless the user wants otherwise): aspects are the research’s few broad dimensions (for example data, method, evaluation, whatever this research’s own are); things of one kind go in one aspect, not an aspect per sub-study. Methods are the alternatives within an aspect. Experiments are single runs or checks; an early analysis or check done for a method is an experiment under that method, not an aspect of its own.',
    zh
      ? '研究页本身怎么显示也归这个研究自己定（research_ui：层级和状态怎么叫、图上节点显示什么、顶部的汇总比如花费），用户提出时就改。研究页右侧显示的是每个节点的视图（research_view）：用户想看什么（比如核心指标的追踪表、对比、图），就写进对应节点的视图里；数字按指标和数据集记录（research_record 的 results），视图里的活表格会自动跟上新的方法和数据集。'
      : 'How the page itself looks is this research’s own too (research_ui: what the levels and states are called, what a node shows in the graph, totals at the top such as what was spent); change it when the user asks. The page’s side panel shows each node’s view (research_view): what the user wants to see there (a tracker of the core metrics, a comparison, a chart) goes into that node’s view; record numbers by metric and dataset (research_record results) and the live tables in views keep up with new methods and datasets.',
    zh ? '具体怎么做研究由用户决定，按用户的要求来；回复保持简短，研究页面上能看到整棵树。' : 'How the research is done is the user’s call: follow what they ask. Keep replies short; the research page shows the tree.',
    modeText(doc.policy?.mode, lang),
    empty ? (zh ? '现在树还是空的。' : 'The tree is empty so far.') : '',
    notes?.summary ? (zh ? `目前的总结：\n${excerpt(notes.summary.text)}` : `The summary so far:\n${excerpt(notes.summary.text)}`) : '',
    replyIn(lang),
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
    : L('Validation: by judgement, works or does not work.', '验证方式：凭判断，有效或无效。');
  const parts =
    node.type === 'aspect'
      ? [
          L(`You own the "${node.title}" aspect of the research "${doc.title}" (${doc.goal}).`, `你负责研究「${doc.title}」（${doc.goal}）中的「${node.title}」方面。`),
          how,
          L(
            'The research tools: research_overview shows the tree; research_add lists a method (as an idea, with its design); research_try starts variants of a method in parallel, one agent each in its own worktree; research_derive combines or mutates methods; research_record records results; research_update keeps one-line takeaways (what a method, and this aspect, comes to so far: the graph shows them on the nodes); research_notes keeps this aspect’s notes (markdown in the repository), which new agents here start from. How the research is done is the user’s call: follow what they ask. Keep replies short; the research page shows the tree.',
            '可用的研究工具：research_overview 查看研究树；research_add 加一个方法（先作为想法，附上设计）；research_try 对一个方法并行开几个变体，每个变体一个 agent、各自独立 worktree；research_derive 组合或变异方法；research_record 记录结果；research_update 维护一句话结论（一个方法、以及这个方面目前的结论，会显示在图的节点上）；research_notes 维护这个方面的笔记（存在仓库里的 markdown），这个方面新开的 agent 会从笔记开始。具体怎么做研究由用户决定，按用户的要求来。回复保持简短，研究页面上能看到整棵树。',
          ),
          rules('aspect', lang),
          modeText(doc.policy?.mode, lang, { lead: !!doc.leadTaskId }),
          notes?.aspects[node.id] ? L(`Your notes so far:\n${excerpt(notes.aspects[node.id].text)}`, `目前的笔记：\n${excerpt(notes.aspects[node.id].text)}`) : '',
        ]
      : [
          L(`Research "${doc.title}" · aspect "${aspect?.title ?? ''}" · method "${doc.nodes.find((n) => n.id === node.parent)?.title ?? ''}".`, `研究「${doc.title}」· 方面「${aspect?.title ?? ''}」· 方法「${doc.nodes.find((n) => n.id === node.parent)?.title ?? ''}」。`),
          doc.nodes.find((n) => n.id === node.parent)?.design ? L(`Design: ${doc.nodes.find((n) => n.id === node.parent)!.design}`, `设计：${doc.nodes.find((n) => n.id === node.parent)!.design}`) : '',
          L(`Try this variant: ${node.config ?? node.title}`, `尝试这个变体：${node.config ?? node.title}`),
          how,
          aspect && notes?.aspects[aspect.id] ? L(`What is known in this aspect so far (its notes):\n${excerpt(notes.aspects[aspect.id].text)}`, `这个方面目前已知的情况（它的笔记）：\n${excerpt(notes.aspects[aspect.id].text)}`) : '',
          notes?.summary ? L(`The research so far (its summary):\n${excerpt(notes.summary.text, 1200)}`, `整项研究目前的情况（总结）：\n${excerpt(notes.summary.text, 1200)}`) : '',
          doc.policy?.mode === 'collaborative'
            ? ''
            : L('Judge the result yourself (against the start, or by what you saw when there is no metric) and say why in the finding; do not ask the user to judge it.', '结果由你自己判断（和起点比；没有指标时按你看到的情况），在发现里写明理由；不要让用户来判断。'),
          L(
            `When done, call research_record (mcp__research__research_record) with the result${m ? ` (${m.name})` : ' (works or not)'}, a one-line takeaway (what it comes to) and one finding worth keeping: that is how your aspect’s agent and the user learn of it. If you find something along the way that others should know now, or need a decision, tell them with research_tell (to "lead" or a node’s id). Do not edit the files in .research/. Then reply in a line or two.`,
            `完成后调用 research_record（mcp__research__research_record）记录结果${m ? `（${m.name}）` : '（有效或无效）'}、一句话结论（takeaway）和一条值得留下的发现：所属方面的 agent 和用户就是这样得知结果的。中途发现别人现在就该知道的事，或需要别人拿主意，用 research_tell 告诉对方（发给 "lead" 或某个节点的 id）。不要直接改 .research/ 里的文件。然后用一两句话回复。`,
          ),
        ];
  const tail = node.type === 'experiment'
    ? L('Others may record results while you work: before saying how yours compares, look at the latest (research_overview).', '你工作期间别人也可能记录结果：说自己的结果和别人比怎么样之前，先看最新的（research_overview）。')
    : '';
  return [...parts, tail, replyIn(lang), message ?? ''].filter(Boolean).join('\n\n');
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
  const save = (id: string, doc: ResearchDoc) => host.researchSave(id, doc, caller.kind === 'agent' ? caller.taskId : undefined);
  /** How a research is named to agents: its project, and its folder if it is in one. */
  const label = (r: { project: string; dir?: string }) => (r.dir ? `${r.project}/${r.dir}` : r.project);
  /** The research the caller works in: an agent's (the one it is in, else its project's); the main agent's by name (or the only one). */
  const projectOf = (given?: unknown): string => {
    const want = String(given ?? '').trim().toLowerCase();
    const named = (list: ReturnType<ResearchHost['researchList']>) => list.filter((r) => [r.id, label(r), r.title, r.dir ?? ''].some((x) => x && x.toLowerCase() === want) || (!r.dir && r.project.toLowerCase() === want));
    if (caller.kind === 'agent') {
      const t = host.findTaskById(caller.taskId);
      const all = host.researchList();
      const mine = all.find((r) => r.taskIds.includes(caller.taskId));
      if (mine) return mine.id;
      const here = all.filter((r) => r.projectId === t?.projectId);
      if (!here.length) throw new Error('This agent is not in a project with a research.');
      if (here.length === 1) return here[0].id;
      const hit = want ? named(here) : [];
      if (hit.length === 1) return hit[0].id;
      throw new Error(`This project has several researches: say which (project): ${here.map(label).join(', ')}.`);
    }
    const all = host.researchList();
    if (!want) {
      if (all.length === 1) return all[0].id;
      throw new Error(all.length ? `Say which research (project): ${all.map(label).join(', ')}.` : 'No project has a research yet (research_create starts one).');
    }
    const hit = named(all);
    if (hit.length === 1) return hit[0].id;
    const inProject = all.filter((r) => r.project.toLowerCase() === want);
    if (inProject.length > 1) throw new Error(`${String(given)} has several researches: ${inProject.map(label).join(', ')}.`);
    if (inProject.length === 1) return inProject[0].id;
    throw new Error(`No research named "${String(given)}". Researches: ${all.map(label).join(', ') || 'none'}.`);
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
    if (type && n.type !== type) {
      const kids = type === 'experiment' && n.type === 'method' ? doc.nodes.filter((x) => x.parent === n.id) : [];
      const hint = kids.length ? ` Its experiments: ${kids.map((x) => `[${x.id}] "${x.title}"`).join(', ')}.` : type === 'experiment' && n.type === 'method' ? ' It has no experiments yet: start them with research_try.' : '';
      throw new Error(`[${n.id}] is ${n.type === 'aspect' ? 'an aspect' : `a ${n.type}`}, not ${type === 'aspect' || type === 'experiment' ? `an ${type}` : `a ${type}`}.${hint}`);
    }
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
    throw new Error(mine?.type === 'experiment' ? 'An experiment’s agent records its own result and takeaway with research_record (takeaway: one line); its aspect’s agent changes the rest of the tree, and research_tell reaches it.' : 'Only this aspect’s agent (or the research’s lead) can change it.');
  };
  const name = (taskId?: string) => (taskId ? host.findTaskById(taskId)?.alias : undefined);
  // Agents work in their own project's research; the main agent names one when several have one.
  const projectArg = { project: z.string().optional().describe(isMain ? 'Which research: its project, or project/folder for one kept in a folder (needed when there are several).' : 'Only when your project has several researches and you are in none: project/folder.') };

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
          save(projectId, r.doc);
          return `Added aspect [${r.node.id}] "${r.node.title}". Its agent starts with the first thing told to it (research_tell, or the user on the research page).`;
        }
        const aspect = a.parent_id ? nodeIn(doc, a.parent_id, 'aspect') : me(doc)?.type === 'aspect' ? me(doc)! : undefined;
        if (!aspect) throw new Error('Give parent_id: the aspect the method belongs to.');
        mayChange(doc, aspect);
        const r = addNode(doc, { type: 'method', parent: aspect.id, title: String(a.title), status: 'idea', ...(a.design ? { design: String(a.design) } : {}), ...(a.source ? { source: String(a.source) } : {}) });
        save(projectId, r.doc);
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
        save(projectId, next);
        const started: string[] = [];
        for (const e of made) {
          try {
            const t = await host.researchStartAgent(projectId, e.id, { isolate: true });
            started.push(`[${e.id}] "${e.title}" → ${t.alias}`);
          } catch (error) {
            save(projectId, updateNode(host.researchGet(projectId)!, e.id, { status: 'idea' }));
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
        // (A list, not a record: a record's schema breaks the SDK's tool listing, and then no research tool is listed at all.)
        metrics: z.array(z.object({ name: z.string().min(1).max(200), value: z.number() })).max(50).optional().describe('Values of the aspect’s other metrics.'),
        results: z
          .array(z.object({ metric: z.string().min(1).max(200), dataset: z.string().max(200).optional(), value: z.number() }))
          .max(500)
          .optional()
          .describe('Numbers by metric and dataset, for live tables: each replaces the one with the same metric and dataset; others are kept. A dataset is what it was measured on (a benchmark, a split, a test set), never the variant’s own settings (those are its title and config); leave it out when there is only one.'),
        works: z.boolean().optional().describe('For an aspect judged by hand.'),
        no_result: z.boolean().optional().describe('It ran but produced no usable result.'),
        finding: z.string().max(2000).optional(),
        takeaway: z.string().max(200).optional().describe('What this experiment comes to, in one short line (shown on its node in the graph).'),
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
        if (Array.isArray(a.metrics) && a.metrics.length) next = updateNode(next, e.id, { values: { ...(next.nodes.find((n) => n.id === e.id)!.values ?? {}), ...Object.fromEntries((a.metrics as Array<{ name: string; value: number }>).map((m) => [String(m.name), Number(m.value)])) } });
        if (Array.isArray(a.results) && a.results.length) {
          const add = (a.results as ResearchResult[]).map((r) => ({ metric: String(r.metric), ...(r.dataset ? { dataset: String(r.dataset) } : {}), value: Number(r.value) }));
          const same = (x: ResearchResult, y: ResearchResult) => x.metric === y.metric && (x.dataset ?? '') === (y.dataset ?? '');
          const kept = (next.nodes.find((n) => n.id === e.id)!.results ?? []).filter((x) => !add.some((y) => same(x, y)));
          next = updateNode(next, e.id, { results: [...kept, ...add], resultAt: at, ...(e.status === 'idea' || e.status === 'running' ? { status: 'unclear' as const } : {}) });
        }
        if (a.takeaway) next = updateNode(next, e.id, { takeaway: String(a.takeaway) });
        if (a.finding) next = addFinding(next, e.id, String(a.finding), name(caller.kind === 'agent' ? caller.taskId : undefined) ?? (isMain ? 'main agent' : undefined));
        if (next === doc) throw new Error('Nothing to record: give value, runs, metrics, results, works, no_result or finding.');
        save(projectId, next);
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
            // Validated end to end: on the research's end metric, else on the metric the combined aspects share.
            const shared = aspects.map((id) => doc.nodes.find((n) => n.id === id)?.metric);
            const metric = doc.endMetric ?? (shared.every((m) => m && m.name === shared[0]?.name && m.higherIsBetter === shared[0]?.higherIsBetter) ? shared[0] : undefined);
            const r = addNode(next, { type: 'aspect', parent: null, title: host.language() === 'zh' ? '跨方面组合' : 'Across aspects', status: 'running', combos: true, ...(metric ? { metric } : {}) });
            next = r.doc;
            where = r.node;
          }
        }
        const r = addNode(next, { type: 'method', parent: where.id, title: String(a.title), status: 'idea', ...(a.design ? { design: String(a.design) } : {}), links: from.map((m) => ({ from: m.id, kind: a.kind as 'combine' | 'mutate' })) });
        save(projectId, r.doc);
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
      name: 'research_view',
      description: [
        'Writes what the research page shows for a node (its side panel): markdown, with live blocks in it. The user may ask for what they want to see (a table of the core metrics, a comparison, a chart); write it here, and rewrite it when they ask for something else. The whole view: it replaces the last one. Leave markdown out and give template to start from one.',
        'Blocks are fenced code blocks, ```research:<kind> with JSON options inside:',
        'table: a live table of recorded results that follows the tree (new methods add rows, new datasets add columns); options {"rows":"methods"|"experiments"|"aspects","under":"<node id, default this one>","metrics":["auc12",...] or "*","datasets":"*" (a column per dataset, new ones added) or a list (left out: one column per metric over all its results),"cell":"best"|"latest"|"mean"|"sum","sum":["metrics added up, e.g. what was spent"],"lower":["metrics where lower is better"],"title":"..."}. Whatever this research tracks goes in as a metric, resources included (cost, GPU hours, tokens: record them as results, show them summed).',
        'children (the nodes under it, with status and best value), kpis (start → best, experiments, how many work), findings (the findings under it), notes (the aspect’s notes, or the summary on the goal), summary, design, result (an experiment’s numbers), evidence (end-to-end runs and ablations).',
        'html: ```html <height> with your own HTML (inline SVG and scripts allowed, isolated, no network; it is styled like the page: plain tables and text look like the rest). Put script code inside a function: top-level names like top, name or parent are the page’s own and break the script.',
        'Results for tables are recorded with research_record (results: metric, dataset, value).',
      ].join(' '),
      schema: z.object({
        ...projectArg,
        node_id: z.string().optional().describe('The node (default: the goal for the lead and main agent, your own node otherwise); "goal" for the goal.'),
        markdown: z.string().min(1).max(100_000).optional(),
        template: z.enum(VIEW_TEMPLATES.map((v) => v.id) as [string, ...string[]]).optional().describe(`Start from a template: ${VIEW_TEMPLATES.map((v) => `${v.id} (${v.levels.join('/')})`).join(', ')}.`),
      }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const mine = me(doc);
        const id = String(a.node_id ?? (full(doc) ? 'goal' : (mine?.id ?? '')));
        if (!id) throw new Error('Give node_id.');
        const node = id === 'goal' ? undefined : nodeIn(doc, id);
        if (!node && !full(doc)) throw new Error('The goal’s view is the lead’s.');
        if (node && !full(doc) && mine?.id !== node.id) mayChange(doc, node);
        const text = a.markdown ? String(a.markdown) : a.template ? VIEW_TEMPLATES.find((v) => v.id === a.template)!.text : '';
        if (!text) throw new Error('Give markdown or template.');
        const bad = parseView(text).find((p) => p.type === 'block' && p.error);
        if (bad && bad.type === 'block') throw new Error(bad.error);
        host.researchWriteNote(projectId, `view:${viewKey(node)}`, text);
        return `The view of ${node ? `"${node.title}"` : 'the goal'} is updated; the page shows it now.`;
      },
    },
    {
      name: 'research_tell',
      description: 'Tells another agent of this research something, as a message it reads at its next step: the lead ("lead"), or the agent of a node (an aspect’s agent by the aspect’s or one of its methods’ id; an experiment’s by the experiment’s id). An aspect with no agent yet gets one, started with this message: that is how the lead hands an aspect’s work to its own agent. Use it to pass on what another part of the research should know (a finding that changes its plan, a result it waits for), to ask it something, or to redirect it. Results recorded with research_record reach the aspect’s agent by themselves.',
      schema: z.object({ ...projectArg, to: z.string().describe('"lead", or a node id.'), message: z.string().min(1).max(8000) }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const to = String(a.to);
        const node = to === 'lead' ? undefined : nodeIn(doc, to);
        const taskId = !node ? doc.leadTaskId : node.type === 'method' ? aspectOf(doc, node)?.taskId : node.taskId;
        if (!taskId || !host.findTaskById(taskId)) {
          // An aspect (or a method's aspect) without its agent: started now, briefed, with this message.
          const aspect = node && (node.type === 'aspect' ? node : node.type === 'method' ? aspectOf(doc, node) : undefined);
          if (!aspect || aspect.combos) throw new Error(node ? `"${node.title}" has no agent (an experiment’s agent starts with research_try).` : 'This research has no lead yet.');
          if (!full(doc)) throw new Error('Starting an aspect’s agent is the lead’s.');
          const from = caller.kind === 'agent' ? host.findTaskById(caller.taskId)?.alias : undefined;
          const zh = host.language() === 'zh';
          const t = await host.researchStartAgent(projectId, aspect.id, { isolate: false, message: `${from ? (zh ? `【来自 ${from}】` : `[From ${from}] `) : ''}${String(a.message)}` });
          return `Started ${t.alias} as the agent of "${aspect.title}", with your message.`;
        }
        if (caller.kind === 'agent' && taskId === caller.taskId) throw new Error('That is you.');
        const alias = await host.researchTell(caller.kind === 'agent' ? caller.taskId : undefined, taskId, String(a.message));
        return `Told ${alias}.`;
      },
    },
    {
      name: 'research_ui',
      description: [
        'Changes how this research’s page looks while it runs (the lead’s, when the user asks for it): settings kept in .research/ui.json, applied at once, each change undoable. With nothing given it returns the settings now.',
        'set is merged into the settings (a key set to null goes back to the built-in):',
        'labels {"aspect","method","experiment"} and plural {…}: what the levels are called (e.g. question / approach / run).',
        'statuses {"idea","running","pass","fail","unclear","error"}: what the states are called (e.g. pass "holds", fail "does not hold").',
        'questions {"goal","aspect","method","experiment"}: the line at the top of each level’s panel ("{title}" is the node’s).',
        'node {"aspect":[…],"method":[…],"experiment":[…]}: what a node’s second line shows in the graph, in order: "takeaway", "agent", "tally", "findings", or a number from recorded results {"metric","dataset"?,"how":"best"|"sum"|"latest"|"mean"|"count","label"?,"unit"?,"digits"?,"lower"?}.',
        'header [numbers as above]: totals at the top of the page (e.g. what was spent: {"label":"Spent","metric":"cost","how":"sum","unit":"$"}).',
        'views {"goal","aspect","method","experiment"}: each level’s view for nodes with none of their own (markdown with blocks, as research_view takes).',
        'undo: true takes the last change back.',
      ].join(' '),
      // (Each setting named, loosely typed: checked by research-ui's normalizeUi. No record: see research_record.)
      schema: z.object({
        ...projectArg,
        set: z
          .object({ labels: z.any(), plural: z.any(), statuses: z.any(), questions: z.any(), node: z.any(), header: z.any(), views: z.any() })
          .partial()
          .optional(),
        undo: z.boolean().optional(),
      }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const file = parseUiFile(host.researchNotes(projectId).ui?.text);
        const { history = [], ...now } = file;
        if (!a.set && !a.undo) return `Settings now: ${JSON.stringify(now)}${history.length ? ` (${history.length} earlier version${history.length === 1 ? '' : 's'} kept)` : ''}`;
        if (!full(doc)) throw new Error('How the page looks is set with the research’s lead.');
        let next: UiFile;
        if (a.undo) {
          const back = undoUi(file);
          if (!back) throw new Error('Nothing to undo.');
          next = back;
        } else {
          next = changeUi(file, a.set as Record<string, unknown>, new Date().toISOString());
          const { history: _h, ...after } = next;
          // What was asked for and not understood is said, not silently dropped.
          const dropped = Object.keys(a.set as object).filter((k) => (a.set as Record<string, unknown>)[k] !== null && !(k in after));
          if (dropped.length) throw new Error(`Not understood: ${dropped.join(', ')}. See the tool’s description for the settings and their shapes.`);
          for (const text of Object.values(after.views ?? {})) {
            const bad = parseView(text).find((p) => p.type === 'block' && p.error);
            if (bad && bad.type === 'block') throw new Error(bad.error);
          }
        }
        host.researchWriteNote(projectId, 'ui', JSON.stringify(next, null, 2));
        const { history: _h2, ...shown } = next;
        return `${a.undo ? 'Undone' : 'Applied'}; the page shows it now. Settings: ${JSON.stringify(shown)}`;
      },
    },
    {
      name: 'research_update',
      description: 'Changes a node: its title or design, its takeaway (what it comes to so far, in one short line: the graph shows it on the node, so keep it current as results come in), notes that a method borrows an idea from another, or removes it (with everything under it; git history keeps it).',
      schema: z.object({ ...projectArg, node_id: z.string(), title: z.string().min(1).max(200).optional(), design: z.string().max(4000).optional(), takeaway: z.string().max(200).optional().describe('One short line: what this aspect, method or experiment comes to so far ("" to clear).'), borrows_from: z.string().optional(), note: z.string().max(300).optional(), noise: z.number().min(0).optional().describe('An aspect: how noisy one run is, as the user says (0 to forget it).'), remove: z.boolean().optional() }),
      run: async (a) => {
        const { projectId, doc } = await load(a.project);
        const n = nodeIn(doc, a.node_id);
        // An aspect's own agent keeps its aspect's takeaway; anything else about an aspect is the lead's.
        const onlyTakeaway = a.takeaway !== undefined && !a.title && a.design === undefined && !a.remove && !a.borrows_from && typeof a.noise !== 'number';
        if (n.type === 'aspect' && !full(doc) && !(onlyTakeaway && me(doc)?.id === n.id)) throw new Error('Only the research’s lead changes aspects.');
        mayChange(doc, n);
        if (a.remove) {
          save(projectId, removeNode(doc, n.id));
          return `Removed "${n.title}" and what was under it.`;
        }
        let next = doc;
        if (a.title || a.design !== undefined) next = updateNode(next, n.id, { ...(a.title ? { title: String(a.title) } : {}), ...(a.design !== undefined ? { design: String(a.design) || undefined } : {}) });
        if (a.takeaway !== undefined) next = updateNode(next, n.id, { takeaway: String(a.takeaway).trim() || undefined });
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
        save(projectId, next);
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
        save(projectId, { ...doc, policy, updatedAt: new Date().toISOString() });
        // A change of mode reaches the agents already at work (their briefs said the old one).
        if (a.mode && a.mode !== (doc.policy?.mode ?? DEFAULT_MODE)) {
          const zh = host.language() === 'zh';
          for (const n of doc.nodes.filter((x) => x.type === 'aspect' && x.taskId && host.findTaskById(x.taskId) && x.taskId !== (caller.kind === 'agent' ? caller.taskId : ''))) {
            await host.researchTell(caller.kind === 'agent' ? caller.taskId : undefined, n.taskId!, `${zh ? '研究方式改了。' : 'How this research runs has changed. '}${modeText(policy.mode, host.language(), { lead: !!doc.leadTaskId })}`).catch(() => {});
          }
        }
        return `Settings: mode ${policy.mode ?? DEFAULT_MODE}, notes reminders ${policy.autoNotes === false ? 'off' : 'on'}, summary every ${policy.summaryEvery ?? 30} min${policy.summaryEvery === 0 ? ' (never)' : ''}.`;
      },
    },
  );
  if (isMain)
    tools.push(
      {
        name: 'research_create',
        description: 'Starts a research in a project: its title and goal (what should improve, measured how end to end). It is kept in the project’s repository (or, with folder, in that folder of it: a project holding several repositories has one research per repository) and shown on its research page. Then add its aspects with research_add.',
        schema: z.object({ project: z.string().describe('Project name or id.'), folder: z.string().max(200).optional().describe('A folder of the project to keep it in (relative), e.g. the repository it is about.'), title: z.string().min(1).max(200), goal: z.string().max(2000), end_metric: z.string().max(200).optional(), higher_is_better: z.boolean().optional(), baseline: z.number().optional() }),
        run: async (a) => {
          const want = String(a.project).toLowerCase();
          const p = host.allProjects().find((x) => x.projectId.toLowerCase() === want || x.name.toLowerCase() === want);
          if (!p) throw new Error(`No project named "${String(a.project)}".`);
          const dir = a.folder ? String(a.folder).trim().replace(/^\.\/+|\/+$/g, '') : '';
          let doc = await host.researchCreate(p.projectId, String(a.title), String(a.goal ?? ''), false, dir || undefined);
          if (a.end_metric) doc = save(researchId(p.projectId, dir || undefined), { ...doc, endMetric: { name: String(a.end_metric), higherIsBetter: a.higher_is_better !== false, ...(typeof a.baseline === 'number' ? { baseline: a.baseline } : {}) } });
          return `Started research "${doc.title}" in ${dir ? `${p.name}/${dir}` : p.name}. It shows as one row in that project's team in the sidebar.`;
        },
      },
    );
  tools.push(
      {
        name: 'research_read',
        description: 'Reads a conversation of this project (an agent’s messages, its tool calls and what the user said to it), to bring what it did into the research: lay out aspects and methods from it, record its results, then research_attach it.',
        schema: z.object({ ...projectArg, agent: z.string().describe('The agent’s name or role.'), limit: z.number().int().min(1).max(200).optional().describe('How many recent items (default 60).') }),
        run: async (a) => {
          const { projectId, doc } = await load(a.project);
          if (!full(doc)) throw new Error('Reading other conversations is the lead’s.');
          const agent = host.findAgent(String(a.agent));
          if (!agent) throw new Error(`No agent named "${String(a.agent)}".`);
          if (agent.projectId !== parseResearchId(projectId).projectId) throw new Error(`${agent.alias} works in another project.`);
          return host.transcriptText(agent.taskId, typeof a.limit === 'number' ? a.limit : 60) || `${agent.alias} has no messages yet.`;
        },
      },
      {
        name: 'research_attach',
        description: 'Puts an existing conversation into the research, keeping it as it is (no new agent): as an aspect’s agent, or as an experiment under a method, with what it found. Use it to turn one or several earlier conversations into a research: read them first (research_read), lay out a few broad aspects (things of one kind together; an early check for a method goes under that method), then attach each.',
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
          if (agent.projectId !== parseResearchId(projectId).projectId) throw new Error(`${agent.alias} works in another project; a research holds its own project’s agents.`);
          const taken = doc.nodes.find((n) => n.taskId === agent.taskId);
          if (taken) throw new Error(`${agent.alias} is already in the research, at [${taken.id}] "${taken.title}".`);
          if (a.as === 'aspect_agent') {
            const aspect = nodeIn(doc, a.node_id, 'aspect');
            save(projectId, updateNode(doc, aspect.id, { taskId: agent.taskId }));
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
          save(projectId, next);
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
          save(projectId, { ...doc, evidence: [...doc.evidence, { id: `ev-${Date.now().toString(36)}`, kind: a.kind as 'e2e' | 'ablation', title: String(a.title), value: Number(a.value), delta: Number(a.delta), ...(a.kind === 'ablation' ? { aspect: String(a.aspect_id) } : {}), at: new Date().toISOString() }], updatedAt: new Date().toISOString() });
          return `Recorded ${a.kind === 'e2e' ? 'an end-to-end run' : 'an ablation'}: ${String(a.title)}.`;
        },
      },
    );
  return tools;
}

export { routeFor };
