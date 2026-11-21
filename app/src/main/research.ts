// A project's research, kept in its repository: <root>/.research/research.json (it travels with the
// code; git history keeps what was pruned). Read and written here; the page edits a copy and saves it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../shared/types';
import { emptyResearch, normalizeResearch, type ResearchDoc, type ResearchNode } from '../shared/research';
import { atomicWrite } from './store';

const DIR = '.research';
const FILE = 'research.json';
const README = `# .research

The research tree Agent Workspace shows for this project: aspects, the methods tried in each, their
experiments (one agent each), findings, and the end-to-end runs and ablations behind them.
Edited from the app; plain JSON, so it can be read or changed by hand or by other tools.
`;

export function researchFile(project: Project): string {
  return join(project.rootPath, DIR, FILE);
}

/** On this Mac only for now: a project on an SSH host has its files there. */
function local(project: Project): void {
  if (project.host) throw new Error('Research is not available yet for projects on SSH hosts.');
}

export function readResearch(project: Project): ResearchDoc | null {
  if (project.host) return null;
  const file = researchFile(project);
  if (!existsSync(file)) return null;
  try {
    return normalizeResearch(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function writeResearch(project: Project, doc: ResearchDoc): void {
  local(project);
  const dir = join(project.rootPath, DIR);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'README.md'))) writeFileSync(join(dir, 'README.md'), README);
  atomicWrite(researchFile(project), `${JSON.stringify(doc, null, 2)}\n`);
}

export function createResearch(project: Project, title: string, goal: string, sample: boolean, lang: 'en' | 'zh'): ResearchDoc {
  local(project);
  if (readResearch(project)) throw new Error('This project already has a research.');
  const doc = sample ? sampleResearch(lang, title, goal) : emptyResearch(title.trim(), goal.trim());
  writeResearch(project, doc);
  return doc;
}

/**
 * A filled-in example (no agents behind it): three aspects with their own validation, methods and
 * experiments, a combination validated end to end, a mutation, a borrowed idea, findings, and the
 * end-to-end runs and ablations that say which aspects matter.
 */
