import type { LimitWindow, UsageTokens } from '../../shared/types';
import type { ProviderEvent } from './types';

/** Token usage and account limits, read from what Claude Code and Codex report. Pure: fed raw messages. */

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** Unix seconds (or ms, if already that large) → ms. */
const ms = (v: unknown): number | undefined => {
  const n = optNum(v);
  return n === undefined || n <= 0 ? undefined : n < 1e12 ? n * 1000 : n;
};

const WINDOW_MINS: Record<string, number> = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080 };

/** Claude Code `assistant` message: the context it ran with (all of its input, cached or not). */
export function claudeContext(m: unknown): number | undefined {
  const u = rec(rec(rec(m).message).usage);
  if (!Object.keys(u).length) return undefined;
  const n = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  return n > 0 ? n : undefined;
}

/**
 * Claude Code `result` (one per turn): the turn's tokens and API-price cost, and the main model's
 * context window. `modelUsage` covers every model the turn used (sub-agents, the light model);
 * `usage` is the fallback.
 */
export function claudeResultUsage(m: unknown): Extract<ProviderEvent, { type: 'usage' }> | undefined {
  const r = rec(m);
  const models = Object.values(rec(r.modelUsage)).map(rec);
  let add: UsageTokens;
  let contextWindow: number | undefined;
  if (models.length) {
    add = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
    let most = -1;
    for (const u of models) {
      add.input += num(u.inputTokens);
      add.cacheWrite += num(u.cacheCreationInputTokens);
      add.cacheRead += num(u.cacheReadInputTokens);
      add.output += num(u.outputTokens);
      // The model that read the most is the conversation's own (not a helper's).
      const read = num(u.inputTokens) + num(u.cacheCreationInputTokens) + num(u.cacheReadInputTokens);
      if (read > most && optNum(u.contextWindow)) {
        most = read;
        contextWindow = optNum(u.contextWindow);
      }
    }
  } else {
    const u = rec(r.usage);
    if (!Object.keys(u).length && optNum(r.total_cost_usd) === undefined) return undefined;
    add = { input: num(u.input_tokens), cacheWrite: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens), output: num(u.output_tokens), reasoning: 0 };
  }
  const costUsd = optNum(r.total_cost_usd);
  return { type: 'usage', add: { ...add, ...(costUsd !== undefined ? { costUsd } : {}) }, ...(contextWindow ? { contextWindow } : {}) };
}

/** Claude Code `rate_limit_event`: the subscription's windows (5 hours, a week…), used share and reset time. */
export function claudeLimits(m: unknown): LimitWindow[] | undefined {
  const info = rec(rec(m).rate_limit_info);
  const unified = rec(info.unifiedWindows);
  const windows: LimitWindow[] = Object.entries(unified).flatMap(([key, w]) => {
    const u = optNum(rec(w).utilization);
    return u === undefined ? [] : [{ key, ...(WINDOW_MINS[key] ? { mins: WINDOW_MINS[key] } : {}), usedPercent: Math.round(u * 100), ...(ms(rec(w).resetsAt) ? { resetsAt: ms(rec(w).resetsAt) } : {}) }];
  });
  // Older form: only the window that applies now.
  const key = typeof info.rateLimitType === 'string' ? info.rateLimitType : '';
  const u = optNum(info.utilization);
  if (!windows.length && key && u !== undefined) windows.push({ key, ...(WINDOW_MINS[key] ? { mins: WINDOW_MINS[key] } : {}), usedPercent: Math.round(u * 100), ...(ms(info.resetsAt) ? { resetsAt: ms(info.resetsAt) } : {}) });
  return windows.length ? windows : undefined;
}

/** Codex `RateLimitSnapshot`: its primary and secondary windows, and the plan. */
export function codexLimits(snapshot: unknown): { windows: LimitWindow[]; plan?: string } | undefined {
  const s = rec(snapshot);
  const windows: LimitWindow[] = (['primary', 'secondary'] as const).flatMap((key) => {
    const w = rec(s[key]);
    const used = optNum(w.usedPercent);
    if (used === undefined) return [];
    const mins = optNum(w.windowDurationMins);
    return [{ key, ...(mins ? { mins } : {}), usedPercent: Math.round(used), ...(ms(w.resetsAt) ? { resetsAt: ms(w.resetsAt) } : {}) }];
  });
  if (!windows.length) return undefined;
  return { windows, ...(typeof s.planType === 'string' ? { plan: s.planType } : {}) };
}

interface Breakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

function breakdown(v: unknown): Breakdown {
  const b = rec(v);
  const out: Breakdown = {
    inputTokens: num(b.inputTokens),
    cachedInputTokens: num(b.cachedInputTokens),
    cacheWriteInputTokens: num(b.cacheWriteInputTokens),
    outputTokens: num(b.outputTokens),
    reasoningOutputTokens: num(b.reasoningOutputTokens),
    totalTokens: num(b.totalTokens),
  };
  if (!out.totalTokens) out.totalTokens = out.inputTokens + out.outputTokens;
  return out;
}

const minus = (a: Breakdown, b: Breakdown): Breakdown => ({
  inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
  cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
  cacheWriteInputTokens: Math.max(0, a.cacheWriteInputTokens - b.cacheWriteInputTokens),
  outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  reasoningOutputTokens: Math.max(0, a.reasoningOutputTokens - b.reasoningOutputTokens),
  totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
});

/** OpenAI counts cached input within input (and reasoning within output). */
function normalize(b: Breakdown): UsageTokens {
  // Cache writes are within input too when the total says so (input + output).
  const writeWithin = b.totalTokens === b.inputTokens + b.outputTokens;
  return {
    input: Math.max(0, b.inputTokens - b.cachedInputTokens - (writeWithin ? b.cacheWriteInputTokens : 0)),
    cacheWrite: b.cacheWriteInputTokens,
    cacheRead: b.cachedInputTokens,
    output: b.outputTokens,
    reasoning: b.reasoningOutputTokens,
  };
}

/**
 * Codex `thread/tokenUsage/updated` gives the thread's running total. The workspace sums what each
 * session adds, so this turns totals into increments: an update before the session's first turn (as on
 * resume) only sets the baseline; the first update after one without a baseline adds the total when it is just this
 * request (a new count), else only the last request (the total carries the thread's earlier history,
 * already counted); a total that went down started over.
 */
export class CodexUsage {
  private prev?: Breakdown;

  update(params: unknown, inTurn: boolean): Extract<ProviderEvent, { type: 'usage' }> | undefined {
    const usage = rec(rec(params).tokenUsage);
    if (!Object.keys(usage).length) return undefined;
    const total = breakdown(usage.total);
    const last = breakdown(usage.last);
    let add: Breakdown | undefined;
    if (inTurn) {
      if (!this.prev) add = total.totalTokens <= last.totalTokens ? total : last;
      else if (total.totalTokens >= this.prev.totalTokens) add = minus(total, this.prev);
      else add = total;
    }
    this.prev = total;
    const contextWindow = optNum(usage.modelContextWindow) ?? undefined;
    // What the next request starts from: the last one's input and what it wrote.
    const context = last.inputTokens + last.outputTokens || undefined;
    return { type: 'usage', ...(add && add.totalTokens > 0 ? { add: normalize(add) } : {}), ...(context ? { context } : {}), ...(contextWindow ? { contextWindow } : {}) };
  }
}
