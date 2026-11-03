import type { RetryKind, TransientKind } from '../shared/types';

// Model requests sometimes fail for reasons that pass on their own: the model is at
// capacity or overloaded (503, 529), or the account is briefly rate limited (429).
// Such a turn runs again by itself with exponential backoff and jitter, a few times
// over a minute or two, instead of leaving the agent stopped until someone types
// "continue". Plan and quota limits look similar but last for hours, so they are not retried.

export interface RetryPolicy {
  /** Tries in all, the failed one included. */
  attempts: number;
  /** Wait before the first retry; doubles for each one after, up to `maxMs` (then jittered). */
  baseMs: number;
  maxMs: number;
}

/** Five tries, waiting about 4–8 s, 8–16 s, 16–32 s and 30–60 s in between: one to two minutes in all. */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 8_000, maxMs: 60_000 };

/**
 * Wait before retry number `retry` (1 = the first retry). Exponential with "equal jitter":
 * half of each step is fixed and half random, so agents that failed together spread out
 * while no wait shrinks to nothing.
 */
export function retryDelayMs(retry: number, policy: RetryPolicy = DEFAULT_RETRY, random: () => number = Math.random): number {
  const step = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, retry - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

const ACCOUNT_LIMIT = /usage limit|limit reached|hit your limit|quota|billing|credits?\b|upgrade (your|to)/i;
const RATE_LIMIT = /rate[ _-]?limit|too many requests|\b429\b/i;
const CAPACITY = /at capacity|overload|slow[ _]down|service unavailable|temporarily unavailable|\b(502|503|504|529)\b/i;
const BUSY_STATUS = [502, 503, 504, 529];

/** Whether a failed model request is worth trying again soon, from its message and HTTP status. */
export function transientKind(message = '', httpStatus?: number | null): TransientKind | undefined {
  if (ACCOUNT_LIMIT.test(message)) return undefined;
  if (httpStatus === 429 || RATE_LIMIT.test(message)) return 'rate_limit';
  if ((httpStatus && BUSY_STATUS.includes(httpStatus)) || CAPACITY.test(message)) return 'capacity';
  return undefined;
}

export const RETRY_LABEL: Record<RetryKind, string> = { capacity: 'Model at capacity', rate_limit: 'Rate limited', error: 'Model request failed' };

/**
 * What a retry sends. The failed turn's instruction is already in the agent's own history,
 * so this only asks it to carry on (like typing "continue") and never repeats the
 * instruction. The tag hides it when a saved conversation is shown (user-text.ts).
 */
export const RETRY_PROMPT =
  '<agent-workspace-retry>Your previous turn stopped because the model was temporarily unavailable. Continue from where you left off, without redoing work that is already done.</agent-workspace-retry>';
