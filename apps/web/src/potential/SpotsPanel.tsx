import {
  spotWalkLabel,
  spotWindowLabel,
  standWindRisk,
  type BestSpotsState,
} from '@atlas/app-hooks';
import { fmtClock } from '@atlas/core';
import { spotApproachLabel, spotColor, spotPlaceDraft, type PotentialSpot } from '@atlas/potential';

/**
 * "Best spots in view" — the shortlist beside the map (ROADMAP § N5 → E6).
 *
 * What makes this more than a legend is that each row answers the three
 * questions a heatmap cannot: *why here* (the surface's own strongest factor),
 * *when* (today's conditions window, the other half of D3's structure/conditions
 * split), and *how far in from the road* — the number that decides whether a
 * prime shoreline is tonight's plan or next summer's.
 *
 * Two rules are enforced here rather than left to the reader:
 *
 * - **An empty list is a finding.** The surface's own sentence is shown ("no
 *   standout water in view"), never a blank panel that reads as breakage.
 * - **A provisional list says so.** While cells are still being derived, the
 *   best water in view may not be in the list yet, and presenting eight of them
 *   as *the* answer would be a claim the data does not support.
 */
/**
 * The affordance that opens the shortlist.
 *
 * Deliberately not automatic: the list is a request against the derive service
 * and the router, and a panel that appeared by itself over every prepared cell
 * would both cost work nobody asked for and take over a map the user may be
 * reading for something else.
 */
export function SpotsButton({
  onOpen,
  hunting = false,
}: {
  onOpen: () => void;
  hunting?: boolean;
}) {
  return (
    <button type="button" className="spots-button" onClick={onOpen}>
      {hunting ? 'Plan stands in view' : 'Best spots in view'}
    </button>
  );
}

export function SpotsPanel({
  state,
  targetLabel,
  saveEnabled,
  onPick,
  onSave,
  onClose,
}: {
  state: BestSpotsState;
  /** The target's display name, which only the catalog row knows. */
  targetLabel?: string;
  saveEnabled: boolean;
  onPick: (spot: PotentialSpot) => void;
  onSave: (spot: PotentialSpot, index: number) => void;
  onClose: () => void;
}) {
  const { spots, window: conditions } = state;
  return (
    <aside className="spots-panel" aria-label="Best spots in view">
      <div className="spots-head">
        <strong>{state.mode === 'stands' ? 'Calling stands in view' : 'Best spots in view'}</strong>
        {targetLabel && <span className="spots-target">{targetLabel}</span>}
        <button type="button" className="spots-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* The when, once — one forecast covers a viewport this size, and met.no
          asks not to be polled per point. */}
      {conditions && (
        <p className={`spots-window spots-window-${conditions.rating}`}>
          <strong>Best window today {spotWindowLabel(conditions, fmtClock)}</strong>
          <span>{conditions.summary}</span>
        </p>
      )}
      {!conditions && state.windowNote && <p className="spots-window-note">{state.windowNote}</p>}

      {state.pending > 0 && (
        <p className="spots-pending" role="status">
          Still reading {state.pending} more area{state.pending === 1 ? '' : 's'} — this list may
          still change.
        </p>
      )}

      {state.status === 'loading' && spots.length === 0 && <p className="spots-note">Looking…</p>}
      {(state.status === 'empty' || state.status === 'error') && (
        <p className="spots-note">{state.note ?? 'Nothing to show here.'}</p>
      )}
      {state.status === 'ready' && state.note && <p className="spots-note">{state.note}</p>}

      <ol className="spots-list">
        {spots.map((spot, index) => {
          const walk = spotWalkLabel(spot);
          const wind = standWindRisk(spot, conditions);
          const approach = spotApproachLabel(spot);
          const approachRisk = spot.access?.approach?.risk;
          return (
            <li
              key={spot.id}
              className={[
                wind === 'blown' ? 'stand-blown' : '',
                approachRisk === 'high' ? 'stand-approach-high' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                className="spots-row"
                onClick={() => onPick(spot)}
                title="Show this spot on the map"
              >
                <span className="spots-number" style={{ background: spotColor(spot) }}>
                  {index + 1}
                </span>
                <span className="spots-row-text">
                  <span className="spots-row-head">
                    {spot.bandLabel}
                    {walk && <span className="spots-walk"> · {walk}</span>}
                  </span>
                  <span className="spots-reason">{spot.reason}</span>
                  {spot.stand && (
                    <span className="spots-reason">
                      Vantage {spot.stand.vantageM >= 0 ? '+' : ''}
                      {spot.stand.vantageM} m ·{' '}
                      {wind === 'blown'
                        ? 'wind carries scent toward habitat — avoid'
                        : wind === 'good'
                          ? 'wind carries scent away from habitat'
                          : wind === 'crosswind'
                            ? 'crosswind — check locally'
                            : 'verify wind and backstop on site'}
                    </span>
                  )}
                  {spot.stand && spot.access && (
                    <span className={`spots-reason spots-approach-${approachRisk ?? 'unknown'}`}>
                      {approach ??
                        (spot.access.approximate
                          ? 'Direct off-path approach has too little cover data to assess.'
                          : 'Approach cover could not be assessed.')}
                    </span>
                  )}
                </span>
              </button>
              <button
                type="button"
                className="spots-save"
                disabled={!saveEnabled}
                title={`Save “${spotPlaceDraft(spot, index, { targetLabel }).name}”`}
                onClick={() => onSave(spot, index)}
              >
                ★
              </button>
            </li>
          );
        })}
      </ol>

      {spots.length > 0 && !state.accessAvailable && (
        <p className="spots-note">Walk-in times are unavailable right now.</p>
      )}
    </aside>
  );
}
