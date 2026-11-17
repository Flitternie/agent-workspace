// Turning something the user said in an agent's conversation into a memory note, when the
// user asks for it ("Remember" on their message). Not the message as it is: what it says
// about how the user wants things done, read in the light of the conversation around it
// (what the agent did that the user corrected, what they keep asking to adjust).

export interface DistillContext {
  /** The user's message to remember. */
  message: string;
  /** The conversation just before (and a little after) it, oldest first. */
  around: Array<{ role: 'user' | 'assistant'; text: string; isTarget?: boolean }>;
  /** Notes already in memory that could overlap (user memory and this project's). */
  existing: Array<{ id: string; scope: 'user' | 'project'; title: string; text: string }>;
  projectName?: string;
}

export interface DistillResult {
  /** False when the message holds nothing worth keeping beyond this conversation. */
  worth: boolean;
  title: string;
  body: string;
  scope: 'user' | 'project';
  /** An existing note this one restates or refines (its id), if any. */
  similarId?: string;
  /** One sentence: why this note, why this scope. */
  reason: string;
}

export const DISTILL_SYSTEM = `You write memory notes for a coding agent workspace. The user marked one of their own messages in a conversation with an agent and asked to remember it. Read the message in the light of the conversation: what the agent did that the user corrected, what they keep asking to change, a preference or a convention they state. Write ONE durable note that future agents should follow, not a summary of this conversation.

Rules:
- Generalise from the specific case to the lasting rule, but stay concrete (name the tool, file type, style or habit).
- Body in Markdown: first the rule in one or two sentences; then "**Why:** ..." (the reason, from the conversation or the user's words); then "**How to apply:** ..." (when and how an agent should act on it).
- Write in the language of the user's message.
- scope "project" when it is about this project only (its code, layout, commands, conventions); "user" when it is about how the user likes to work in general (communication, style, workflow, tools).
- "similarId" only when an existing note is about the same thing (says it already, or this message refines or contradicts it): give its id and write the body as the improved version of that note, keeping what still holds. A note on a different topic is not similar, even if both are preferences; then null.
- If the message holds nothing worth keeping beyond this conversation (a one-off instruction about this task), set "worth" to false and explain in "reason".
- Title: a short label (a few words), no trailing period.

Answer with one JSON object only, no prose around it:
{"worth": true|false, "title": "...", "body": "...", "scope": "user"|"project", "similarId": "<id>"|null, "reason": "..."}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function distillPrompt(c: DistillContext): string {
  const convo = c.around.map((m) => `${m.isTarget ? '>>> THE MESSAGE TO REMEMBER <<<\n' : ''}[${m.role}] ${clip(m.text.trim(), 1500)}`).join('\n\n');
  const notes = c.existing.length ? c.existing.map((n) => `- id=${n.id} (${n.scope}) ${n.title}: ${clip(n.text.replace(/\s+/g, ' '), 200)}`).join('\n') : '(none)';
  return [
    c.projectName ? `Project: ${c.projectName}` : '',
    `Conversation (oldest first):\n\n${convo}`,
    `The user's message to remember:\n${c.message.trim()}`,
    `Existing notes that might overlap:\n${notes}`,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

/** The JSON object in a model's answer (fenced or not), checked; throws if there is none. */
export function parseDistill(answer: string, existingIds: string[]): DistillResult {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model did not return a note.');
  const j = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const similar = str(j.similarId);
  return {
    worth: j.worth !== false,
    title: str(j.title).replace(/\.$/, '').slice(0, 120),
    body: str(j.body),
    scope: j.scope === 'project' ? 'project' : 'user',
    similarId: similar && existingIds.includes(similar) ? similar : undefined,
    reason: str(j.reason),
  };
}
