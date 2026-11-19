import { useEffect, useMemo, useState } from 'react';
import type { Lane, LaneRow } from '../../shared/main-lanes';
import type { Task } from '../../shared/types';
type TaskStatus = Task['status'];
import { call } from '../api';
import { t } from '../i18n';

// The main agent's conversation, git-graph style: time runs down, its own lane on the left (your
// messages), one lane (one colour) per agent it handed work to. A hand-off curves from the main
// lane into that agent's lane; an agent coming back is a point on its lane; where a lane ends, how
// that agent is doing now (its status and latest summary). Columns are reused once a lane has ended;
// past the limit at once, extra agents share the last column, drawn plain but still named.
// A long message shows as a few words (from the user's own CLI, kept), the whole on hover.

// Twelve distinct hues; lanes on screen together never share one (see Lane.hue).
const HUES = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#22c55e', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316', '#a855f7'];
const STEP = 14; // between columns
const PAD = 9; // left of the main lane
const ROW = 28;
const LEGEND_MAX = 8;
/** Messages longer than this get a short label. */
const LONG = 16;

const hueColor = (hue: number) => HUES[hue % HUES.length];

type Outcome = { status: TaskStatus; summary?: string };
type Row = LaneRow | { kind: 'outcome'; lane: number; itemId: string };

const STATUS: Partial<Record<TaskStatus, string>> = {
  running: 'working',
  starting: 'working',
  waiting_for_user: 'waiting on you',
  done: 'done',
  idle: 'done',
  failed: 'failed',
};

