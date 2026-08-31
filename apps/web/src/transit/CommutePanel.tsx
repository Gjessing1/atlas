import {
  useCommuteDashboard,
  useCommuteEditor,
  type CommuteController,
  type CommuteDashboard,
  type CommuteDashboardBoard,
  type CommuteDashboardRow,
} from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import {
  commuteCountdown,
  fetchTransitStopLines,
  liveTimetableLabel,
  transitModeGlyph,
  type CommuteBoardRow,
  type CommuteDisruption,
  type CommuteHere,
  type CommuteJourney,
  type CommuteLineBadge,
  type CommuteRibbonPart,
  type CommuteServiceState,
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
 * So the order is inverted and the emphasis with it. Reading down: where you
 * are in the journey you are tracking, if you are tracking one; what leaving
 * *now* actually gets you; the complete journey options as one scannable line
 * and one ribbon each, expandable to their legs; then the per-leg boards for
 * someone already mid-journey. Configuration is one button, opened on demand —
 * or by itself when there is not yet enough saved to ask a question at all.
 *
 * **The ribbon is the change worth knowing about.** Every journey used to state
 * its vehicles as a wrapping strip of bordered chips, which in a 360 px panel
 * became two or three lines of near-identical text per row: five journeys, ten
 * boxes, thirty clock times, and no way to see that the first leg is a long bus
 * and the second a short train without reading all of it. `commuteRibbon` draws
 * the journey as one proportional bar in the operators' own colours, so the
 * shape of a commute is legible before a digit is.
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

/** The operator's own colours, as inline style — the one place they may appear. */
const badgeStyle = (badge: CommuteLineBadge) => ({
  background: badge.fill,
  color: badge.text,
});

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
 * The journey as one proportional bar — every vehicle as wide as it is long,
 * in the operator's own colours, with the changes as literal gaps between them.
 *
 * Two colour channels run through this and they never trade places: the *fill*
 * is the line's identity (the 280 is Ruter red whether or not it is late) and
 * the *edge* is its state. A reader who learned "red means trouble" here would
 * misread every bus in Oslo.
 */
function Ribbon({
  parts,
  progress = null,
  tall = false,
}: {
  parts: readonly CommuteRibbonPart[];
  /** Where "now" sits along it, 0–100, when this is the journey being tracked. */
  progress?: number | null;
  tall?: boolean;
}) {
  if (parts.length === 0) return null;
  return (
    <div className={`commute-ribbon${tall ? ' tall' : ''}`}>
      {parts.map((part) =>
        part.kind === 'ride' ? (
          <span
            key={part.key}
            className={`commute-seg ${stateClass(part.state)}`}
            style={{ flexGrow: part.weight, ...badgeStyle(part.badge) }}
            title={`${part.line} · ${part.weight} min`}
          >
            <i aria-hidden="true">{glyph(part.mode)}</i>
            <b>{part.line}</b>
            {/* The correction on the leg carrying it: on a bus→train commute,
                "the bus is nine late" and "the train is nine late" are different
                mornings, and one number on the row cannot tell them apart. */}
            {part.delay && <u>{part.delay}</u>}
          </span>
        ) : (
          <span
            key={part.key}
            className={`commute-gap${part.broken ? ' broken' : part.tight ? ' tight' : ''}`}
            style={{ flexGrow: part.weight }}
          >
            <i>{part.broken ? '×' : part.label}</i>
          </span>
        ),
      )}
      {progress !== null && (
        <span className="commute-ribbon-now" style={{ left: `${progress}%` }} aria-hidden="true" />
      )}
    </div>
  );
}

/**
 * The scan line: departure, arrival and total, all on the timetable's own
 * numbers, in one line comparable against the row above it without reading
 * either (§12).
 *
 * The live correction that used to sit under the departure has moved onto the
 * ribbon segment it is about. It was saying the same thing in a weaker place —
 * a journey-level `+3 min` cannot name which of two vehicles is late.
 */
function ScanLine({
  journey,
  big = false,
  countdown = null,
}: {
  journey: CommuteJourney;
  big?: boolean;
  countdown?: string | null;
}) {
  return (
    <span className={`commute-scan${big ? ' big' : ''}`}>
      <strong>{journey.departure.aimed}</strong>
      {countdown && <span className="commute-in">{countdown}</span>}
      <i aria-hidden="true" />
      <strong className="end">{journey.arrival.aimed}</strong>
      <em>{journey.duration}</em>
      {journey.dayNote && <em className="day">{journey.dayNote}</em>}
    </span>
  );
}

/**
 * The same journey on live times, under the scheduled one it corrects.
 *
 * Absent whenever nothing has moved, which is most rows: this line exists to
 * answer "is the 48 minutes with the delay in it or not", and printing it on a
 * journey running to time would answer a question nobody asked while pushing
 * the next departure down the panel.
 */
function Live({ journey }: { journey: CommuteJourney }) {
  if (!journey.live) return null;
  return (
    // A span, not a paragraph: the collapsed row's whole head is a button, and
    // a button may only contain phrasing content.
    <span className="commute-live">
      <b>Live</b>
      <span>{journey.live.scan}</span>
    </span>
  );
}

/** The change, in the two numbers the traveller would otherwise subtract (§2). */
function Changes({ row }: { row: CommuteDashboardRow }) {
  return (
    <>
      {row.journey.connections.map((change, index) => {
        const broken = row.broken?.index === index + 1;
        return (
          <p
            key={change.key}
            className={`commute-change${broken ? ' broken' : change.tight ? ' tight' : ''}`}
          >
            <i aria-hidden="true">⇄</i>
            <span>{change.at}</span>
            {broken ? (
              <b className="detail">{row.broken?.detail}</b>
            ) : (
              <b>
                {change.arrive} → {change.depart}
              </b>
            )}
          </p>
        );
      })}
    </>
  );
}

/**
 * The vehicles of a journey, stop by stop: each leg's platform, its departure
 * and its arrival, with the live estimate under whichever of the two moved.
 *
 * Shared by the expanded journey row and the tracked card, which is the point.
 * The tracked card used to be the one place on the board that could *not* tell
 * you which platform to stand on — the journey it is about has left the list
 * the legs would otherwise have been read from.
 */
function Legs({
  journey,
  /**
   * The ride the traveller is on or about to board, from the phase ladder.
   * Legs before it are dimmed rather than dropped: a journey is read as a
   * shape, and removing its first half moves everything that is left.
   */
  activeIndex = null,
}: {
  journey: CommuteJourney;
  activeIndex?: number | null;
}) {
  return (
    <ol className="commute-legs">
      {journey.rides.map((ride, index) => {
        const connection = journey.connections[index - 1];
        const mark =
          activeIndex === null
            ? ''
            : index === activeIndex
              ? ' now'
              : index < activeIndex
                ? ' past'
                : '';
        return (
          <li key={ride.key} className={mark.trim() || undefined}>
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
                  <span className="commute-badge" style={badgeStyle(ride.badge)}>
                    {glyph(ride.mode)} {ride.line}
                  </span>
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
  );
}

/**
 * One journey, collapsed to its scan line and ribbon, expandable to its legs.
 *
 * Tracking lives inside the expansion rather than on the collapsed row. A
 * button per row was four more bordered boxes on a list whose whole job is to
 * be scanned, and the journey people track is almost always the one stated in
 * full above the list, which has its own.
 */
function JourneyRow({
  row,
  open,
  onToggle,
  onTrack,
}: {
  row: CommuteDashboardRow;
  open: boolean;
  onToggle: () => void;
  onTrack: () => void;
}) {
  const { journey } = row;
  // No state edge on the card: the ribbon paints state per vehicle, which is
  // strictly more than a row-level tint could say, and a 1 px green sliver
  // beside every healthy journey reads as an accident rather than a signal.
  // `cancelled` keeps one, because it is the state that invalidates the row.
  return (
    <li
      className={`commute-journey${journey.state === 'cancelled' ? ' cancelled' : ''}${
        row.tracked ? ' tracked' : ''
      }`}
    >
      <button
        type="button"
        className="commute-journey-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ScanLine journey={journey} />
        <Live journey={journey} />
        <Ribbon parts={row.parts} />
      </button>
      <Changes row={row} />
      {!open && <Disruptions items={row.disruptions} brief />}
      {open && (
        <>
          <Legs journey={journey} />
          <button type="button" className="commute-track" onClick={onTrack}>
            {row.tracked ? 'Stop tracking' : 'Track this journey'}
          </button>
        </>
      )}
    </li>
  );
}

/**
 * §6.4 §7 — where you are in the journey you are tracking.
 *
 * The block every part of which already existed and none of which reached this
 * screen: the phase ladder, the connection break and the commitment all shipped
 * for the home-screen widget, so the widget knew which leg you were on and the
 * board did not.
 */
function HereCard({
  here,
  journey,
  onStop,
}: {
  here: CommuteHere;
  /** The tracked journey whole, for the leg detail below the ribbon. */
  journey: CommuteJourney | null;
  onStop: () => void;
}) {
  return (
    <section className="commute-card here" aria-label="You are here">
      <p className="commute-eyebrow">
        {here.heading} <b>{here.phaseLabel}</b>
      </p>
      <Ribbon parts={here.parts} progress={here.progress} tall />
      {/* Under the ribbon and directly above the connection block, because the
          two are one instruction: which vehicle to be on, and what it puts you
          on next. Above the ribbon it was separated from the change it leads to
          by the whole width of the journey. */}
      <p className="commute-here-lead">
        <span className="commute-badge" style={badgeStyle(here.ride.badge)}>
          {glyph(here.ride.mode)} {here.ride.line}
        </span>
        <span>{here.lead}</span>
        <em>{here.leadEstimate}</em>
      </p>
      {here.connections.length > 0 && (
        <>
          <p className="commute-eyebrow next">Next connection</p>
          <ul className="commute-conns">
            {here.connections.map((connection) => (
              <li key={connection.key} className={connection.missed ? 'missed' : ''}>
                <b>{connection.aimed}</b>
                <span className="commute-badge" style={badgeStyle(connection.badge)}>
                  {glyph(connection.mode)} {connection.line}
                </span>
                <span>{connection.towards}</span>
                <em>{connection.note}</em>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* The detail the ribbon compresses: which platform, and the two clock
          times per leg. Below the connection block on purpose — that block is
          the decision, this is the reference you check once you have made it. */}
      {journey && <Legs journey={journey} activeIndex={here.rideIndex} />}
      <button type="button" className="commute-track" onClick={onStop}>
        Stop tracking
      </button>
    </section>
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
function LeaveNow({
  row,
  nowMs,
  primary,
  showTrack,
  onTrack,
}: {
  row: CommuteDashboardRow;
  nowMs: number;
  /** Nothing is being tracked, so this card is the board's answer. */
  primary: boolean;
  /**
   * False once the card above is already tracking this same journey — two
   * "Stop tracking" buttons for one commitment is two controls for one state.
   */
  showTrack: boolean;
  onTrack: () => void;
}) {
  return (
    <section className={`commute-card${primary ? ' primary' : ''}`} aria-label="If I leave now">
      <p className="commute-eyebrow">If I leave now</p>
      {/* Counted to the *expected* departure, not the timetabled one: a bus
          four minutes late is four minutes more to walk to the stop, and that
          is the number a person deciding whether to run is actually asking
          for. */}
      <ScanLine
        journey={row.journey}
        big
        countdown={commuteCountdown(row.journey.trip.startMs, nowMs)}
      />
      <Live journey={row.journey} />
      <Ribbon parts={row.parts} tall />
      <Changes row={row} />
      <Disruptions items={row.disruptions} />
      {showTrack && (
        <button type="button" className="commute-track wide" onClick={onTrack}>
          {row.tracked ? 'Stop tracking' : 'Track this journey'}
        </button>
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
          <span className="commute-badge" style={badgeStyle(row.badge)}>
            {glyph(row.mode)} {row.line}
          </span>
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

/** The journey list, or the reason there is none. */
function Journeys({
  dashboard,
  editor,
}: {
  dashboard: CommuteDashboard;
  editor: { clearLines: () => void };
}) {
  return (
    <>
      {dashboard.here && (
        <HereCard
          here={dashboard.here}
          journey={dashboard.hereJourney}
          onStop={() => dashboard.track(null)}
        />
      )}
      {/* One notice on every journey in the list is the corridor's, not any
          journey's — said once, above them, rather than five times inside
          them. */}
      <Disruptions items={dashboard.sharedDisruptions} />
      {dashboard.leadRow && (
        <LeaveNow
          row={dashboard.leadRow}
          nowMs={dashboard.nowMs}
          primary={!dashboard.here}
          showTrack={!dashboard.leadRow.tracked || !dashboard.here}
          onTrack={() =>
            dashboard.track(
              dashboard.leadRow?.tracked ? null : (dashboard.leadRow?.journey ?? null),
            )
          }
        />
      )}
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
      {dashboard.rows.length > 0 && (
        <section aria-label="Next journeys">
          {/* Not `journeys`: the one above is already answered in full, and a
              list that repeats it as its own first row costs the reader the
              departure they were actually looking for. */}
          <h3 className="commute-section-head">Next journeys</h3>
          <ol className="commute-journeys">
            {dashboard.rows.map((row) => (
              <JourneyRow
                row={row}
                key={row.journey.key}
                open={dashboard.expanded === row.journey.key}
                onToggle={() => dashboard.toggle(row.journey.key)}
                onTrack={() => dashboard.track(row.tracked ? null : row.journey)}
              />
            ))}
          </ol>
        </section>
      )}
    </>
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
        {/* §13's middle ground. A commute is saved door to door, but half a
            commuting day starts at the change — the train in from Asker, the
            bus home from it — and before this the board could only answer that
            as a stop board under the Departures tab. The journeys come from the
            hop the dashboard already asks for, so the choice costs no call. */}
        {dashboard.origins.length > 1 && (
          <div className="commute-origins" role="tablist" aria-label="Start the journey from">
            <span>Start from</span>
            {dashboard.origins.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={dashboard.origin === option.id}
                onClick={() => dashboard.setOrigin(option.id)}
              >
                {option.chip}
              </button>
            ))}
          </div>
        )}
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
          <Journeys dashboard={dashboard} editor={editor} />
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
