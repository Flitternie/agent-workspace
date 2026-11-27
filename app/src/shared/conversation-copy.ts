// A conversation carried into a new session as text: forks and side questions where the CLI cannot copy
// sessions itself (Antigravity), and forks onto another CLI. JSON lines between tags, then what follows.
// Any saved session that starts with one shows the copied conversation, not the tags (see parseCopy).

export interface SaidLine {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

const COPY_OPEN = '<conversation-copy>';
const COPY_CLOSE = '</conversation-copy>';
const COPY_LIMIT = 200_000;

/** Long conversations keep their latest part. `<` is escaped, so no copied text can close the tags or look like markup. */
export function conversationCopy(lines: SaidLine[], after: string): string {
  const kept: SaidLine[] = [];
  let size = 0;
  for (const l of [...lines].reverse()) {
    const line = { role: l.role, text: l.text.slice(0, 20_000) };
    size += line.text.length + 40;
    if (size > COPY_LIMIT) break;
    kept.unshift(line);
  }
  return `${COPY_OPEN}\n${kept.map((l) => JSON.stringify(l).replace(/</g, '\\u003c')).join('\n')}\n${COPY_CLOSE}\n\n${after}`;
}

/** What goes with a copied conversation that is to be continued (forks): only an acknowledgement is asked for. */
export const COPY_NOTE = 'The conversation above is a copy of an earlier conversation with you, carried over from another session. Continue from it as if it were this one. For now reply with only: ok';

/** Goes before the user's first message to an agent continuing a conversation from another CLI. */
export const CARRY_NOTE =
  '(The conversation above was carried over from another coding agent. Continue from it as if it were this one. Its tool results are shortened, and files may have changed since, so read them again when you need their contents.)';

/** The lines of a conversation copy, and the message that came with it (when it is more than the copy's own note). */
export function parseCopy(text: string): { lines: SaidLine[]; rest?: string } | undefined {
  const start = text.indexOf(COPY_OPEN);
  const end = text.indexOf(COPY_CLOSE);
  if (start === -1 || end < start || text.slice(0, start).trim()) return undefined;
  const lines: SaidLine[] = [];
  for (const raw of text.slice(start + COPY_OPEN.length, end).split('\n')) {
    try {
      const l = JSON.parse(raw) as Record<string, unknown>;
      if ((l.role === 'user' || l.role === 'assistant' || l.role === 'tool') && typeof l.text === 'string') lines.push({ role: l.role, text: l.text });
    } catch {
      /* blank */
    }
  }
  const rest = text
    .slice(end + COPY_CLOSE.length)
    .trim()
    .replace(/^\(A side question[^)]*\)\s*/, '')
    .replace(/^\(The conversation above was carried over[^)]*\)\s*/, '');
  return { lines, rest: rest && rest !== COPY_NOTE ? rest : undefined };
}
