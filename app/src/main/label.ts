// The label shown for an agent: the specific work it is doing, in a few words ("订单接口迁移",
// "Order API migration"). The agent's alias (小王, Alice) stays its stable handle; the label says
// what it is for. Until a model suggests one, the task's own title, shortened, stands in. A model
// writes it: the user's own Claude Code or Codex in the background, else OpenAI when a key is set.

export type Lang = 'en' | 'zh';

const CJK = /[㐀-鿿]/;

/** The language labels are written in: the language of the agent's alias. */
export function labelLang(alias: string): Lang {
  return CJK.test(alias) ? 'zh' : 'en';
}

/** Display width: a Chinese character counts as two Latin ones. */
function width(text: string): number {
  return [...text].reduce((n, c) => n + (CJK.test(c) ? 2 : 1), 0);
}

/** Quotes, markdown, a "Label:" prefix and trailing punctuation off a model's answer; its first line only. */
function unwrap(raw: string): string {
  return (raw.trim().split('\n')[0] ?? '')
    .replace(/^(label|标签|名称)\s*[:：]\s*/i, '')
    .replace(/^[\s"'“”‘’「」『』《》*`#-]+|[\s"'“”‘’「」『』《》*`.。!！,，;；:：]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A label from a model's answer, or undefined when it is empty or too long to show. */
export function cleanLabel(raw: string, lang: Lang): string | undefined {
  const w = unwrap(raw);
  if (w.length < 2) return undefined;
  if (lang === 'zh') return width(w) <= 24 ? w : undefined;
  const words = w.split(' ');
  if (words.length > 5 || w.length > 32) return undefined;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Titles that say nothing about the work (an id, "Untitled", a bare slash command). */
const EMPTY_TITLE = /^(untitled|new (task|session|chat)|无标题|新任务|[0-9a-f-]{16,}|\/\S+|`\/\S+`)$/i;

/** The task's title, shortened, as a label until a model suggests a better one. */
export function titleLabel(title: string, lang: Lang): string | undefined {
  let t = (title.split('\n')[0] ?? '')
    .replace(/^(请|帮我|麻烦|帮忙|please|can you|could you)\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || EMPTY_TITLE.test(t)) return undefined;
  if (lang === 'zh' || CJK.test(t)) {
    let out = '';
    for (const c of t) {
      if (width(out + c) > 20) return `${out}…`;
      out += c;
    }
    return out;
  }
  t = t.charAt(0).toUpperCase() + t.slice(1);
  const words = t.split(' ');
  t = words.slice(0, 4).join(' ');
  return words.length > 4 || t.length > 32 ? `${t.slice(0, 32).trim()}…` : t;
}

/** Asks for the label, given what the agent is doing (title and the user's first messages). */
export function labelPrompt(lang: Lang): string {
  return lang === 'zh'
    ? '用一个简短的标签概括这个编码 Agent 正在做的具体工作：4 到 10 个字，像任务名一样具体，例如“订单接口迁移”“合同时效梳理”“登录页暗色模式”。不要用“前端”“后端”“测试”这类泛泛的领域词，不要带项目名。只回答这个标签。'
    : 'Give a short label for the specific work this coding agent is doing: 2 to 4 words, as specific as a task name, e.g. "Order API migration", "Contract deadlines", "Login dark mode". Not a generic area like "Frontend" or "Tests", and without the project name. Answer with the label only.';
}

/** A second ask when the first answer was not a usable label. */
export function labelRetry(lang: Lang, previous: string): string {
  return lang === 'zh'
    ? `"${previous.slice(0, 40)}" 不行：只回答一个 4 到 10 个字的标签。`
    : `"${previous.slice(0, 40)}" won't do: answer with a label of 2 to 4 words only.`;
}
