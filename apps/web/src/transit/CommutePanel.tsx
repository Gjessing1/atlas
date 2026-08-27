import {
  useCommuteDashboard,
  useCommuteEditor,
  type CommuteController,
  type CommuteDashboard,
  type CommuteDashboardBoard,
} from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import {
  commuteEstimateLabel,
  fetchTransitStopLines,
  liveTimetableLabel,
  transitModeGlyph,
  type CommuteBoardRow,
  type CommuteDisruption,
  type CommuteJourney,
  type CommuteServiceState,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { Fragment, useEffect, useState } from 'react';

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

/**
 * One glyph per mode — from `@atlas/transit`, not from a table here.
 *
 * This panel and the Android sheet each kept an identical copy, which read as a
 * styling choice until the home-screen widget wanted one: its rows are rendered
 * on the backend and painted by Kotlin that formats nothing, so a table living
 * in two React files could never reach it. The widget was the board with no
 * icons for exactly as long as the copies existed.
 */
const glyph = transitModeGlyph;

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
 *
 * But a clamped headline is a *cut* sentence, and the cut usually falls exactly
 * where the operator was about to say which stops are affected. So a brief
 * notice opens on its own tap, independently of the journey row it sits in:
 * scannable by default, complete on demand, and never at the price of burying
 * the next departure.
 */
function Disruptions({
  items,
  brief = false,
}: {
  items: readonly CommuteDisruption[];
  brief?: boolean;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <ul className={`commute-disruptions${brief ? ' brief' : ''}`}>
      {items.map((item) => {
        const open = !brief || openKey === item.key;
        const body = (
          <>
            <strong>
              {item.severity === 'info' ? 'ⓘ' : '⚠'} {item.kindLabel}
            </strong>
            <span>{item.summary}</span>
            {open && item.detail && <em>{item.detail}</em>}
          </>
        );
        return (
          <li
            key={item.key}
            className={`commute-disruption sev-${item.severity}${open ? ' open' : ''}`}
          >
            {brief ? (
              <button
                type="button"
                className="commute-disruption-toggle"
                aria-expanded={open}
                onClick={() => setOpenKey((current) => (current === item.key ? null : item.key))}
              >
                {body}
              </button>
            ) : (
              body
            )}
            {open && item.url && (
              <a href={item.url} target="_blank" rel="noreferrer noopener">
                Operator’s notice
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The vehicles of a journey with their own times, and the changes between them.
 *
 * This is the collapsed row's second line, and it exists because the first cut
 * of it printed "🚌 270 🚆 L1" — which tells a reader that a train is involved
 * and nothing about when it leaves Asker or when it reaches town. On a two-leg
 * commute that is the whole question, and answering it meant expanding a row.
 * Every vehicle now carries its own window and every change its own wait, so
 * the journey is legible without opening anything (§1, §2).
 */
function LegStrip({ journey }: { journey: CommuteJourney }) {
  return (
    <span className="commute-journey-legs">
      {journey.rides.map((ride, index) => {
        const change = journey.connections[index - 1];
        return (
          <Fragment key={ride.key}>
            {change && (
              <span className={`commute-change${change.tight ? ' tight' : ''}`}>
                <i aria-hidden="true">⇄</i>
                {change.chip}
              </span>
            )}
            <span className={`commute-leg-chip ${stateClass(ride.state)}`}>
              <i aria-hidden="true">{glyph(ride.mode)}</i>
              <b>{ride.line}</b>
              <em>{ride.window}</em>
            </span>
          </Fragment>
        );
      })}
    </span>
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
          {/* §3's shape, the same one the per-leg boards use: the scheduled time
              is the number, and what the live feed says about it sits *under*
              it rather than at the far end of the card. It used to share a line
              with the leg strip, where a long strip pushed it off the panel and
              a short one left it stranded a card's width from the time it was
              about. */}
          <span className="commute-journey-time">
            <strong>{journey.departure.aimed}</strong>
            <em>{commuteEstimateLabel(journey.departure, false)}</em>
          </span>
          <i aria-hidden="true" />
          <span className="commute-journey-time end">
            <strong>{journey.arrival.aimed}</strong>
            {journey.dayNote && <em>{journey.dayNote}</em>}
          </span>
        </span>
        <span className="commute-journey-duration">
          <strong>{journey.duration}</strong>
          {/* The strip below names every change; "1 change" beside it is the
              same fact, worse said. "direct" is not — nothing else says it. */}
          {journey.connections.length === 0 && <em>{journey.transfers}</em>}
        </span>
        {/* The row *is* expandable, so it has to look it: without a caret the
            legs below were a feature nobody found. */}
        <span className="commute-journey-caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {/* The strip gets the card's full width now that nothing shares its line:
          two vehicles and a change is more than fits beside a status. */}
      <div className="commute-journey-meta">
        <LegStrip journey={journey} />
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
                    {connection.summary}
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

/**
 * §11 — the journey you would catch by leaving the house now.
 *
 * One journey, not two. The "Following 08:48 →" line that used to close this
 * card was the first row of the list directly beneath it, said again in a
 * weaker form; the list starts there now (`laterJourneys`), so the card states
 * one answer completely and the comparison happens where comparisons are
 * scannable.
 */
function LeaveNow({ dashboard }: { dashboard: CommuteDashboard }) {
  const { next } = dashboard.leaveNow;
  if (!next) return null;
  return (
    <section className="commute-leavenow" aria-label="If I leave now">
      <h3>If I leave now</h3>
      <p className="commute-leavenow-main">
        <strong>{next.departure.aimed}</strong>
        <span>→ {next.arrival.aimed}</span>
        <em>{next.duration}</em>
      </p>
      <p className="commute-leavenow-status">
        {[commuteEstimateLabel(next.departure, false), next.dayNote].filter(Boolean).join(' · ')}
      </p>
      {/* The same strip the journey rows carry: the top of the dashboard is the
          one place that must not answer "a bus and a train, at some point". */}
      <LegStrip journey={next} />
      {/* In full, not clamped: this is the journey the reader is being told to
          leave for, and "Buss for tog Asker–…" is the half of the sentence that
          decides whether they should. */}
      <Disruptions items={next.disruptions} />
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
            {dashboard.laterJourneys.length > 0 && (
              <section aria-label="Next journeys">
                {/* Not `journeys`: the one above is already answered in full,
                    and a list that repeats it as its own first row costs the
                    reader the departure they were actually looking for. */}
                <h3 className="commute-section-head">Next journeys</h3>
                <ol className="commute-journeys">
                  {dashboard.laterJourneys.map((journey) => (
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
