import type { Lane, LaneRow } from '../../shared/main-lanes';
import { t } from '../i18n';

// The main agent's conversation as lanes: time runs down, one lane (one colour) per agent it handed
// work to, and no lane of its own (it does no work itself), so lanes never cross. A hand-off is a
// point on the agent's lane, labelled with what you asked; a fork branches off right beside its
// origin; an agent coming back is a point on its lane. A message that handed nothing off is a faint
// row. A row opens the agent (or, for your message, its place in the conversation).

const HUES = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#ef4444'];
const STEP = 14; // between lanes
const PAD = 9; // left of the main lane
const ROW = 28;

export const laneColor = (lane: number) => (lane === 0 ? 'var(--text-3)' : HUES[(lane - 1) % HUES.length]);

export function MainLanes({ lanes, rows, onJump, onOpenAgent }: { lanes: Lane[]; rows: LaneRow[]; onJump: (itemId: string) => void; onOpenAgent: (taskId: string) => void }) {
  const x = (lane: number) => PAD + (lane - 1) * STEP;
  const width = Math.max(x(lanes.length) + PAD, 2 * PAD);
  const mid = ROW / 2;
  return (
    <div className="main-lanes" data-testid="main-lanes">
      <div className="lanes-legend">
        {lanes.map((l, k) => (
          <button key={l.alias} className="lane-chip" style={{ ['--lane' as string]: laneColor(k + 1) }} disabled={!l.taskId} onClick={() => l.taskId && onOpenAgent(l.taskId)} title={[l.alias, l.name, l.projectName].filter(Boolean).join(' · ')} data-testid="lane-chip">
            <span className="lane-dot" aria-hidden />
            {l.alias}
            {l.projectName ? <span className="lane-project">{l.projectName}</span> : null}
          </button>
        ))}
      </div>
      <ol className="lanes-rows">
        {rows.map((r, n) => {
          const lane = lanes[r.lane - 1];
          const handOff = r.kind === 'send' || r.kind === 'create' || r.kind === 'fork' || r.kind === 'failed';
          const color = laneColor(r.lane);
          return (
            <li key={r.itemId} className={`lanes-row kind-${r.kind}`} data-testid="lane-row" data-kind={r.kind} data-lane={r.lane}>
              <button
                className="lanes-hit"
                style={{ ['--lane' as string]: color }}
                onClick={() => (r.kind === 'ask' ? onJump(r.itemId) : lane?.taskId ? onOpenAgent(lane.taskId) : onJump(r.turnId))}
                title={r.kind === 'ask' ? r.label : [[lane?.alias, lane?.projectName].filter(Boolean).join(' · '), r.ask].filter(Boolean).join('\n')}
                data-testid="lane-hit"
              >
              <svg width={width} height={ROW} aria-hidden className="lanes-svg">
                {lanes.map((l, k) =>
                  n >= l.first && n <= l.last ? <line key={k} x1={x(k + 1)} y1={n === l.first ? mid : 0} x2={x(k + 1)} y2={n === l.last ? mid : ROW} stroke={laneColor(k + 1)} strokeWidth={2} /> : null,
                )}
                {/* A fork branches off its origin (the lane right beside it). */}
                {r.from !== undefined ? <path d={`M ${x(r.from)} ${mid - 8} C ${x(r.from)} ${mid} ${x(r.lane)} ${mid - 8} ${x(r.lane)} ${mid}`} fill="none" stroke={color} strokeWidth={2} /> : null}
                {r.kind === 'ask' ? null : r.kind === 'waiting' ? (
                  <rect x={x(r.lane) - 4} y={mid - 4} width={8} height={8} transform={`rotate(45 ${x(r.lane)} ${mid})`} fill="var(--panel)" stroke={color} strokeWidth={2} />
                ) : r.kind === 'settled' ? (
                  <circle cx={x(r.lane)} cy={mid} r={3} fill="var(--panel)" stroke={color} strokeWidth={1.5} />
                ) : (
                  <circle cx={x(r.lane)} cy={mid} r={4.5} fill={r.kind === 'failed' ? 'var(--panel)' : color} stroke={color} strokeWidth={1.5} />
                )}
              </svg>
              {r.kind === 'ask' ? (
                <span className="lanes-label ask">
                  <span className="truncate">{r.label}</span>
                </span>
              ) : (
                <span className="lanes-label">
                  <span className="lanes-verb">
                    {r.kind === 'send'
                      ? t('to')
                      : r.kind === 'create'
                        ? t('new')
                        : r.kind === 'fork'
                          ? t('fork')
                          : r.kind === 'failed'
                            ? t('not delivered')
                            : r.kind === 'waiting'
                              ? t('waiting on you')
                              : t('done')}
                  </span>
                  <span className="lanes-alias">{lane?.alias ?? r.label}</span>
                  {handOff && r.ask ? <span className="lanes-name truncate">{r.ask}</span> : null}
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

/** No room beside the conversation: the lanes' outline (a thin line per agent); opens the full view. */
export function MainLanesMini({ lanes, rows, onOpen }: { lanes: Lane[]; rows: LaneRow[]; onOpen: () => void }) {
  const h = Math.max(1, rows.length);
  return (
    <button className="session-minimap lanes-mini" onClick={onOpen} title={t('Agents')} aria-label={t('Agents')} data-testid="lanes-mini">
      <svg width={4 + lanes.length * 6} height={120} aria-hidden>
        {lanes.map((l, k) => (
          <line key={l.alias} x1={4 + k * 6} y1={(l.first / h) * 120} x2={4 + k * 6} y2={Math.max((l.last / h) * 120, (l.first / h) * 120 + 4)} stroke={laneColor(k + 1)} strokeWidth={2} strokeLinecap="round" />
        ))}
      </svg>
    </button>
  );
}