export function MainLanes({
  lanes,
  rows,
  outcomes = {},
  onJump,
  onOpenAgent,
  compact,
}: {
  /** Beside the conversation (narrow): hand-offs name the agent only, leaving the room to your words. */
  compact?: boolean;
  lanes: Lane[];
  rows: LaneRow[];
  /** How each agent is doing now, by task id. */
  outcomes?: Record<string, Outcome>;
  onJump: (itemId: string) => void;
  onOpenAgent: (taskId: string) => void;
}) {
  const [allLegend, setAllLegend] = useState(false);
  const short = useShortLabels(rows.filter((r) => r.kind === 'ask').map((r) => r.label));
  // Each lane ends with how its agent is doing now.
  const display = useMemo(() => {
    const out: Row[] = [];
    rows.forEach((r, n) => {
      out.push(r);
      lanes.forEach((l, k) => {
        if (l.last === n && l.taskId && outcomes[l.taskId]) out.push({ kind: 'outcome', lane: k + 1, itemId: `outcome-${l.alias}` });
      });
    });
    const span = lanes.map((_, k) => {
      const idx = out.map((r, n) => (r.lane === k + 1 || ('from' in r && r.from === k + 1) ? n : -1)).filter((n) => n >= 0);
      return { first: idx[0], last: idx[idx.length - 1] };
    });
    return { out, span };
  }, [rows, lanes, outcomes]);
  const cols = lanes.length ? Math.max(...lanes.map((l) => l.col)) + 1 : 0;
  const x = (lane: number) => PAD + (lane === 0 ? 0 : (lanes[lane - 1].col + 1) * STEP);
  const width = PAD + cols * STEP + PAD;
  const mid = ROW / 2;
  const lastAsk = display.out.map((r) => r.kind).lastIndexOf('ask');
  const legend = allLegend ? lanes : lanes.slice(0, LEGEND_MAX);
  return (
    <div className="main-lanes" data-testid="main-lanes">
      <div className="lanes-legend">
        {legend.map((l) => {
          const k = lanes.indexOf(l);
          return (
            <button key={l.alias} className="lane-chip" style={{ ['--lane' as string]: hueColor(l.hue) }} disabled={!l.taskId} onClick={() => l.taskId && onOpenAgent(l.taskId)} title={[l.alias, l.name, l.projectName].filter(Boolean).join(' · ')} data-testid="lane-chip">
              <span className="lane-dot" aria-hidden />
              {l.alias}
              {l.projectName ? <span className="lane-project">{l.projectName}</span> : null}
            </button>
          );
        })}
        {lanes.length > LEGEND_MAX ? (
          <button className="lane-chip more" onClick={() => setAllLegend(!allLegend)} data-testid="lane-more">
            {allLegend ? t('Fewer') : `+${lanes.length - LEGEND_MAX}`}
          </button>
        ) : null}
      </div>
      <ol className="lanes-rows">
        {display.out.map((r, n) => {
          const lane = lanes[r.lane - 1];
          const color = r.lane === 0 ? 'var(--text-3)' : hueColor(lane?.hue ?? 0);
          const plain = lane?.shared;
          const handOff = r.kind === 'send' || r.kind === 'create' || r.kind === 'fork' || r.kind === 'failed';
          const outcome = r.kind === 'outcome' && lane?.taskId ? outcomes[lane.taskId] : undefined;
          const askText = r.kind === 'ask' ? (short[r.label] ?? r.label) : '';
          return (
            <li key={r.itemId} className={`lanes-row kind-${r.kind}`} data-testid="lane-row" data-kind={r.kind} data-lane={r.lane}>
              <button
                className="lanes-hit"
                style={{ ['--lane' as string]: color }}
                onClick={() => (r.kind === 'ask' ? onJump(r.itemId) : lane?.taskId ? onOpenAgent(lane.taskId) : 'turnId' in r ? onJump(r.turnId) : undefined)}
                title={r.kind === 'ask' ? r.label : outcome ? [lane?.alias, outcome.summary].filter(Boolean).join(' · ') : [lane?.alias, lane?.name, lane?.projectName].filter(Boolean).join(' · ')}
                data-testid="lane-hit"
              >
                <svg width={width} height={ROW} aria-hidden className="lanes-svg">
                  {/* The main lane, from your first message to your last. */}
                  {n <= lastAsk ? <line x1={x(0)} y1={n === 0 ? mid : 0} x2={x(0)} y2={n === lastAsk ? mid : ROW} stroke="var(--text-3)" strokeWidth={1.5} /> : null}
                  {lanes.map((l, k) => {
                    const { first, last } = display.span[k];
                    if (first === undefined || n < first || n > last) return null;
                    return (
                      <line key={k} x1={x(k + 1)} y1={n === first ? mid : 0} x2={x(k + 1)} y2={n === last ? mid : ROW} stroke={l.shared ? 'var(--text-3)' : hueColor(l.hue)} strokeWidth={l.shared ? 1.5 : 2} strokeDasharray={l.shared ? '2 3' : undefined} />
                    );
                  })}
                  {handOff ? (
                    <path
                      d={`M ${x('from' in r && r.from !== undefined ? r.from : 0)} ${'from' in r && r.from !== undefined ? mid : 0} C ${x('from' in r && r.from !== undefined ? r.from : 0)} ${mid} ${x(r.lane)} ${'from' in r && r.from !== undefined ? mid : 0} ${x(r.lane)} ${mid}`}
                      fill="none"
                      stroke={plain ? 'var(--text-3)' : color}
                      strokeWidth={2}
                      strokeDasharray={r.kind === 'failed' ? '3 3' : undefined}
                    />
                  ) : null}
                  {r.kind === 'ask' ? (
                    <circle cx={x(0)} cy={mid} r={4} fill="var(--panel)" stroke="var(--text-2)" strokeWidth={1.5} />
                  ) : r.kind === 'waiting' ? (
                    <rect x={x(r.lane) - 4} y={mid - 4} width={8} height={8} transform={`rotate(45 ${x(r.lane)} ${mid})`} fill="var(--panel)" stroke={color} strokeWidth={2} />
                  ) : r.kind === 'settled' ? (
                    <circle cx={x(r.lane)} cy={mid} r={3} fill="var(--panel)" stroke={color} strokeWidth={1.5} />
                  ) : r.kind === 'outcome' ? (
                    <rect x={x(r.lane) - 3.5} y={mid - 3.5} width={7} height={7} rx={1.5} fill={outcome?.status === 'failed' ? 'var(--risk)' : color} />
                  ) : (
                    <circle cx={x(r.lane)} cy={mid} r={4.5} fill={r.kind === 'failed' ? 'var(--panel)' : color} stroke={color} strokeWidth={1.5} />
                  )}
                </svg>
                {r.kind === 'ask' ? (
                  <span className="lanes-label ask">
                    <span className="truncate">{askText}</span>
                  </span>
                ) : r.kind === 'outcome' ? (
                  <span className="lanes-label outcome">
                    <span className={`lanes-verb status-${outcome?.status}`}>{t(STATUS[outcome?.status ?? 'idle'] ?? 'done')}</span>
                    <span className="lanes-alias">{lane?.alias}</span>
                    {outcome?.summary && !compact ? <span className="lanes-name truncate">{outcome.summary}</span> : null}
                  </span>
                ) : (
                  <span className="lanes-label">
                    <span className="lanes-verb">
                      {r.kind === 'send' ? t('to') : r.kind === 'create' ? t('new') : r.kind === 'fork' ? t('fork') : r.kind === 'failed' ? t('not delivered') : r.kind === 'waiting' ? t('waiting on you') : t('done')}
                    </span>
                    <span className="lanes-alias">{lane?.alias ?? ('label' in r ? r.label : '')}</span>
                    {handOff && !compact && lane?.name && lane.name !== lane.alias ? <span className="lanes-name truncate">{lane.name}</span> : null}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Short labels for long messages, asked one at a time (the answers are kept by the app). */
function useShortLabels(texts: string[]): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const long = texts.filter((x) => x.length > LONG).join('\n');
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const text of long.split('\n').filter(Boolean)) {
        if (!live) return;
        if (labels[text]) continue;
        const label = await call('label:short', { text }).catch(() => undefined);
        if (live && label) setLabels((cur) => ({ ...cur, [text]: label }));
      }
    })();
    return () => {
      live = false;
    };
  }, [long]);
  return labels;
}

/** No room beside the conversation: the lanes' outline (a thin line per column); opens the full view. */
export function MainLanesMini({ lanes, rows, onOpen }: { lanes: Lane[]; rows: LaneRow[]; onOpen: () => void }) {
  const h = Math.max(1, rows.length);
  const cols = lanes.length ? Math.max(...lanes.map((l) => l.col)) + 1 : 0;
  return (
    <button className="session-minimap lanes-mini" onClick={onOpen} title={t('Agents')} aria-label={t('Agents')} data-testid="lanes-mini">
      <svg width={8 + cols * 6} height={120} aria-hidden>
        <line x1={4} y1={0} x2={4} y2={120} stroke="var(--text-3)" strokeWidth={1.5} />
        {lanes.map((l, k) => (
          <line key={l.alias} x1={10 + l.col * 6} y1={(l.first / h) * 120} x2={10 + l.col * 6} y2={Math.max((l.last / h) * 120, (l.first / h) * 120 + 4)} stroke={l.shared ? 'var(--text-3)' : hueColor(l.hue)} strokeWidth={2} strokeLinecap="round" />
        ))}
      </svg>
    </button>
  );
}
