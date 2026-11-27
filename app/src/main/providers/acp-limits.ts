// Account usage limits of an ACP CLI, where it can print them without a model call (the registry's
// `limits` arguments). ACP itself has no limits call; Antigravity's session/new only names the
// plan (`_meta.antigravity.tier`). Antigravity: `agy -p /usage --output-format json` answers with
// its /usage panel as data, no turn and no tokens:
//   command.data.groups[]: { name, buckets[]: { id, name, window: "5h" | "weekly", remaining_fraction, reset_time } }
// Each group of models (Gemini; Claude and GPT) has its own windows. The first group (the default
// models') fills the plan's usual two windows (five_hour, seven_day: the sidebar's one line); the
// others are listed by name in the card.
import type { LimitWindow } from '../../shared/types';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A window's length from Antigravity's name for it ("5h", "weekly", "daily", "30m"). */
function windowMins(w: string): number | undefined {
  if (/^week(ly)?$/i.test(w)) return 10080;
  if (/^(daily|day)$/i.test(w)) return 1440;
  const m = /^(\d+)\s*(m|h|d)$/i.exec(w);
  if (!m) return undefined;
  return Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2].toLowerCase() as 'm'];
}

/** "Gemini Models" → "Gemini"; "Claude and GPT models" → "Claude and GPT". */
const groupLabel = (name: string) => name.replace(/\s+models?$/i, '').trim() || name;

/** The parsed JSON of the limits command; undefined when it holds no windows (signed out, an error). */
export function parseAcpLimits(output: unknown): { windows: LimitWindow[] } | undefined {
  const groups = arr(rec(rec(rec(output).command).data).groups).map(rec);
  const windows: LimitWindow[] = [];
  groups.forEach((g, gi) => {
    for (const b of arr(g.buckets).map(rec)) {
      const fraction = b.remaining_fraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction)) continue;
      const mins = windowMins(str(b.window));
      const main = gi === 0 && (mins === 300 || mins === 10080);
      const reset = Date.parse(str(b.reset_time));
      windows.push({
        key: main ? (mins === 300 ? 'five_hour' : 'seven_day') : `acp:${str(b.id) || `${gi}-${str(b.window)}`}`,
        ...(mins ? { mins } : {}),
        usedPercent: Math.max(0, Math.min(100, Math.round((1 - fraction) * 100))),
        // An unused window has no reset time (Antigravity sends the epoch).
        ...(Number.isFinite(reset) && reset > Date.UTC(2000, 0, 1) ? { resetsAt: reset } : {}),
        label: groupLabel(str(g.name)),
      });
    }
  });
  return windows.length ? { windows } : undefined;
}

/** The output of the limits command, parsed (it prints one JSON object, maybe after log lines). */
export function parseAcpLimitsOutput(stdout: string): { windows: LimitWindow[] } | undefined {
  const start = stdout.indexOf('{');
  if (start === -1) return undefined;
  try {
    return parseAcpLimits(JSON.parse(stdout.slice(start)));
  } catch {
    return undefined;
  }
}

/** The account's plan, as a session/new result's `_meta` names it (Antigravity: `_meta.antigravity.tier.name`). */
export function planOf(result: Rec): string | undefined {
  for (const v of Object.values(rec(result._meta))) {
    const name = str(rec(rec(v).tier).name);
    if (name) return name;
  }
  return undefined;
}

/**
 * Reads limits at most once a minute per machine (each agent asks after its turns; one answer serves
 * them all), and never two at once.
 */
export class AcpLimitsReader {
  private seen = new Map<string, { at: number; job?: Promise<{ windows: LimitWindow[] } | undefined> }>();

  constructor(
    private exec: (host: string | undefined) => Promise<{ code: number | null; stdout: string }>,
    private gapMs = 60_000,
  ) {}

  read(host?: string): Promise<{ windows: LimitWindow[] } | undefined> {
    const key = host ?? '';
    const s = this.seen.get(key);
    if (s?.job) return s.job;
    if (s && Date.now() - s.at < this.gapMs) return Promise.resolve(undefined);
    const job = this.exec(host)
      .then((r) => (r.code === 0 ? parseAcpLimitsOutput(r.stdout) : undefined))
      .catch(() => undefined)
      .finally(() => this.seen.set(key, { at: Date.now() }));
    this.seen.set(key, { at: Date.now(), job });
    return job;
  }
}
