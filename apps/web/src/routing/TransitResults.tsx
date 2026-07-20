import { fmtClock } from '@atlas/core';
import {
  isRideMode,
  legDelayMs,
  RIDE_MODES,
  transferCount,
  tripLineCodes,
  type TransitLeg,
  type TransitLine,
  type TransitMode,
  type TransitTrip,
} from '@atlas/transit';
import { useState } from 'react';
import { fmtDuration, fmtKm } from '../format.js';
import type { TransitPlan } from './useTransit.js';

/** One glyph per mode — the fastest way to read a board is by shape, not words. */
const MODE_ICON: Record<TransitMode, string> = {
  foot: '🚶',
  bus: '🚌',
  coach: '🚌',
  tram: '🚊',
  metro: '🚇',
  rail: '🚆',
  water: '⛴️',
  air: '✈️',
  funicular: '🚟',
  cableway: '🚡',
  unknown: '•',
};

/** Mode names as a traveller would tick them in a filter. */
const MODE_LABEL: Record<TransitMode, string> = {
  foot: 'Walk',
  bus: 'Bus',
  coach: 'Coach',
  tram: 'Tram',
  metro: 'Metro',
  rail: 'Train',
  water: 'Ferry',
  air: 'Flight',
  funicular: 'Funicular',
  cableway: 'Cable car',
  unknown: 'Other',
};

/** A delay worth painting: under a minute is timetable noise, not news. */
const DELAY_THRESHOLD_MS = 60_000;

/**
 * Departure/arrival time, struck through and corrected when a live feed says
 * the vehicle is off schedule. Both numbers are shown because a traveller
 * standing on a platform needs to know which one the departure board will echo.
 */
function LegTime({
  aimedMs,
  expectedMs,
  realtime,
}: {
  aimedMs: number;
  expectedMs: number;
  realtime: boolean;
}) {
  const delta = expectedMs - aimedMs;
  if (!realtime || Math.abs(delta) < DELAY_THRESHOLD_MS) {
    return <span className="transit-time">{fmtClock(expectedMs)}</span>;
  }
  const minutes = Math.round(delta / 60_000);
  return (
    <span className={delta > 0 ? 'transit-time late' : 'transit-time early'}>
      <s>{fmtClock(aimedMs)}</s> {fmtClock(expectedMs)}
      <span className="transit-delay">{minutes > 0 ? `+${minutes}` : minutes} min</span>
    </span>
  );
}

/** The line badge as it looks on the vehicle: operator colours when Entur sends them. */
function LineChip({ line }: { line: TransitLine }) {
  // Bare `colour` means "no official colour" — fall back to the panel's own
  // styling rather than inventing one, so a real brand colour still stands out.
  const style = line.colour
    ? { background: line.colour, color: line.textColour ?? '#fff', borderColor: line.colour }
    : undefined;
  return (
    <span className="transit-line-chip" style={style} title={line.name ?? line.publicCode}>
      {line.publicCode}
    </span>
  );
}

/** A quay reference, e.g. "track 3" — only rendered when the stop actually has one. */
function QuayNote({ leg, which }: { leg: TransitLeg; which: 'from' | 'to' }) {
  const code = leg[which].quay?.publicCode;
  // The leading space is real text, not styling: it keeps the stop name and the
  // platform apart for anything that reads the DOM rather than looks at it.
  return code ? <span className="transit-quay"> plat. {code}</span> : null;
}

