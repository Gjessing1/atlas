import {
  useCommuteDashboard,
  useCommuteEditor,
  type CommuteController,
  type CommuteDashboard,
  type CommuteDashboardBoard,
  type CommuteDashboardRow,
  type CommuteDashboardSection,
} from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import {
  commuteCountdown,
  commuteModeChip,
  fetchTransitStopLines,
  transitModeGlyph,
  type CommuteBoardRow,
  type CommuteConnection,
  type CommuteDisruption,
  type CommuteHere,
  type CommuteJourney,
  type CommuteLineBadge,
  type CommuteRibbonPart,
  type CommuteServiceState,
  type CommuteWalk,
  type TransitTrip,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { Fragment, useEffect, useRef, useState } from 'react';

import { CheckIcon, MoreIcon } from '../icons.js';
import { useGeocode } from '../routing/useGeocode.js';
import { CommuteEditorForm } from './CommuteEditor.js';

/**
 * The commute dashboard — docs/TRANSIT.md.
 *
 * What this replaced was a configuration form with a result list underneath it:
 * three stop pickers, two time fields, seven day chips and a wall of line chips
 * before the first departure time. It answered "is my commute set up correctly"
 * on a screen opened to answer "when do I leave".
 *
 * So the order is inverted and the emphasis with it. Reading down: where you
 * are in the journey you are tracking, if you are tracking one; what leaving
 * *now* actually gets you; then the complete journey options as one scannable
 * card each, expandable to a chronological itinerary. Configuration — editing,
 * renaming, adding, deleting, the widget — lives behind the header's ⋮, and the
 * editor opens by itself only when there is not yet enough saved to ask a
 * question at all.
 *
 * The middle mode reads differently on purpose (§13): standing at the change
 * you are not planning a journey, so it draws the two departure boards leaving
 * that stop and no journey list at all.
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
 * Disruptions under the service they affect (§4) — one line each until clicked.
 *
 * Every notice starts as its operator headline on a single line, wherever it
 * appears: on a collapsed card, above the list, on a leg of the itinerary. The
 * full form put two amber boxes and five lines of Norwegian operator prose
 * between the first journey's scan line and the second's, on the one screen
 * §12 says must show three journeys at a glance; the headline says enough to
 * know something is up, and a click opens the whole notice in place.
 *
 * Two weights, from `prominence`: what is happening to *this* departure (it is
 * cancelled, a bus replaces it, an incident on it) is drawn in the state
 * colours; engineering work announced last month and information notices are
 * drawn muted, so they are there to be read without competing with the time.
 */
function Disruptions({ items }: { items: readonly CommuteDisruption[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <ul className="commute-disruptions">
      {items.map((item) => {
        const open = openKey === item.key;
        const active = item.prominence === 'active';
        return (
          <li
            key={item.key}
            className={`commute-disruption sev-${item.severity} prom-${item.prominence}${
              open ? ' open' : ''
            }`}
          >
            <button
              type="button"
              className="commute-disruption-toggle"
              aria-expanded={open}
              aria-label={open ? undefined : `${item.kindLabel}: ${item.summary}`}
              onClick={() => setOpenKey((current) => (current === item.key ? null : item.key))}
            >
              {open && <strong>{item.kindLabel}</strong>}
              <span>
                <i aria-hidden="true">{active ? '⚠' : 'ⓘ'}</i> {item.summary}
              </span>
              {open && item.detail && <em>{item.detail}</em>}
            </button>
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

/**
 * The change on a collapsed card: where, and how long — the two things the
 * ribbon's gap cannot spell out — plus the warning when there is one (§2).
 *
 * Not the arrival and departure times: those belong to the legs, and the
 * itinerary states them against their platforms. A collapsed card that also
 * printed them was the near-copy of the itinerary a reader scrolled past twice.
 * The live wait sits after the planned one it corrects (§3), so a nine-minute
 * change a late bus has cut to two reads `9 min · ⚠ 2 min est.`.
 */
function Overview({ row }: { row: CommuteDashboardRow }) {
  return (
    <>
      {row.journey.connections.map((change, index) => {
        const broken = row.broken?.index === index + 1;
        return (
          <p
            key={change.key}
            className={`commute-change${broken ? ' broken' : change.warn ? ' tight' : ''}`}
          >
            <i aria-hidden="true">⇄</i>
            <span>{change.at}</span>
            {broken ? (
              <b className="detail">⚠ {row.broken?.detail}</b>
            ) : (
              <b>
                {change.warn && !change.liveLabel && '⚠ '}
                {change.label}
                {change.liveLabel && ` · ${change.warn ? '⚠ ' : ''}${change.liveLabel}`}
              </b>
            )}
          </p>
        );
      })}
    </>
  );
}

/**
 * The interchange as one element between the leg that arrives and the leg that
 * leaves: `Asker stasjon · 9 min connection · 150 m walk`. Clicking it opens the
 * transfer itself — both times with their platforms, the walk, the live wait and
 * why it is flagged — for the traveller about to make it.
 */
function Interchange({ change, broken }: { change: CommuteConnection; broken: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className={`commute-interchange${broken ? ' broken' : change.warn ? ' tight' : ''}${
        open ? ' open' : ''
      }`}
    >
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>
          {change.warn || broken ? '⚠ ' : '⇄ '}
          {change.summary}
        </span>
        {change.liveLabel && !broken && <b>{change.liveLabel}</b>}
      </button>
      {broken && <p>{broken}</p>}
      {open && change.details.map((line) => <p key={line}>{line}</p>)}
    </li>
  );
}

/** A walk at either end of the itinerary, timed like a leg. */
function WalkLine({ walk }: { walk: CommuteWalk }) {
  return (
    <li className="commute-walk">
      <div className="commute-leg">
        <span className="commute-leg-time">
          <em>{walk.aimed}</em>
        </span>
        <span className="commute-leg-body">
          <span>🚶 {walk.label}</span>
        </span>
      </div>
    </li>
  );
}

/**
 * The journey as a chronological itinerary: the walk to the stop, each leg's
 * departure and arrival with its platform and live estimate, the interchange
 * between legs, the notices on the leg they concern, the walk at the end.
 *
 * Only what the collapsed card cannot say. There is no closing "Total 48 min"
 * line — the card's head states the whole journey, and the itinerary is read
 * from it — and nothing about a disruption is repeated from the card: the card
 * says *that* the journey is affected, the itinerary says *which leg*.
 *
 * Shared by the expanded journey and the tracked card, which is the point: the
 * tracked card used to be the one place on the board that could *not* tell you
 * which platform to stand on.
 */
function Itinerary({
  journey,
  notices,
  broken = null,
  /**
   * The ride the traveller is on or about to board, from the phase ladder.
   * Legs before it are dimmed rather than dropped: a journey is read as a
   * shape, and removing its first half moves everything that is left.
   */
  activeIndex = null,
}: {
  journey: CommuteJourney;
  /** Per-ride notices; the rides' own by default. */
  notices?: readonly (readonly CommuteDisruption[])[];
  broken?: CommuteDashboardRow['broken'];
  activeIndex?: number | null;
}) {
  return (
    <ol className="commute-legs">
      {journey.walkIn && <WalkLine walk={journey.walkIn} />}
      {journey.rides.map((ride, index) => {
        const connection = journey.connections[index - 1];
        const mark =
          activeIndex === null
            ? undefined
            : index === activeIndex
              ? 'now'
              : index < activeIndex
                ? 'past'
                : undefined;
        return (
          <Fragment key={ride.key}>
            {connection && (
              <Interchange
                change={connection}
                broken={broken?.index === index ? broken.detail : null}
              />
            )}
            <li className={mark}>
              <div className="commute-leg">
                <span className="commute-leg-time">
                  <strong>{ride.departure.aimed}</strong>
                  {ride.departure.delay && <em>{ride.departure.expected} est.</em>}
                </span>
                <span className="commute-leg-body">
                  <strong>{[ride.from, ride.fromQuay].filter(Boolean).join(' · ')}</strong>
                  <span className="commute-leg-line">
                    <span className="commute-badge" style={badgeStyle(ride.badge)}>
                      {glyph(ride.mode)} {ride.line}
                    </span>
                    {ride.towards ? ` → ${ride.towards}` : ''}
                  </span>
                  <span className="commute-leg-ride">{ride.ride}</span>
                  <Disruptions items={notices?.[index] ?? ride.disruptions} />
                </span>
              </div>
              <div className="commute-leg">
                <span className="commute-leg-time">
                  <strong>{ride.arrival.aimed}</strong>
                  {ride.arrival.delay && <em>{ride.arrival.expected} est.</em>}
                </span>
                <span className="commute-leg-body">
                  <strong>{[ride.to, ride.toQuay].filter(Boolean).join(' · ')}</strong>
                </span>
              </div>
            </li>
          </Fragment>
        );
      })}
      {journey.walkOut && <WalkLine walk={journey.walkOut} />}
    </ol>
  );
}

/**
 * One journey, collapsed to what a quick check needs, expandable to its
 * itinerary.
 *
 * Collapsed, it answers the commute at a glance: when it leaves and arrives on
 * the timetable, the live times beside them when they moved, the vehicles in
 * proportion, where the change is and how long it is (flagged when short or put
 * in doubt), and one line per disruption. Expanded, the overview's interchange
 * line and notices give way to the itinerary that says the same things in their
 * place — never both at once.
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
  onOpenJourney,
}: {
  row: CommuteDashboardRow;
  open: boolean;
  onToggle: () => void;
  onTrack: () => void;
  onOpenJourney: (trip: TransitTrip) => void;
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
      {open ? (
        <>
          <Itinerary journey={journey} notices={row.rideDisruptions} broken={row.broken} />
          <div className="commute-actions">
            <button type="button" className="commute-track" onClick={onTrack}>
              {row.tracked ? 'Stop tracking' : 'Track this journey'}
            </button>
            <button
              type="button"
              className="commute-track quiet"
              onClick={() => onOpenJourney(journey.trip)}
            >
              Open in planner
            </button>
          </div>
        </>
      ) : (
        <>
          <Overview row={row} />
          <Disruptions items={row.disruptions} />
        </>
      )}
    </li>
  );
}

/**
 * TRANSIT.md §7 — where you are in the journey you are tracking.
 *
 * The block every part of which already existed and none of which reached this
 * screen: the phase ladder, the connection break and the commitment all shipped
 * for the home-screen widget, so the widget knew which leg you were on and the
 * board did not.
 *
 * Drawn from the journey kept on the device the moment the panel opens, and
 * refreshed behind it: `freshness` says how old its live times are, so a card
 * that could not be updated never passes for one that was.
 */
function HereCard({
  here,
  journey,
  freshness,
  onStop,
  onOpenJourney,
}: {
  here: CommuteHere;
  /** The tracked journey whole, for the itinerary below the ribbon. */
  journey: CommuteJourney | null;
  freshness: string | null;
  onStop: () => void;
  onOpenJourney: (trip: TransitTrip) => void;
}) {
  return (
    <section className="commute-card here" aria-label="You are here">
      <p className="commute-eyebrow">
        {here.heading} <b>{here.phaseLabel}</b>
      </p>
      {freshness && <p className="commute-freshness">{freshness}</p>}
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
      {journey && <Itinerary journey={journey} activeIndex={here.rideIndex} />}
      <div className="commute-actions">
        <button type="button" className="commute-track" onClick={onStop}>
          Stop tracking
        </button>
        {journey && (
          <button
            type="button"
            className="commute-track quiet"
            onClick={() => onOpenJourney(journey.trip)}
          >
            Open in planner
          </button>
        )}
      </div>
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
 *
 * The same two states as a journey row — the overview, or the itinerary in its
 * place — behind a Details control, because this card is the one most often
 * read whole and its itinerary is what used to be missing from it.
 */
function LeaveNow({
  row,
  label,
  nowMs,
  primary,
  showTrack,
  open,
  onToggle,
  onTrack,
  onOpenJourney,
}: {
  row: CommuteDashboardRow;
  /**
   * `"If I leave now"` — or `"Next from here"` at the interchange, where you
   * are not leaving the house but already standing on the platform.
   */
  label: string;
  nowMs: number;
  /** Nothing is being tracked, so this card is the board's answer. */
  primary: boolean;
  /**
   * False once the card above is already tracking this same journey — two
   * "Stop tracking" buttons for one commitment is two controls for one state.
   */
  showTrack: boolean;
  open: boolean;
  onToggle: () => void;
  onTrack: () => void;
  onOpenJourney: (trip: TransitTrip) => void;
}) {
  return (
    <section className={`commute-card${primary ? ' primary' : ''}`} aria-label={label}>
      <p className="commute-eyebrow">{label}</p>
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
      {open ? (
        <Itinerary journey={row.journey} notices={row.rideDisruptions} broken={row.broken} />
      ) : (
        <>
          <Overview row={row} />
          <Disruptions items={row.disruptions} />
        </>
      )}
      <div className="commute-actions">
        {showTrack && (
          <button type="button" className="commute-track" onClick={onTrack}>
            {row.tracked ? 'Stop tracking' : 'Track this journey'}
          </button>
        )}
        <button
          type="button"
          className="commute-track quiet"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? 'Hide details' : 'Details'}
        </button>
        {open && (
          <button
            type="button"
            className="commute-track quiet"
            onClick={() => onOpenJourney(row.journey.trip)}
          >
            Open in planner
          </button>
        )}
      </div>
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
        <span className="commute-board-arrival">
          arrives {row.arrival} · <strong>{row.duration}</strong>
        </span>
      </span>
      <span className="commute-board-when">
        {row.countdown}
        {row.quay && <em>plat. {row.quay}</em>}
        {row.dayNote && <em>{row.dayNote}</em>}
      </span>
      {/* A board row has nothing to expand into, so it carries the headline —
          enough to know something is up, not enough to bury the next row. */}
      <Disruptions items={row.disruptions} />
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

/**
 * The journey list, whole: its shared notices, its headline, its rows and the
 * reason there is none — TRANSIT.md §13.
 *
 * A component rather than a run of fields on the panel because it is one
 * question's answer: everything in it describes the same direction, door to
 * door, and the mode that asks about a *stop* draws boards instead of a
 * hollowed-out one of these.
 */
function Journeys({
  section,
  dashboard,
  editor,
  onOpenJourney,
}: {
  section: CommuteDashboardSection;
  dashboard: CommuteDashboard;
  editor: { clearLines: () => void };
  onOpenJourney: (trip: TransitTrip) => void;
}) {
  const lead = section.leadRow;
  return (
    <section className="commute-list" aria-label={section.label}>
      {/* One notice on every journey in the list is the corridor's, not any
          journey's — said once, above them, rather than five times inside
          them. */}
      <Disruptions items={section.sharedDisruptions} />
      {lead && (
        <LeaveNow
          row={lead}
          label={section.leadLabel}
          nowMs={dashboard.nowMs}
          primary={!dashboard.here}
          showTrack={!lead.tracked || !dashboard.here}
          open={dashboard.expanded === lead.key}
          onToggle={() => dashboard.toggle(lead.key)}
          onTrack={() => section.track(lead.tracked ? null : lead.journey)}
          onOpenJourney={onOpenJourney}
        />
      )}
      {section.emptyNote && (
        <p className="commute-state">
          {section.emptyNote}
          {section.emptyFromFilter && (
            <>
              {' '}
              <button type="button" className="link-button" onClick={editor.clearLines}>
                Allow any line
              </button>
            </>
          )}
        </p>
      )}
      {section.rows.length > 0 && (
        <>
          {/* Not `journeys`: the one above is already answered in full, and a
              list that repeats it as its own first row costs the reader the
              departure they were actually looking for. */}
          <h3 className="commute-section-head">Next journeys</h3>
          <ol className="commute-journeys">
            {section.rows.map((row) => (
              <JourneyRow
                row={row}
                key={row.key}
                open={dashboard.expanded === row.key}
                onToggle={() => dashboard.toggle(row.key)}
                onTrack={() => section.track(row.tracked ? null : row.journey)}
                onOpenJourney={onOpenJourney}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/**
 * Everything that configures the board rather than reads it: edit, rename,
 * which commute the Android widget shows, add and delete.
 *
 * These were a row of buttons above the mode tabs, so every glance at the board
 * began by reading past "☆ Widget · Rename · ＋ · Delete" to reach a departure
 * time. Each is used once in a while and the board is read every weekday, so
 * they fold under the header's ⋮ — rows in the panel rather than a floating
 * popover, like the route panel's own overflow, so nothing covers the board.
 */
function CommuteMenu({
  commute,
  editing,
  onEdit,
  onRename,
  onClose,
}: {
  commute: CommuteController;
  editing: boolean;
  onEdit: () => void;
  onRename: () => void;
  onClose: () => void;
}) {
  const active = commute.commutes.find((item) => item.id === commute.activeId)!;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const onWidget = active.id === commute.widgetCommuteId;
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <div className="commute-menu" role="group" aria-label="Commute settings">
      {!editing && (
        <button type="button" onClick={run(onEdit)}>
          Edit commute
        </button>
      )}
      <button type="button" onClick={run(onRename)}>
        Rename commute
      </button>
      <button
        type="button"
        aria-pressed={onWidget}
        aria-label="Use this commute on the Android home screen"
        disabled={onWidget}
        onClick={run(() => commute.setWidgetCommute(active.id))}
      >
        {onWidget ? '★ Shown on the Android widget' : '☆ Show on the Android widget'}
      </button>
      <button type="button" disabled={!commute.canAddCommute} onClick={run(commute.addCommute)}>
        Add commute
      </button>
      {confirmingDelete ? (
        <div className="commute-menu-confirm">
          <button
            type="button"
            className="danger"
            onClick={run(() => commute.deleteCommute(active.id))}
          >
            Delete “{active.name}”
          </button>
          <button type="button" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="danger"
          disabled={commute.commutes.length <= 1}
          onClick={() => setConfirmingDelete(true)}
        >
          Delete commute
        </button>
      )}
    </div>
  );
}

/**
 * Which saved commute the board reads — shown only when there is a choice to
 * make. One commute has nothing to pick between, and a select naming it above
 * the board is a row spent on the header's own title.
 */
function CommuteChoices({ commute }: { commute: CommuteController }) {
  if (commute.commutes.length <= 1) return null;
  return (
    <div className="commute-picker">
      <select
        value={commute.activeId}
        aria-label="Saved commute"
        onChange={(event) => commute.selectCommute(event.target.value)}
      >
        {commute.commutes.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
            {item.id === commute.widgetCommuteId ? ' · home screen' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The name field the menu's Rename opens, at the top of the board. */
function RenameCommute({ commute, onDone }: { commute: CommuteController; onDone: () => void }) {
  const active = commute.commutes.find((item) => item.id === commute.activeId)!;
  const [name, setName] = useState(active.name);
  const save = () => {
    commute.renameCommute(active.id, name);
    onDone();
  };
  return (
    <div className="commute-picker">
      <input
        autoFocus
        value={name}
        maxLength={80}
        aria-label="Commute name"
        onChange={(event) => setName(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save();
          if (event.key === 'Escape') onDone();
        }}
      />
    </div>
  );
}

export function CommutePanel({
  commute,
  places,
  getBias,
  onClose,
  onOpenJourney,
}: {
  commute: CommuteController;
  places: readonly PlaceRecord[];
  /** Map centre, so a stop search resolves near where the user is looking. */
  getBias: () => LatLng | null;
  onClose: () => void;
  onOpenJourney: (trip: TransitTrip) => void;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The name field and the editor both open at the top of the board, which the
  // reader may have scrolled well past to reach the menu.
  const toTop = () => bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  // The editor opens by itself only when the board *cannot* ask a
  // question. Keyed on `ready` so it fires once the saved commute has loaded
  // rather than during the moment every launch spends looking unconfigured.
  useEffect(() => {
    if (commute.ready && !commute.query) setEditing(true);
  }, [commute.ready, commute.query]);
  useEffect(() => {
    setEditing(!commute.query);
    setRenaming(false);
  }, [commute.activeId]);
  const stale = commute.staleEnds.filter((item) => item.commuteId === commute.activeId);

  return (
    <aside className="commute-panel" aria-label="Commute board">
      <div className="commute-header">
        <div>
          <strong>{dashboard.routeLabel}</strong>
          <span>{dashboard.nowLabel}</span>
        </div>
        {/* Editing has one way out, and it is where the eye already is. */}
        {editing && (
          <button
            type="button"
            className="commute-done"
            aria-label="Done editing commute"
            onClick={() => setEditing(false)}
          >
            <CheckIcon size={16} /> Done
          </button>
        )}
        {commute.ready && (
          <button
            type="button"
            className={`icon-button commute-more${menuOpen ? ' on' : ''}`}
            aria-expanded={menuOpen}
            aria-label="Commute settings"
            title="Commute settings"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreIcon size={18} />
          </button>
        )}
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      {menuOpen && commute.ready && (
        <CommuteMenu
          commute={commute}
          editing={editing}
          onEdit={() => {
            setEditing(true);
            toTop();
          }}
          onRename={() => {
            setRenaming(true);
            toTop();
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
      <div className="commute-body" ref={bodyRef}>
        {!commute.ready && <p className="commute-state">Loading saved commute…</p>}
        {commute.ready && renaming && (
          <RenameCommute commute={commute} onDone={() => setRenaming(false)} />
        )}
        {commute.ready && <CommuteChoices commute={commute} />}
        {stale.map((item) => (
          <p className="commute-state commute-warning" key={`${item.commuteId}:${item.end}`}>
            {item.end === 'from' ? 'From' : item.end === 'to' ? 'To' : 'Via'} uses the last copy of
            a deleted saved place. Choose it again to reconnect it.
          </p>
        ))}
        {/* TRANSIT.md §13's three modes, and the only control over what is shown.
            Out, back, and the middle ground — the third is not a direction at
            all but the change, drawn as the departures leaving it in both
            directions. Nothing configures the board from this row any more:
            it is the everyday control, and configuration is behind ⋮. */}
        <div className="commute-modes" role="tablist" aria-label="Commute mode">
          {dashboard.modes.map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={dashboard.mode === mode}
              onClick={() => dashboard.setMode(mode)}
            >
              {commuteModeChip(mode)}
            </button>
          ))}
        </div>
        {/* …and the offer to have one at all. A commute is saved door to door,
            so the corridor that changes at Asker on every single journey had no
            interchange saved and no middle ground — and no way to find out that
            a Via stop was what both were waiting on. The journeys know the
            stop; this is the one tap that saves it. */}
        {editor.suggestedVia && (
          <p className="commute-suggest">
            <span>
              Every journey changes at <strong>{editor.suggestedVia.name}</strong>.
            </span>
            <button type="button" onClick={editor.addSuggestedVia} disabled={editor.addingVia}>
              {editor.addingVia ? 'Adding…' : 'Add as interchange'}
            </button>
          </p>
        )}
        {editor.suggestedViaError && (
          <p className="commute-state commute-error">{editor.suggestedViaError}</p>
        )}
        {editing && <CommuteEditorForm editor={editor} places={places} />}
        {dashboard.offDayNote && <p className="commute-state">{dashboard.offDayNote}</p>}
        {/* Only while there is nothing to show: a refresh behind a board that
            already has an answer is said on the footer, not by pushing the
            answer down the panel. */}
        {commute.loading && !commute.result && (
          <p className="commute-state">Checking upcoming journeys…</p>
        )}
        {commute.error && !commute.result && (
          <p className="commute-state commute-error">{commute.error}</p>
        )}
        {/* Above the list rather than inside it: a commitment outlives the
            list its journey came from — a mode switch included — and the card
            is what the traveller stops it on. */}
        {dashboard.here && (
          <HereCard
            here={dashboard.here}
            journey={dashboard.hereJourney}
            freshness={dashboard.hereFreshness}
            onStop={dashboard.stopTracking}
            onOpenJourney={onOpenJourney}
          />
        )}
        {/* One mode, one kind of content: a door mode has the journey list and
            no boards, the interchange has the two boards leaving it and no
            list. Both are drawn rather than switched on here, because which
            mode answers with what is the model's fact, not the panel's. */}
        {dashboard.section && (
          <Journeys
            section={dashboard.section}
            dashboard={dashboard}
            editor={editor}
            onOpenJourney={onOpenJourney}
          />
        )}
        {dashboard.boards.map((board) => (
          <Board board={board} key={board.segment.id} />
        ))}
        <div className="commute-live">
          <span className={commute.error && commute.result ? 'commute-stale' : undefined}>
            Entur · {dashboard.freshness}
          </span>
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
