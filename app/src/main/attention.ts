// Turns an agent's final message into a concise, substantive card report.
// Heuristic only: these items carry no provider request id, so any reply sent to
// the task resolves them; native approvals/questions are handled separately.

const QUESTION_END = /[?？]\s*$/;
const ASKING =
  /\b(should i|shall i|do you want|would you like|which (one|option)|can you confirm|please confirm|let me know|how would you like)\b|要不要|是否|需要我|你希望|请确认|确认一下/i;

function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
    .map((s) => s.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim())
    .filter((s) => s.length > 1);
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Is the agent ending its turn by asking the user something? */
export function asksUser(finalText: string): boolean {
  const parts = sentences(finalText);
  const tail = parts.slice(-3);
  return tail.some((s) => QUESTION_END.test(s)) || tail.some((s) => ASKING.test(s));
}

/** The most decision-relevant sentence: the last question if any, else the first sentence. */
export function headlineFor(finalText: string): string {
  const parts = sentences(finalText);
  if (!parts.length) return 'Finished a turn.';
  let qi = -1;
  for (let i = parts.length - 1; i >= 0; i--)
    if (QUESTION_END.test(parts[i]) || ASKING.test(parts[i])) {
      qi = i;
      break;
    }
  if (qi === -1) return clip(parts[0], 160);
  // A bare "Should I proceed?" says nothing on its own: keep the sentence that gives it context.
  const withContext = parts[qi].length < 70 && qi > 0 ? `${parts[qi - 1]} ${parts[qi]}` : parts[qi];
  return clip(withContext, 200);
}

/** Summary line for the card while the agent is not asking anything. */
export function summaryFor(finalText: string): string {
  const parts = sentences(finalText);
  return clip(parts.slice(0, 2).join(' ') || 'Finished.', 200);
}
