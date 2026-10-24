// One-word role shown before an agent's name ("Database Charlie", "数据库小张").
// A keyword guess is applied at once; the LLM (when configured) refines it.

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

/** Accepts one short word in the requested language; anything else is rejected. */
export function cleanRole(raw: string, lang: Lang): string | undefined {
  const w = raw.trim().replace(/^["'“”‘’]+|["'“”‘’.。]+$/g, '');
  if (lang === 'zh') return /^[一-鿿]{2,4}$/.test(w) ? w : undefined;
  if (!/^[A-Za-z][A-Za-z0-9-]{1,13}$/.test(w)) return undefined;
  return w.charAt(0).toUpperCase() + w.slice(1);
}