/** One row of the expanded journey: a walk, or a ride on one vehicle. */
function LegRow({ leg }: { leg: TransitLeg }) {
  const [showStops, setShowStops] = useState(false);
  const ride = isRideMode(leg.mode);
  const stops = leg.intermediateStops.length;

  return (
    <li className={ride ? 'transit-leg ride' : 'transit-leg walk'}>
      <span className="transit-leg-icon" aria-hidden="true">
        {MODE_ICON[leg.mode]}
      </span>
      <div className="transit-leg-body">
        {ride && leg.line ? (
          <>
            <div className="transit-leg-head">
              <LegTime
                aimedMs={leg.aimedStartMs}
                expectedMs={leg.expectedStartMs}
                realtime={leg.realtime}
              />
              <LineChip line={leg.line} />
              {leg.line.headsign && <span className="transit-headsign">→ {leg.line.headsign}</span>}
            </div>
            <div className="transit-leg-detail">
              {leg.from.name}
              <QuayNote leg={leg} which="from" />
            </div>
            {stops > 0 && (
              <button
                type="button"
                className="transit-stops-toggle"
                aria-expanded={showStops}
                onClick={() => setShowStops((v) => !v)}
              >
                {showStops ? '▾' : '▸'} {stops} {stops === 1 ? 'stop' : 'stops'} ·{' '}
                {fmtDuration(leg.durationMs)}
              </button>
            )}
            {showStops && (
              <ol className="transit-stops">
                {leg.intermediateStops.map((stop, i) => (
                  <li key={`${stop.name}-${i}`}>{stop.name}</li>
                ))}
              </ol>
            )}
            <div className="transit-leg-head">
              <LegTime
                aimedMs={leg.aimedEndMs}
                expectedMs={leg.expectedEndMs}
                realtime={leg.realtime}
              />
              <span className="transit-leg-detail">
                {leg.to.name}
                <QuayNote leg={leg} which="to" />
              </span>
            </div>
          </>
        ) : (
          // Walk legs carry no line and no live feed: distance and duration are
          // the whole story, and the destination names what you are walking to.
          <div className="transit-leg-detail">
            Walk {fmtDuration(leg.durationMs)} · {fmtKm(leg.distanceM)}
            {leg.to.name ? ` to ${leg.to.name}` : ''}
            <QuayNote leg={leg} which="to" />
          </div>
        )}
      </div>
    </li>
  );
}

