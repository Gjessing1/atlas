import type { StandBoardRow, StandBoardState } from '@atlas/app-hooks';
import { standCellSummary, type StandDayCell, type StandSit } from '@atlas/conditions';
import { fmtDayLabel } from '@atlas/core';

/**
 * "My stands" — the saved-stand board beside the map.
 *
 * The shortlist next to this one answers *where should I sit?*, asked once per
 * area. This answers the question a season actually repeats: **which of the
 * stands I already have is on tonight?** — and it is deliberately built out of
 * things the hunter already saved, so it works on ground that was planned in
 * August and is being hunted in November.
 *
 * Three rules are enforced in the layout rather than left to the reader:
 *
 * - **Scent leads.** The verdict is the first thing in a row, above the score,
 *   because a prime stand you are blown out of is not tonight's plan. Ranking
 *   agrees with the layout: `compareStandCells` sorts by verdict first.
 * - **Morning and evening are separate questions**, so they are separate tabs
 *   rather than one "today" that quietly means whichever the peak hour fell in.
 * - **Days 4–10 look different because they are different.** Past ~3 days met.no
 *   turns 6-hourly and a six-hour average cannot resolve a dawn sit. Those cells
 *   are hatched and say so; what stays exact is the *timing*, which comes from
 *   the sun and needs no forecast at all.
 */
export function StandBoardButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="spots-button" onClick={onOpen}>
      My stands
    </button>
  );
}

const VERDICT_CLASS: Record<string, string> = {
  good: 'stand-scent-good',
  crosswind: 'stand-scent-crosswind',
  blown: 'stand-scent-blown',
};

function cellClass(cell: StandDayCell | null, selected: boolean): string {
  return [
    'stand-day',
    selected ? 'stand-day-selected' : '',
    cell?.coarse ? 'stand-day-coarse' : '',
    cell?.scent ? VERDICT_CLASS[cell.scent.verdict] : 'stand-day-unknown',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The ten-day strip for one stand: one glance at the week, and the day picker. */
function StandDays({
  row,
  dayOffset,
  onPickDay,
}: {
  row: StandBoardRow;
  dayOffset: number;
  onPickDay: (offset: number) => void;
}) {
  return (
    <div className="stand-days" role="group" aria-label={`Ten days at ${row.name}`}>
      {row.days.map((day, index) => {
        const summary = standCellSummary(day);
        return (
          <button
            key={day.dayMs}
            type="button"
            className={cellClass(day, index === dayOffset)}
            onClick={() => onPickDay(index)}
            title={`${fmtDayLabel(day.dayMs)} · ${summary.windowLabel} · ${summary.scentLabel}${
              summary.coarseNote ? ` · ${summary.coarseNote}` : ''
            }`}
          >
            <span className="stand-day-name">{fmtDayLabel(day.dayMs).slice(0, 3)}</span>
            <span className="stand-day-wind">{summary.windLabel?.split(' ')[0] ?? '·'}</span>
          </button>
        );
      })}
    </div>
  );
}

export function StandBoardPanel({
  state,
  onPick,
  onClose,
}: {
  state: StandBoardState;
  onPick: (row: StandBoardRow) => void;
  onClose: () => void;
}) {
  const sits: { key: StandSit; label: string }[] = [
    { key: 'morning', label: 'Morning' },
    { key: 'evening', label: 'Evening' },
  ];
  const selectedDay = state.dayStamps[state.dayOffset];
  return (
    <aside className="spots-panel" aria-label="My stands">
      <div className="spots-head">
        <strong>My stands</strong>
        <span className="spots-target">
          {selectedDay === undefined ? 'saved plans' : fmtDayLabel(selectedDay)}
        </span>
        <button type="button" className="spots-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="stand-sits" role="group" aria-label="Which sit">
        {sits.map((sit) => (
          <button
            key={sit.key}
            type="button"
            className={`stand-sit${state.sit === sit.key ? ' stand-sit-on' : ''}`}
            aria-pressed={state.sit === sit.key}
            onClick={() => state.setSit(sit.key)}
          >
            {sit.label}
          </button>
        ))}
      </div>

      {state.status === 'loading' && <p className="spots-note">Reading the wind…</p>}
      {state.note && <p className="spots-note">{state.note}</p>}

      <ol className="spots-list stand-board-list">
        {state.rows.map((row) => {
          const cell = row.cell;
          const summary = cell ? standCellSummary(cell) : null;
          return (
            <li key={row.placeId} className={cell?.scent?.verdict === 'blown' ? 'stand-blown' : ''}>
              <div className="stand-board-row">
                <button
                  type="button"
                  className="spots-row"
                  onClick={() => onPick(row)}
                  title="Show this stand on the map"
                >
                  <span className="spots-row-text">
                    <span className="spots-row-head">
                      {row.name}
                      {summary && <span className="spots-walk"> · {summary.windowLabel}</span>}
                    </span>
                    {summary && (
                      <span
                        className={`stand-verdict ${
                          cell?.scent ? VERDICT_CLASS[cell.scent.verdict] : 'stand-day-unknown'
                        }`}
                      >
                        {summary.scentLabel}
                        {summary.windLabel && (
                          <span className="stand-verdict-wind"> {summary.windLabel}</span>
                        )}
                        {summary.ratingLabel && (
                          <span className="spots-walk"> · {summary.ratingLabel}</span>
                        )}
                      </span>
                    )}
                    <span className="spots-reason">{summary?.detail}</span>
                    {summary?.coarseNote && (
                      <span className="spots-reason stand-coarse-note">{summary.coarseNote}</span>
                    )}
                    {summary?.polarNote && (
                      <span className="spots-reason stand-coarse-note">{summary.polarNote}</span>
                    )}
                    {/* The revived thermal factor is only worth naming where the
                        ground is steep enough to organise a flow. */}
                    {row.slopeDeg !== null && row.slopeDeg >= 3 && (
                      <span className="spots-reason">
                        {Math.round(row.slopeDeg)}° slope
                        {row.aspectDeg === null ? '' : ` falling ${row.aspectDeg}°`} — thermals
                        count in a light wind.
                      </span>
                    )}
                  </span>
                </button>
                <StandDays row={row} dayOffset={state.dayOffset} onPickDay={state.setDayOffset} />
              </div>
            </li>
          );
        })}
      </ol>

      {state.rows.length > 0 && (
        <p className="spots-note">
          Wind and light only — a stand is still yours to check for a safe backstop and the legal
          season.
        </p>
      )}
    </aside>
  );
}
