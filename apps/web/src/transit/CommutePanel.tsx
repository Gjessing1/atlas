import {
  useCommuteDashboard,
  useCommuteEditor,
  type CommuteController,
  type CommuteDashboard,
  type CommuteDashboardBoard,
} from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import {
  COMMUTE_STATE_LABEL,
  fetchTransitStopLines,
  liveTimetableLabel,
  type CommuteBoardRow,
  type CommuteDisruption,
  type CommuteJourney,
  type CommuteServiceState,
  type TransitMode,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useState } from 'react';

import { useGeocode } from '../routing/useGeocode.js';
import { CommuteEditorForm } from './CommuteEditor.js';

/**
 * The commute dashboard — ROADMAP §6.4.
 *
 * What this replaced was a configuration form with a result list underneath it:
 * three stop pickers, two time fields, seven day chips and a wall of line chips
 * before the first departure time. It answered "is my commute set up correctly"
 * on a screen opened to answer "when do I leave".
 *
 * So the order is inverted and the emphasis with it. Reading down: which
 * direction and when it is now; what leaving *now* actually gets you; the
 * complete journey options as one scannable line each, expandable to their legs
 * and connections; then the per-leg boards for someone already mid-journey.
 * Configuration is one button, opened on demand — or by itself when there is
 * not yet enough saved to ask a question at all.
 *
 * Everything shown here is computed in `@atlas/transit` and `useCommuteDashboard`;
 * this file is markup and CSS classes. The Android sheet renders the same model
 * with `<View>`s, which is the only way two clients can promise the same
 * departure time.
 */

/** One glyph per mode. The word is in `modeLabel`; this is the thing you see first. */
const MODE_GLYPH: Partial<Record<TransitMode, string>> = {
  bus: '🚌',
  coach: '🚌',
  rail: '🚆',
  metro: '🚇',
  tram: '🚊',
  water: '⛴️',
  air: '✈️',
  cableway: '🚡',
  funicular: '🚞',
  foot: '🚶',
};

const glyph = (mode: TransitMode) => MODE_GLYPH[mode] ?? '•';

/**
 * A colour comes from what a service *is*, never from where it sits in a list —
 * the rule the home-screen widget learned the hard way, applied here so the two
 * surfaces of one commute cannot disagree about which departure is in trouble.
 */
const stateClass = (state: CommuteServiceState) => `commute-state-${state}`;

/**
 * Disruptions under the service they affect (§4).
 *
 * `brief` is the collapsed form, and it is not a nicety. Driven against the live
 * board, the full form put two amber boxes and five lines of Norwegian operator
 * prose between the first journey's scan line and the second's — on the one
 * screen §12 says must show three journeys at a glance. So a collapsed row gets
 * the headline and the expanded legs get the whole notice, which is where
 * someone who has chosen a journey is actually reading.
 */