/** A journey option: summary row always, full legs when expanded. */
function TripCard({
  trip,
  expanded,
  onToggle,
}: {
  trip: TransitTrip;
  expanded: boolean;
  onToggle: () => void;
}) {
  const codes = tripLineCodes(trip);
  const transfers = transferCount(trip);
  // The delay that decides whether you make it: the first vehicle you board.
  const firstRide = trip.legs.find((leg) => isRideMode(leg.mode));
  const delay = firstRide ? legDelayMs(firstRide) : 0;
  const late = firstRide?.realtime === true && delay >= DELAY_THRESHOLD_MS;

  return (
    <li className="transit-trip">
      <button
        type="button"
        className="transit-trip-head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="transit-trip-times">
          {fmtClock(trip.startMs)} – {fmtClock(trip.endMs)}
          {late && <span className="transit-delay">+{Math.round(delay / 60_000)} min</span>}
        </span>
        <span className="transit-trip-lines">
          {trip.legs.map((leg, i) =>
            leg.line ? (
              <LineChip key={i} line={leg.line} />
            ) : (
              <span key={i} className="transit-leg-icon" aria-hidden="true">
                {MODE_ICON[leg.mode]}
              </span>
            ),
          )}
        </span>
        <span className="transit-trip-meta">
          {fmtDuration(trip.durationMs)} ·{' '}
          {transfers === 0 ? 'direct' : `${transfers} ${transfers === 1 ? 'change' : 'changes'}`} ·{' '}
          🚶 {fmtKm(trip.walkDistanceM)}
        </span>
      </button>
      {/* The screen-reader summary of a collapsed card is the line list, which
          reads as digits without this. */}
      <span className="sr-only">
        {codes.length > 0 ? `Lines ${codes.join(', ')}` : 'Walking only'}
      </span>
      {expanded && (
        <ol className="transit-legs">
          {trip.legs.map((leg, i) => (
            <LegRow key={i} leg={leg} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** `<input type="datetime-local">` wants local wall-clock, not an ISO instant. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The public transport result board: when to leave, which options exist, and
 * what each journey is made of. Everything here is timetable-bound and
 * online-only — an empty answer means "nothing runs then", which is worded
 * differently from the planner being unreachable.
 */
export function TransitResults({ transit }: { transit: TransitPlan }) {
  const [showFilters, setShowFilters] = useState(false);
  const trips = transit.trips;
  const first = trips?.[0];
  const last = trips && trips.length > 0 ? trips[trips.length - 1] : undefined;
  const timing = transit.timeMs === null ? 'now' : transit.arriveBy ? 'arrive' : 'depart';
  // An empty mode list means "all of them", so it is not a filter.
  const filtered = transit.modes.length > 0;
  const accepts = (mode: TransitMode) => !filtered || transit.modes.includes(mode);

  // Paging a timetable is done in *departures*, not in fixed time steps: the
  // next page starts just after the earliest option already shown, so nothing
  // is skipped however sparse or dense the service is.
  const showEarlier = () => {
    if (!first) return;
    transit.setArriveBy(true);
    transit.setTimeMs(first.startMs - 60_000);
  };
  const showLater = () => {
    if (!last) return;
    transit.setArriveBy(false);
    transit.setTimeMs((trips!.length > 1 ? first!.startMs : last.startMs) + 60_000);
  };

  return (
    <div className="transit-results">
      <div className="transit-when">
        {/* "Leave now" is its own choice rather than a blank time field: it is
            what almost every lookup wants, and it means "whatever now is when
            the answer arrives" — not a timestamp frozen at render. */}
        <select
          value={timing}
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'now') {
              transit.setTimeMs(null);
              transit.setArriveBy(false);
              return;
            }
            transit.setArriveBy(value === 'arrive');
            if (transit.timeMs === null) transit.setTimeMs(Date.now());
          }}
          aria-label="When to travel"
        >
          <option value="now">Leave now</option>
          <option value="depart">Depart at</option>
          <option value="arrive">Arrive by</option>
        </select>
        {timing === 'now' ? (
          <button type="button" onClick={transit.refresh} title="Look up the next departures again">
            ↻ Refresh
          </button>
        ) : (
          <input
            type="datetime-local"
            value={toLocalInput(transit.timeMs ?? Date.now())}
            onChange={(e) => {
              const ms = new Date(e.target.value).getTime();
              transit.setTimeMs(Number.isFinite(ms) ? ms : null);
            }}
            aria-label={timing === 'arrive' ? 'Arrival time' : 'Departure time'}
          />
        )}
        <button
          type="button"
          aria-pressed={showFilters}
          onClick={() => setShowFilters((v) => !v)}
          title="Choose which modes of transport to use"
        >
          Modes{filtered ? ` (${transit.modes.length})` : ''}
        </button>
      </div>

      {showFilters && (
        <div className="transit-modes" role="group" aria-label="Modes of transport">
          {RIDE_MODES.map((mode) => (
            <label key={mode}>
              <input
                type="checkbox"
                checked={accepts(mode)}
                onChange={() => transit.toggleMode(mode)}
              />
              <span aria-hidden="true">{MODE_ICON[mode]}</span> {MODE_LABEL[mode]}
            </label>
          ))}
          <p className="route-hint">
            Walking to and between stops is always included.
            {filtered && (
              <>
                {' '}
                <button type="button" className="transit-link" onClick={transit.clearModes}>
                  Use all modes
                </button>
              </>
            )}
          </p>
        </div>
      )}

      {transit.loading && <p className="route-hint">Looking up departures…</p>}
      {transit.error && <div className="route-error">{transit.error}</div>}
      {!transit.loading && !transit.error && trips?.length === 0 && (
        // Two very different empty answers: nothing runs, versus nothing runs
        // *that you allowed*. Blaming the timetable for the traveller's own
        // filter would send them hunting for a departure that exists.
        <p className="route-hint">
          {filtered ? (
            <>
              No journeys with the modes you picked.{' '}
              <button type="button" className="transit-link" onClick={transit.clearModes}>
                Use all modes
              </button>
            </>
          ) : (
            'No departures found for this time. Try a different time or a nearer stop.'
          )}
        </p>
      )}
      {trips && trips.length > 0 && (
        <>
          <button type="button" className="transit-page" onClick={showEarlier}>
            ↑ Earlier
          </button>
          <ol className="transit-trips">
            {trips.map((trip, i) => (
              <TripCard
                key={`${trip.startMs}-${i}`}
                trip={trip}
                expanded={transit.selected === i}
                onToggle={() => transit.select(transit.selected === i ? null : i)}
              />
            ))}
          </ol>
          <button type="button" className="transit-page" onClick={showLater}>
            ↓ Later
          </button>
        </>
      )}
    </div>
  );
}
