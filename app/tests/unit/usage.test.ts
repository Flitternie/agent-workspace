import { describe, expect, it } from 'vitest';
import { claudeContext, claudeLimits, claudeResultUsage, CodexUsage, codexLimits } from '../../src/main/providers/usage';
import { addUsage, mergeLimits } from '../../src/main/workspace';
import { formatTokens, usageTotals, windowLabel } from '../../src/renderer/components/SessionUsage';

// Messages as Claude Code (stream-json) and Codex (app-server) send them.
const claudeAssistant = {
  type: 'assistant',
  uuid: 'u1',
  message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, cache_creation_input_tokens: 1200, cache_read_input_tokens: 23500, output_tokens: 40 } },
};
const claudeResult = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.1234,
  usage: { input_tokens: 10, cache_creation_input_tokens: 1200, cache_read_input_tokens: 47000, output_tokens: 300 },
  modelUsage: {
    'claude-opus-5-5': { inputTokens: 10, outputTokens: 300, cacheReadInputTokens: 47000, cacheCreationInputTokens: 1200, costUSD: 0.12, contextWindow: 1000000, maxOutputTokens: 64000 },
    'claude-haiku-4-5': { inputTokens: 500, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0034, contextWindow: 200000, maxOutputTokens: 8000 },
  },
};
const claudeRateLimit = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1795000000,
    rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: 1795000000, status: 'allowed' }, seven_day: { utilization: 0.35, resetsAt: 1795400000, status: 'allowed' } },
    isUsingOverage: false,
  },
};
const bd = (input: number, cached: number, output: number, reasoning = 0) => ({ inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output });