export function sampleResearch(lang: 'en' | 'zh', title?: string, goal?: string): ResearchDoc {
  const zh = lang === 'zh';
  const L = (en: string, cn: string) => (zh ? cn : en);
  const now = Date.now();
  const at = (min: number) => new Date(now - (300 - min) * 60_000).toISOString();
  const nodes: ResearchNode[] = [];
  let i = 0;
  const node = (n: Omit<ResearchNode, 'id' | 'createdAt'>): ResearchNode => {
    const x = { ...n, id: `s${i++}`, createdAt: at(i * 3) } as ResearchNode;
    nodes.push(x);
    return x;
  };
  const aspect = (title: string, metric?: ResearchNode['metric'], combos?: boolean) => node({ type: 'aspect', parent: null, title, status: 'running', metric, combos });
  const method = (a: ResearchNode, title: string, design: string, extra: Partial<ResearchNode> = {}) => node({ type: 'method', parent: a.id, title, status: 'running', design, ...extra });
  const exp = (m: ResearchNode, title: string, value: number | undefined, status: ResearchNode['status'], findings: string[] = []) =>
    node({ type: 'experiment', parent: m.id, title, status, value, config: title, findings: findings.map((text, k) => ({ id: `sf${i}-${k}`, text, by: L('agent', 'agent'), at: at(i * 3 + 1) })) });

  const data = aspect(L('Data', '数据处理'), { name: L('data quality score', '数据质量分'), higherIsBetter: true, baseline: 71, digits: 1 });
  const dedup = method(data, L('Deduplication', '去重'), L('MinHash near-duplicate removal before tokenizing.\nKey parameter: similarity threshold.', '分词前用 MinHash 去掉近似重复。\n关键参数：相似度阈值。'));
  exp(dedup, L('threshold 0.8', '阈值 0.8'), 73.2, 'pass');
  exp(dedup, L('threshold 0.85', '阈值 0.85'), 76.4, 'pass', [L('Deduplicating harder also removes code samples; 0.85 is the turning point.', '去重太狠会把代码样本一起删掉，阈值 0.85 是拐点。')]);
  exp(dedup, L('threshold 0.9', '阈值 0.9'), 70.1, 'fail');
  const code = method(data, L('Mix in code', '代码语料混入'), L('Add a share of permissively licensed code to the web data.', '在网页数据里混入一定比例的代码语料。'));
  exp(code, '5%', 74.0, 'pass');
  exp(code, '10%', 77.9, 'pass', [L('10% code clearly raises the score of reasoning-type samples.', '10% 代码语料让推理类样本的质量分明显提高。')]);
  exp(code, '20%', undefined, 'running');
  method(data, L('Back-translation', '回译增强'), L('Paraphrase rare-domain text through a second language.', '通过另一种语言回译，扩充小众领域文本。'), { status: 'idea', source: L('proposed by the aspect agent', '方面 agent 提出') });

  const arch = aspect(L('Architecture', '模型结构'), { name: L('50M proxy loss', '50M 代理 loss'), higherIsBetter: false, baseline: 3.412, digits: 3 });
  const act = method(arch, L('Activation', '激活函数'), L('Replace GELU in the MLP blocks.', '替换 MLP 里的 GELU。'));
  exp(act, 'SwiGLU', 3.371, 'pass');
  exp(act, 'GeGLU', 3.389, 'pass');
  exp(act, 'ReLU²', 3.425, 'fail');
  const pos = method(arch, L('Positional encoding', '位置编码'), L('Rotary embeddings: base frequency, or ALiBi instead.', '旋转位置编码的基频，或改用 ALiBi。'));
  exp(pos, 'RoPE θ=10k', 3.402, 'pass');
  exp(pos, 'RoPE θ=500k', 3.391, 'pass');
  exp(pos, 'ALiBi', 3.430, 'fail', [L('ALiBi loses to RoPE on short sequences.', 'ALiBi 在短序列上不如 RoPE。')]);
  const attn = method(arch, L('Attention', '注意力'), L('Grouped-query attention and QK normalization.', '分组查询注意力和 QK 归一化。'));
  exp(attn, L('GQA 4 groups', 'GQA 4 组'), 3.398, 'pass');
  exp(attn, 'QK-norm', 3.362, 'pass', [L('QK-norm lets the learning rate go 1.5× higher without diverging.', 'QK-norm 让 lr 可以放大 1.5 倍而不发散。')]);
  exp(attn, 'GQA + QK-norm', undefined, 'running');
  const yarn = method(arch, L('Positional encoding · length extrapolation', '位置编码 · 长度外推版'), L('RoPE θ=500k plus YaRN scaling at inference.', '在 RoPE θ=500k 基础上加 YaRN 缩放。'), { links: [{ from: pos.id, kind: 'mutate' }] });
  exp(yarn, 'YaRN s=4', 3.388, 'pass');
  exp(yarn, 'YaRN s=8', undefined, 'running');

  const train = aspect(L('Training', '训练策略'), { name: L('small-scale val acc', '小规模 val acc'), higherIsBetter: true, baseline: 0.611, digits: 3 });
  const opt = method(train, L('Optimizer', '优化器'), L('AdamW against Muon and Lion at the same budget.', '同样预算下比较 AdamW、Muon、Lion。'));
  exp(opt, 'Muon', 0.624, 'pass');
  exp(opt, 'Lion', 0.605, 'fail');
  const sched = method(train, L('Learning-rate schedule', '学习率调度'), L('Cosine against warmup-stable-decay.', 'cosine 对比 warmup-stable-decay。'), { links: [{ from: act.id, kind: 'borrow', note: L('SwiGLU needs a longer warmup', 'SwiGLU 需要更长 warmup') }] });
  exp(sched, 'WSD', undefined, 'running');
  method(train, L('EMA weights', 'EMA 权重'), L('Evaluate an exponential moving average of the weights.', '用权重的指数滑动平均来评估。'), { status: 'idea', source: L('paper: 2 related works', '文献：相关论文 2 篇') });

  const combos = aspect(L('Across aspects', '跨方面组合'), { name: L('end-to-end val acc', '端到端 val acc'), higherIsBetter: true, baseline: 0.842, digits: 3 }, true);
  const c1 = method(combos, L('Code mix + QK-norm', '代码语料 + QK-norm'), L('Data: 10% code. Architecture: QK-norm. A full 2-hour run.', '数据：10% 代码语料；模型：QK-norm；跑完整 2 小时训练。'), { links: [{ from: code.id, kind: 'combine' }, { from: attn.id, kind: 'combine' }] });
  exp(c1, L('full run #1', '完整训练 #1'), 0.871, 'pass');
  exp(c1, L('full run #2 (new seed)', '完整训练 #2（换种子）'), undefined, 'running');

  return {
    version: 1,
    title: title?.trim() || L('nanochat pretraining', 'nanochat 预训练调优'),
    goal: goal?.trim() || L('Raise end-to-end validation accuracy within a 2-hour training budget.', '在 2 小时训练预算内提升端到端验证集准确率。'),
    endMetric: { name: L('end-to-end val acc', '端到端 val acc'), higherIsBetter: true, baseline: 0.842, digits: 3 },
    nodes,
    evidence: [
      { id: 'ev1', kind: 'e2e', title: L('Data + architecture best', '数据 + 结构最优'), value: 0.871, delta: 0.029, at: at(200) },
      { id: 'ev2', kind: 'ablation', title: L('Without the data changes', '去掉数据改动'), value: 0.858, delta: -0.013, aspect: data.id, at: at(240) },
      { id: 'ev3', kind: 'ablation', title: L('Without the architecture changes', '去掉结构改动'), value: 0.855, delta: -0.016, aspect: arch.id, at: at(260) },
      { id: 'ev4', kind: 'ablation', title: L('Without the data changes (new seed)', '去掉数据改动（换种子）'), value: 0.860, delta: -0.011, aspect: data.id, at: at(280) },
    ],
    createdAt: at(0),
    updatedAt: at(290),
  };
}
