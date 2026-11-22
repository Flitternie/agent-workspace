// An agent's name (its alias: 小陈, Alice) is the handle the user says or types to reach it, so a name
// the user picks has to stay a handle: one agent per name, and none of the words the router and the
// main agent already give a meaning to ("main", "new", "大家"...).

export type AliasProblem = 'empty' | 'long' | 'chars' | 'taken' | 'reserved';

export const ALIAS_MAX = 24;

/**
 * Words that already mean something to the router, the coordinator or the main agent: the main
 * agent's own name, the classifier's targets (NEW / COORDINATOR / UNSURE), everyone at once, the
 * words routing reads as "an agent" / "the task", and the providers' names.
 */
const RESERVED = new Set(
  [
    'main', 'main agent', 'coordinator', 'new', 'unsure', 'none', 'all', 'everyone', 'everybody', 'anyone', 'nobody',
    'agent', 'agents', 'task', 'tasks', 'status', 'session', 'workspace', 'overview', 'project', 'system', 'assistant',
    'user', 'you', 'me', 'i', 'we', 'it', 'this', 'that', 'here', 'the', 'a', 'an', 'and', 'or', 'to', 'please',
    'claude', 'codex', 'mock',
    '主', '主 agent', '主agent', '主代理', '协调者', '大家', '所有', '所有人', '全部', '全体', '每个人', '状态', '新建', '新的', '新任务',
    '代理', '助手', '任务', '会话', '项目', '系统', '用户', '你', '我', '我们', '它', '这个', '那个',
  ].map((w) => w.toLowerCase()),
);

/** Letters (any script), digits, and inner spaces, dots, dashes, underscores. */
const SHAPE = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u;

export function normalizeAlias(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/** Why `name` cannot be this agent's name, or null when it can. `others` are every agent (this one included). */
export function aliasProblem(name: string, others: ReadonlyArray<{ taskId: string; alias: string }>, selfId: string): AliasProblem | null {
  const n = normalizeAlias(name);
  if (!n) return 'empty';
  if ([...n].length > ALIAS_MAX) return 'long';
  if (!SHAPE.test(n)) return 'chars';
  if (RESERVED.has(n.toLowerCase())) return 'reserved';
  if (others.some((o) => o.taskId !== selfId && o.alias.toLowerCase() === n.toLowerCase())) return 'taken';
  return null;
}

/** English text for a problem (the renderer translates it; the main process throws it). */
export const ALIAS_PROBLEM_TEXT: Record<AliasProblem, string> = {
  empty: 'A name cannot be empty.',
  long: 'Keep the name to 24 characters or fewer.',
  chars: 'Use letters, numbers, spaces, dots or dashes.',
  taken: 'Another agent already has this name.',
  reserved: 'This word already means something to the workspace; pick another name.',
};
