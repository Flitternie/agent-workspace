// One-word role shown before an agent's name ("Database Charlie", "数据库小张").
// A keyword guess (or the project's name) is applied at once; a model refines it: the user's own
// Claude Code or Codex in the background, else OpenAI when a key is configured.

type Lang = 'en' | 'zh';

const RULES: Array<{ re: RegExp; en: string; zh: string }> = [
  { re: /\b(database|schema|migrat\w*|sql|postgres\w*|mysql|sqlite|prisma|orm)\b|数据库|迁移|表结构/i, en: 'Database', zh: '数据库' },
  { re: /\b(tests?|testing|coverage|e2e|unit|regression|spec)\b|测试|用例/i, en: 'Tests', zh: '测试' },
  { re: /\b(auth\w*|login|oauth|session|permission|password)\b|登录|鉴权|权限/i, en: 'Auth', zh: '鉴权' },
  { re: /\b(frontend|ui|ux|css|react|vue|component\w*|page|button|layout|style\w*|dashboard)\b|前端|页面|界面|按钮|样式/i, en: 'Frontend', zh: '前端' },
  { re: /\b(backend|api|endpoint\w*|server|service|route\w*|graphql|rest)\b|后端|接口|服务端/i, en: 'Backend', zh: '后端' },
  { re: /\b(deploy\w*|ci|cd|docker|k8s|kubernetes|pipeline|infra\w*|release)\b|部署|发布|运维/i, en: 'DevOps', zh: '运维' },
  { re: /\b(docs?|documentation|readme|guide)\b|文档/i, en: 'Docs', zh: '文档' },
  { re: /\b(perf\w*|optimi[sz]\w*|latency|speed|cache)\b|性能|优化|缓存/i, en: 'Perf', zh: '性能' },
  { re: /\b(refactor\w*|cleanup|clean up|restructur\w*)\b|重构|整理/i, en: 'Refactor', zh: '重构' },
  { re: /\b(bug|fix\w*|crash\w*|error|broken|regress\w*)\b|修复|报错|崩溃/i, en: 'Bugfix', zh: '修复' },
  { re: /\b(review\w*|audit)\b|审查|评审/i, en: 'Review', zh: '评审' },
];

export function guessRole(text: string, lang: Lang): string | undefined {
  const hit = RULES.find((r) => r.re.test(text));
  return hit ? hit[lang] : undefined;
}

/** Words a model tends to add that say nothing about the area ("文档整理工具" → "文档整理"). */
const ZH_FILLER = /(工程师|开发者|开发|助手|专员|负责人|工具|模块|相关|方面|角色)$/;

/**
 * One short word in the requested language, from a model's answer. Quotes, punctuation and, in
 * Chinese, Latin letters and filler endings are dropped first ("后端API" → "后端"); anything still
 * not a single short word is rejected.
 */
export function cleanRole(raw: string, lang: Lang): string | undefined {
  const w = raw.trim().replace(/^[\s"'“”‘’「」『』《》*]+|[\s"'“”‘’「」『』《》*.。!！]+$/g, '');
  if (lang === 'zh') {
    let zh = w.replace(/[^一-鿿]/g, '');
    if (zh.length > 4) zh = zh.replace(ZH_FILLER, '');
    return /^[一-鿿]{2,4}$/.test(zh) ? zh : undefined;
  }
  if (!/^[A-Za-z][A-Za-z0-9-]{1,13}$/.test(w)) return undefined;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** The project's name as a role, when nothing better is known ("agent_workspace" → "AgentWorkspace"). */
export function projectRole(name: string): string | undefined {
  const cjk = name.replace(/[^一-鿿]/g, '');
  if (cjk.length >= 2 && cjk.length <= 6 && cjk.length === name.replace(/[\s_-]/g, '').length) return cjk;
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('');
  if (/^[A-Za-z][A-Za-z0-9]{1,13}$/.test(joined)) return joined;
  const first = words[0] ?? '';
  return /^[A-Za-z][A-Za-z0-9]{1,13}$/.test(first) ? first.charAt(0).toUpperCase() + first.slice(1) : undefined;
}

/** Asks for the role, given what the agent is doing (title and the user's first messages). */
export function rolePrompt(lang: Lang): string {
  return lang === 'zh'
    ? '给一个编码 Agent 起一个角色名，概括它负责的领域，比如 数据库、前端、后端、测试、文档、合同、计费。只回答一个 2 到 4 个汉字的词，不要别的。'
    : 'Name the role of a coding agent from what it is doing, as one capitalized English word describing its area, e.g. Database, Frontend, Backend, Tests, Docs, Billing, Contracts. Answer with that single word only.';
}

/** A second ask when the first answer was not one short word. */
export function roleRetry(lang: Lang, previous: string): string {
  return lang === 'zh'
    ? `"${previous.slice(0, 40)}" 不行：只回答一个 2 到 4 个汉字的词。`
    : `"${previous.slice(0, 40)}" won't do: answer with one English word of at most 14 letters.`;
}