function Disruptions({
  items,
  brief = false,
}: {
  items: readonly CommuteDisruption[];
  brief?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={`commute-disruptions${brief ? ' brief' : ''}`}>
      {items.map((item) => (
        <li key={item.key} className={`commute-disruption sev-${item.severity}`}>
          <strong>
            {item.severity === 'info' ? 'ⓘ' : '⚠'} {item.kindLabel}
          </strong>
          <span>{item.summary}</span>
          {!brief && item.detail && <em>{item.detail}</em>}
          {!brief && item.url && (
            <a href={item.url} target="_blank" rel="noreferrer noopener">
              Operator’s notice
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * One journey, collapsed to its scan line and expandable to its legs.
 *
 * The collapsed row is the whole point of §12: departure, arrival and total,
 * all scheduled times, in one line that can be compared against the row above
 * it without reading either. The live estimate sits under the departure as a
 * labelled secondary, never in place of it.
 */
function JourneyRow({
  journey,
  open,
  onToggle,
}: {
  journey: CommuteJourney;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={`commute-journey ${stateClass(journey.state)}`}>
      <button
        type="button"
        className="commute-journey-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="commute-journey-times">
          <strong>{journey.departure.aimed}</strong>
          <i aria-hidden="true" />
          <strong>{journey.arrival.aimed}</strong>
        </span>
        <span className="commute-journey-duration">{journey.duration}</span>
      </button>
      <div className="commute-journey-meta">
        <span className="commute-journey-lines">
          {journey.rides.map((ride) => (
            <span key={ride.key} className={stateClass(ride.state)}>
              <i aria-hidden="true">{glyph(ride.mode)}</i>
              {ride.line}
            </span>
          ))}
        </span>
        <span className="commute-journey-note">
          {[
            journey.dayNote,
            journey.departure.confidence === 'timetable'
              ? COMMUTE_STATE_LABEL.scheduled
              : journey.departure.delay
                ? `${journey.departure.expected} est.`
                : COMMUTE_STATE_LABEL.live,
            journey.transfers,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      {/* Collapsed: the headline only. The full notice waits inside, under the
          leg it belongs to. */}
      {!open && <Disruptions items={journey.disruptions} brief />}
      {open && (
        <ol className="commute-legs">
          {journey.rides.map((ride, index) => {
            const connection = journey.connections[index - 1];
            return (
              <li key={ride.key}>
                {connection && (
                  <p className={`commute-connection${connection.tight ? ' tight' : ''}`}>
                    Change at {connection.at} · {connection.label}
                    {connection.tight ? ' — tight' : ''}
                  </p>
                )}
                <div className="commute-leg">
                  <span className="commute-leg-time">
                    <strong>{ride.departure.aimed}</strong>
                    {ride.departure.delay && <em>{ride.departure.expected} est.</em>}
                  </span>
                  <span className="commute-leg-body">
                    <strong>
                      {glyph(ride.mode)} {ride.line}
                      {ride.towards ? ` → ${ride.towards}` : ''}
                    </strong>
                    <span>{[ride.from, ride.fromQuay].filter(Boolean).join(' · ')}</span>
                    <span className="commute-leg-ride">{ride.ride}</span>
                  </span>
                </div>
                <div className="commute-leg">
                  <span className="commute-leg-time">
                    <strong>{ride.arrival.aimed}</strong>
                    {ride.arrival.delay && <em>{ride.arrival.expected} est.</em>}
                  </span>
                  <span className="commute-leg-body">
                    <span>{[ride.to, ride.toQuay].filter(Boolean).join(' · ')}</span>
                  </span>
                </div>
                <Disruptions items={ride.disruptions} />
              </li>
            );
          })}
          <li className="commute-legs-total">
            Total {journey.duration}
            {journey.walk ? ` · ${journey.walk}` : ''}
          </li>
        </ol>
      )}
    </li>
  );
}

/** §11 — the two journeys you would catch by leaving the house now. */
function LeaveNow({ dashboard }: { dashboard: CommuteDashboard }) {
  const { next, following } = dashboard.leaveNow;
  if (!next) return null;
  return (
    <section className="commute-leavenow" aria-label="If I leave now">
      <h3>If I leave now</h3>
      <p className="commute-leavenow-main">
        <strong>{next.departure.aimed}</strong>
        <span>→ {next.arrival.aimed}</span>
        <em>{next.duration}</em>
      </p>
      <p className="commute-leavenow-lines">
        {next.rides.map((ride) => `${glyph(ride.mode)} ${ride.line}`).join('  ')}
        {next.dayNote ? ` · ${next.dayNote}` : ''}
      </p>
      {following && (
        <p className="commute-leavenow-next">
          Following {following.departure.aimed} → {following.arrival.aimed} · {following.duration}
        </p>
      )}
    </section>
  );
}

/** One row of a per-leg board: scheduled time first, estimate labelled beneath. */
function BoardRow({ row }: { row: CommuteBoardRow }) {
  return (
    <li className={`commute-board-row ${stateClass(row.state)}`}>
      <span className="commute-board-time">
        <strong>{row.aimed}</strong>
        <em>{row.estimate}</em>
      </span>
      <span className="commute-board-line">
        <strong>
          {glyph(row.mode)} {row.line}
        </strong>
        <span>arrives {row.arrival}</span>
      </span>
      <span className="commute-board-when">
        {row.countdown}
        {row.quay && <em>plat. {row.quay}</em>}
        {row.dayNote && <em>{row.dayNote}</em>}
      </span>
      {/* A board row has nothing to expand into, so it carries the headline —
          enough to know something is up, not enough to bury the next row. */}
      <Disruptions items={row.disruptions} brief />
    </li>
  );
}

function Board({ board }: { board: CommuteDashboardBoard }) {
  return (
    <section className="commute-board" aria-label={board.segment.label}>
      <h3>
        <span>{board.segment.from.name}</span>
        <i aria-hidden="true">↓</i>
        <span>{board.segment.to.name}</span>
      </h3>
      {board.rows.length === 0 ? (
        <p className="commute-state">{board.note}</p>
      ) : (
        <ul className="commute-board-rows">
          {board.rows.map((row) => (
            <BoardRow row={row} key={row.key} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function CommutePanel({
  commute,
  places,
  getBias,
  onClose,
}: {
  commute: CommuteController;
  places: readonly PlaceRecord[];
  /** Map centre, so a stop search resolves near where the user is looking. */
  getBias: () => LatLng | null;
  onClose: () => void;
}) {
  const geocode = useGeocode(getBias);
  const editor = useCommuteEditor({
    commute,
    places,
    geocode,
    fetchStopLines: (stopId, signal) => fetchTransitStopLines(stopId, { signal }),
  });
  const dashboard = useCommuteDashboard(commute);
  const [editing, setEditing] = useState(false);
  // §6.3: the editor opens by itself only when the board *cannot* ask a
  // question. Keyed on `ready` so it fires once the saved commute has loaded
  // rather than during the moment every launch spends looking unconfigured.
  useEffect(() => {
    if (commute.ready && !commute.query) setEditing(true);
  }, [commute.ready, commute.query]);

  return (
    <aside className="commute-panel" aria-label="Commute board">
      <div className="commute-header">
        <div>
          <strong>{dashboard.routeLabel}</strong>
          <span>{dashboard.nowLabel}</span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="commute-body">
        {!commute.ready && <p className="commute-state">Loading saved commute…</p>}
        <div className="commute-toolbar">
          <div className="commute-directions" role="tablist" aria-label="Commute direction">
            <button
              type="button"
              role="tab"
              aria-selected={dashboard.direction === 'outbound'}
              onClick={() => dashboard.setDirection('outbound')}
            >
              Outbound
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={dashboard.direction === 'inbound'}
              onClick={() => dashboard.setDirection('inbound')}
            >
              Return
            </button>
          </div>
          <button
            type="button"
            className={`commute-edit${editing ? ' on' : ''}`}
            aria-expanded={editing}
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? 'Done' : 'Edit commute'}
          </button>
        </div>
        {editing && <CommuteEditorForm editor={editor} places={places} />}
        {dashboard.offDayNote && <p className="commute-state">{dashboard.offDayNote}</p>}
        {/* §9's mode switch. It filters rather than scrolls: five journeys and
            four five-row boards is more than one glance holds, and the whole
            dashboard exists to be glanced at. Journeys stay the default and the
            landing view, which is the part §9 is firm about. */}
        {dashboard.hasBoards && (
          <div className="commute-views" role="tablist" aria-label="Dashboard view">
            <button
              type="button"
              role="tab"
              aria-selected={dashboard.view === 'overview'}
              onClick={() => dashboard.setView('overview')}
            >
              Journeys
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={dashboard.view === 'departures'}
              onClick={() => dashboard.setView('departures')}
            >
              Departures
            </button>
          </div>
        )}
        {commute.loading && <p className="commute-state">Checking upcoming journeys…</p>}
        {commute.error && <p className="commute-state commute-error">{commute.error}</p>}
        {dashboard.view === 'overview' ? (
          <>
            <LeaveNow dashboard={dashboard} />
            {dashboard.emptyNote && (
              <p className="commute-state">
                {dashboard.emptyNote}
                {dashboard.emptyFromFilter && (
                  <>
                    {' '}
                    <button type="button" className="link-button" onClick={editor.clearLines}>
                      Allow any line
                    </button>
                  </>
                )}
              </p>
            )}
            {dashboard.journeys.length > 0 && (
              <section aria-label="Next journeys">
                <h3 className="commute-section-head">Next journeys</h3>
                <ol className="commute-journeys">
                  {dashboard.journeys.map((journey) => (
                    <JourneyRow
                      journey={journey}
                      key={journey.key}
                      open={dashboard.expanded === journey.key}
                      onToggle={() => dashboard.toggle(journey.key)}
                    />
                  ))}
                </ol>
              </section>
            )}
          </>
        ) : (
          dashboard.boards.map((board) => <Board board={board} key={board.segment.id} />)
        )}
        <div className="commute-live">
          <span>Entur · {liveTimetableLabel(commute.updatedMs)}</span>
          <button
            type="button"
            onClick={commute.refresh}
            disabled={commute.loading || !editor.askable}
          >
            Refresh
          </button>
        </div>
      </div>
    </aside>
  );
}