describe('Claude Code usage', () => {
  it('reads the context from the latest assistant message', () => {
    expect(claudeContext(claudeAssistant)).toBe(24703);
    expect(claudeContext({ type: 'assistant', message: { content: [] } })).toBeUndefined();
  });

  it('sums a turn over every model it used, with its API-price cost and the main model’s window', () => {
    expect(claudeResultUsage(claudeResult)).toEqual({
      type: 'usage',
      add: { input: 510, cacheWrite: 1200, cacheRead: 47000, output: 320, reasoning: 0, costUsd: 0.1234 },
      contextWindow: 1000000,
    });
  });

  it('falls back to the turn’s usage without modelUsage', () => {
    const { modelUsage: _m, ...plain } = claudeResult;
    expect(claudeResultUsage(plain)?.add).toEqual({ input: 10, cacheWrite: 1200, cacheRead: 47000, output: 300, reasoning: 0, costUsd: 0.1234 });
  });

  it('reads the 5-hour and weekly windows', () => {
    expect(claudeLimits(claudeRateLimit)).toEqual([
      { key: 'five_hour', mins: 300, usedPercent: 34, resetsAt: 1795000000000 },
      { key: 'seven_day', mins: 10080, usedPercent: 35, resetsAt: 1795400000000 },
    ]);
    expect(claudeLimits({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBeUndefined();
  });
});

describe('Codex usage', () => {
  it('turns the thread’s running totals into increments', () => {
    const c = new CodexUsage();
    const first = c.update({ threadId: 't', turnId: 'a', tokenUsage: { total: bd(10000, 8000, 500, 100), last: bd(10000, 8000, 500, 100), modelContextWindow: 272000 } }, true);
    expect(first).toEqual({ type: 'usage', add: { input: 2000, cacheWrite: 0, cacheRead: 8000, output: 500, reasoning: 100 }, context: 10500, contextWindow: 272000 });
    const second = c.update({ tokenUsage: { total: bd(22000, 18000, 900, 150), last: bd(12000, 10000, 400, 50), modelContextWindow: 272000 } }, true);
    expect(second?.add).toEqual({ input: 2000, cacheWrite: 0, cacheRead: 10000, output: 400, reasoning: 50 });
    expect(second?.context).toBe(12400);
  });

  it('counts nothing for totals seen before the session’s first turn (resume), then only what is new', () => {
    const c = new CodexUsage();
    expect(c.update({ tokenUsage: { total: bd(50000, 40000, 2000), last: bd(12000, 10000, 400), modelContextWindow: 272000 } }, false)?.add).toBeUndefined();
    expect(c.update({ tokenUsage: { total: bd(63000, 51000, 2300), last: bd(13000, 11000, 300), modelContextWindow: 272000 } }, true)?.add).toEqual({ input: 2000, cacheWrite: 0, cacheRead: 11000, output: 300, reasoning: 0 });
  });

  it('adds only the last request when a resumed thread’s first total carries its history', () => {
    const c = new CodexUsage();
    expect(c.update({ tokenUsage: { total: bd(63000, 51000, 2300), last: bd(13000, 11000, 300) } }, true)?.add).toEqual({ input: 2000, cacheWrite: 0, cacheRead: 11000, output: 300, reasoning: 0 });
  });

  it('reads the account’s windows and plan', () => {
    expect(codexLimits({ primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1795000000 }, secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1795400000 }, planType: 'pro', credits: null })).toEqual({
      windows: [
        { key: 'primary', mins: 300, usedPercent: 34, resetsAt: 1795000000000 },
        { key: 'secondary', mins: 10080, usedPercent: 81, resetsAt: 1795400000000 },
      ],
      plan: 'pro',
    });
    expect(codexLimits({ primary: null, secondary: null })).toBeUndefined();
  });
});

describe('accumulating usage', () => {
  it('adds tokens and cost across turns and sessions, and replaces the context', () => {
    let u = addUsage(undefined, claudeResultUsage(claudeResult)!);
    u = addUsage(u, { type: 'usage', context: 24703 });
    u = addUsage(u, claudeResultUsage(claudeResult)!);
    expect(u).toMatchObject({ input: 1020, cacheWrite: 2400, cacheRead: 94000, output: 640, costUsd: 0.2468, context: 24703, contextWindow: 1000000 });
    const { total, cacheHit } = usageTotals(u);
    expect(total).toBe(1020 + 2400 + 94000 + 640);
    expect(Math.round(cacheHit!)).toBe(96);
  });

  it('keeps windows the latest limits do not mention', () => {
    const a = mergeLimits(undefined, [{ key: 'primary', mins: 300, usedPercent: 10 }, { key: 'secondary', mins: 10080, usedPercent: 20 }], 'plus');
    const b = mergeLimits(a, [{ key: 'primary', mins: 300, usedPercent: 15 }]);
    expect(b.windows.map((w) => [w.key, w.usedPercent])).toEqual([['primary', 15], ['secondary', 20]]);
    expect(b.plan).toBe('plus');
  });

  it('formats counts and window names', () => {
    expect([950, 2345, 24700, 115000, 999_400, 1_000_000, 1_234_000].map(formatTokens)).toEqual(['950', '2.3K', '24.7K', '115K', '999K', '1M', '1.2M']);
    expect(windowLabel({ key: 'five_hour', mins: 300, usedPercent: 1 })).toBe('5h');
    expect(windowLabel({ key: 'seven_day', mins: 10080, usedPercent: 1 })).toBe('week');
    expect(windowLabel({ key: 'seven_day_opus', mins: 10080, usedPercent: 1 })).toBe('week Opus');
  });
});

describe('limits per account', () => {
  it('keeps a provider on another machine apart from the same provider on this Mac', async () => {
    const { withLimits } = await import('../../src/main/workspace');
    const w = (usedPercent: number) => [{ key: 'five_hour', minutes: 300, usedPercent, resetsAt: 0 }] as never;
    let all = withLimits({}, { provider: 'claude' }, w(34));
    all = withLimits(all, { provider: 'claude', host: 'neptune' }, w(81));
    all = withLimits(all, { provider: 'codex' }, w(12));
    expect(Object.keys(all).sort()).toEqual(['claude', 'claude@neptune', 'codex']);
    expect(all.claude.windows[0].usedPercent).toBe(34);
    expect(all['claude@neptune'].windows[0].usedPercent).toBe(81);
    expect(all['claude@neptune'].host).toBe('neptune');
    // A newer reading for one account leaves the others alone.
    all = withLimits(all, { provider: 'claude', host: 'neptune' }, w(90));
    expect(all.claude.windows[0].usedPercent).toBe(34);
    expect(all['claude@neptune'].windows[0].usedPercent).toBe(90);
  });
});
