// Spoken messages are built from several speech segments. The listener cuts a
// segment at every short pause (so transcription can start early); the dock
// keeps appending segments to one message until the speaker has been quiet for
// the hold time, and only then routes and sends it.

const CJK = /[　-ヿ㐀-鿿＀-￯]/;

/** Joins two transcribed segments: no space between CJK text, one space otherwise. */
export function joinSpeech(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  // STT ends every segment with a full stop; drop it when the sentence clearly continues.
  const trimmed = /[a-z]/.test(right[0]) ? left.replace(/[.。]$/, '') : left;
  return CJK.test(trimmed.slice(-1)) || CJK.test(right[0]) ? `${trimmed}${right}` : `${trimmed} ${right}`;
}

// A trailing comma or connective means the speaker is mid-thought.
const CONTINUES =
  /([,，、;；:：…]|\.\.\.|\b(and|but|so|then|or|because|also|like|um+|uh+|the|a|to|with|for|of)|然后|还有|而且|但是|就是|那个|这个|所以|因为|或者|并且|以及|比如|嗯+|呃+|的话)$/i;

/**
 * How long to wait for more speech before sending. Longer when the text sounds
 * unfinished; shorter when it is a finished sentence that names its agent
 * ("Alice, run the tests."), since nothing more is needed to route it.
 */
export function holdMs(text: string, base: number, addressed = false): number {
  const trimmed = text.trim();
  const tail = trimmed.replace(/[.。!！?？]+$/, '');
  if (CONTINUES.test(tail)) return Math.min(Math.round(base * 1.6), 6000);
  if (addressed && /[.。!！?？]$/.test(trimmed)) return Math.max(1200, Math.round(base * 0.6));
  return base;
}

// "Stop / wait / 停 / 等一下" at the very start means: halt the agent now, then listen
// for what to do instead. It must not wait for the pause like an ordinary message.
const STOP = /^\s*(?:(?:stop|wait|hold on|hang on|pause)\b|停一下|停下|停(?=[\s,，。.!！、]|$)|等一下|等等|先别|先停|暂停|别动)[\s,，。.!！、]*/i;

/** Splits a leading stop word off a spoken message. */
export function stopIntent(text: string): { stop: boolean; rest: string } {
  const m = STOP.exec(text);
  return m ? { stop: true, rest: text.slice(m[0].length).trim() } : { stop: false, rest: text.trim() };
}
