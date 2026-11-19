import type { Lane, LaneRow } from '../../shared/main-lanes';
import { t } from '../i18n';

// The main agent's conversation, git-graph style: time runs down, its own lane on the left, one lane
// (one colour) per agent it handed work to. A hand-off curves from the main lane into that agent's
// lane; an agent coming back is a point on its lane. Rows are your messages (open them in the
// conversation) and hand-offs (open the agent).

const HUES = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#ef4444'];
const STEP = 14; // between lanes
const PAD = 9; // left of the main lane
const ROW = 28;

export const laneColor = (lane: number) => (lane === 0 ? 'var(--text-3)' : HUES[(lane - 1) % HUES.length]);

export function MainLanes({ lanes, rows, onJump, onOpenAgent }: { lanes: Lane[]; rows: LaneRow[]; onJump: (itemId: string) => void; onOpenAgent: (taskId: string) => void }) {
  const x = (lane: number) => PAD + lane * STEP;
  const width = x(lanes.length) + PAD;
  const mid = ROW / 2;
  const lastAsk = rows.map((r) => r.kind).lastIndexOf('ask');
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
              <svg width={width} height={ROW} aria-hidden className="lanes-svg">
                {/* The main lane, from your first message to your last. */}
                {n <= lastAsk ? <line x1={x(0)} y1={n === 0 ? mid : 0} x2={x(0)} y2={n === lastAsk ? mid : ROW} stroke={laneColor(0)} strokeWidth={1.5} /> : null}
                {lanes.map((l, k) =>
                  n >= l.first && n <= l.last ? <line key={k} x1={x(k + 1)} y1={n === l.first ? mid : 0} x2={x(k + 1)} y2={n === l.last ? mid : ROW} stroke={laneColor(k + 1)} strokeWidth={2} /> : null,
                )}
                {handOff ? (
                  <path
                    d={`M ${x(r.from ?? 0)} ${r.from !== undefined ? mid : 0} C ${x(r.from ?? 0)} ${mid} ${x(r.lane)} ${r.from !== undefined ? mid : 0} ${x(r.lane)} ${mid}`}
                    fill="none"
                    stroke={color}
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
                ) : (
                  <circle cx={x(r.lane)} cy={mid} r={4.5} fill={r.kind === 'failed' ? 'var(--panel)' : color} stroke={color} strokeWidth={1.5} />
                )}
              </svg>
              {r.kind === 'ask' ? (
                <button className="lanes-label ask" onClick={() => onJump(r.itemId)} title={r.label}>
                  <span className="truncate">{r.label}</span>
                </button>
              ) : (
                <button className="lanes-label" style={{ ['--lane' as string]: color }} onClick={() => (lane?.taskId ? onOpenAgent(lane.taskId) : onJump(r.turnId))} title={[lane?.alias, lane?.name, lane?.projectName].filter(Boolean).join(' · ')}>
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
                  {handOff && lane?.name && lane.name !== lane.alias ? <span className="lanes-name truncate">{lane.name}</span> : null}
                </button>
              )}
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
      <svg width={8 + lanes.length * 6} height={120} aria-hidden>
        <line x1={4} y1={0} x2={4} y2={120} stroke={laneColor(0)} strokeWidth={1.5} />
        {lanes.map((l, k) => (
          <line key={l.alias} x1={10 + k * 6} y1={(l.first / h) * 120} x2={10 + k * 6} y2={Math.max((l.last / h) * 120, (l.first / h) * 120 + 4)} stroke={laneColor(k + 1)} strokeWidth={2} strokeLinecap="round" />
        ))}
      </svg>
    </button>
  );
}
