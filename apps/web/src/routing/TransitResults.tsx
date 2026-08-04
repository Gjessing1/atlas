import { useTransitBoard } from '@atlas/app-hooks';
import {
  bookingHowLabel,
  bookingSummaryLabel,
  isRideMode,
  legStopsLabel,
  legTimeParts,
  quayLabel,
  RIDE_MODES,
  severityMark,
  TRANSIT_MODE_LABEL,
  tripSummary,
  walkLegLabel,
  type TransitBooking,
  type TransitLeg,
  type TransitLine,
  type TransitMode,
  type TransitSituation,
  type TransitTrip,
} from '@atlas/transit';
import { useState } from 'react';
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

/**
 * Departure/arrival time, struck through and corrected when a live feed says
 * the vehicle is off schedule. Both numbers are shown because a traveller
 * standing on a platform needs to know which one the departure board will echo.
 */
function LegTime({
  aimedMs,
  expectedMs,
  realtime,
  predictionInaccurate,
}: {
  aimedMs: number;
  expectedMs: number;
  realtime: boolean;
  predictionInaccurate?: boolean;
}) {
  const time = legTimeParts({ aimedMs, expectedMs, realtime, predictionInaccurate });
  if (!time.delay) {
    return (
      <span className="transit-time">
        {time.expected}
        <span className={`transit-confidence ${time.confidence}`}>{time.confidenceLabel}</span>
      </span>
    );
  }
  return (
    <span className={`transit-time ${time.tone}`}>
      <s>{time.aimed}</s> {time.expected}
      <span className="transit-delay">{time.delay}</span>
      <span className={`transit-confidence ${time.confidence}`}>{time.confidenceLabel}</span>
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

/** A quay reference, e.g. "plat. 3" — only rendered when the stop actually has one. */
function QuayNote({ leg, which }: { leg: TransitLeg; which: 'from' | 'to' }) {
  const label = quayLabel(leg[which]);
  // The leading space is real text, not styling: it keeps the stop name and the
  // platform apart for anything that reads the DOM rather than looks at it.
  return label ? <span className="transit-quay"> {label}</span> : null;
}

/**
 * A disruption notice. Collapsed to its headline (an operator's full text runs
 * to paragraphs) but expandable, because the advice is usually the only part
 * that changes what the traveller does. Rendered above the times deliberately:
 * a cancelled service with a confident departure time is the one thing a
 * journey planner must never show calmly.
 */
function SituationNotice({ situation }: { situation: TransitSituation }) {
  const [open, setOpen] = useState(false);
  const detail = situation.advice ?? situation.description;
  return (
    <div className={`transit-notice ${situation.severity}`}>
      <span className="transit-notice-mark" aria-hidden="true">
        {severityMark(situation.severity)}
      </span>
      <div className="transit-notice-body">
        {detail ? (
          <button
            type="button"
            className="transit-notice-summary"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {situation.summary}
          </button>
        ) : (
          <span className="transit-notice-summary">{situation.summary}</span>
        )}
        {open && detail && <p className="transit-notice-detail">{detail}</p>}
        {open && situation.url && (
          <a href={situation.url} target="_blank" rel="noreferrer noopener">
            Operator&rsquo;s notice ↗
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Booking requirements for flexible transport. Not a nicety: an unbooked
 * `bestillingstransport` bus does not turn up at all, so a leg shown as an
 * ordinary departure would strand someone at a rural stop.
 */
function BookingNotice({ booking }: { booking: TransitBooking }) {
  return (
    <div className="transit-notice warning">
      <span className="transit-notice-mark" aria-hidden="true">
        ☎
      </span>
      <div className="transit-notice-body">
        <span className="transit-notice-summary">{bookingSummaryLabel(booking)}</span>
        <p className="transit-notice-detail">{bookingHowLabel(booking)}</p>
        {booking.note && <p className="transit-notice-detail">{booking.note}</p>}
        {booking.url && (
          <a href={booking.url} target="_blank" rel="noreferrer noopener">
            Booking page ↗
          </a>
        )}
      </div>
    </div>
  );
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
        {leg.situations.map((situation, i) => (
          <SituationNotice key={situation.id ?? i} situation={situation} />
        ))}
        {leg.booking && <BookingNotice booking={leg.booking} />}
        {ride && leg.line ? (
          <>
            <div className="transit-leg-head">
              <LegTime
                aimedMs={leg.aimedStartMs}
                expectedMs={leg.expectedStartMs}
                realtime={leg.realtime}
                predictionInaccurate={leg.startPredictionInaccurate}
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
                {showStops ? '▾' : '▸'} {legStopsLabel(leg)}
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
                predictionInaccurate={leg.endPredictionInaccurate}
              />
              <span className="transit-leg-detail">
                {leg.to.name}
                <QuayNote leg={leg} which="to" />
              </span>
            </div>
          </>
        ) : (
          <div className="transit-leg-detail">
            {walkLegLabel(leg)}
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
  onStartGuidance,
}: {
  trip: TransitTrip;
  expanded: boolean;
  onToggle: () => void;
  onStartGuidance: () => void;
}) {
  // A collapsed card must not look clean when a leg inside it is cancelled —
  // the whole point of the summary row is deciding without expanding.
  const summary = tripSummary(trip);

  return (
    <li className="transit-trip">
      <button
        type="button"
        className="transit-trip-head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="transit-trip-times">
          {summary.times}
          {summary.departure && (
            <span className={`transit-summary-departure ${summary.departure.confidence}`}>
              {summary.departure.delay
                ? `Departs ${summary.departure.expected}, planned ${summary.departure.aimed} · ${summary.departure.confidenceLabel}`
                : `${summary.departure.confidenceLabel} departure`}
            </span>
          )}
          {summary.severity && (
            <span className={`transit-trip-flag ${summary.severity}`}>
              ! {summary.severityLabel}
            </span>
          )}
          {summary.needsBooking && <span className="transit-trip-flag warning">☎ Book ahead</span>}
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
          {summary.meta} · 🚶 {summary.walk}
          {summary.co2 ? ` · ${summary.co2}` : ''}
        </span>
      </button>
      {/* The screen-reader summary of a collapsed card is the line list, which
          reads as digits without this. */}
      <span className="sr-only">
        {summary.lineCodes.length > 0 ? `Lines ${summary.lineCodes.join(', ')}` : 'Walking only'}
      </span>
      {expanded && (
        <button type="button" className="transit-start" onClick={onStartGuidance}>
          Start journey
        </button>
      )}
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
 *
 * The decisions behind the controls (which timing is selected, how paging
 * falls back, how an empty answer is worded) live in `useTransitBoard`, shared
 * with Android; what is left here is markup.
 */
export function TransitResults({
  transit,
  onStartGuidance,
}: {
  transit: TransitPlan;
  onStartGuidance: (trip: TransitTrip) => void;
}) {
  const [showFilters, setShowFilters] = useState(false);
  const board = useTransitBoard(transit);
  const trips = transit.trips;

  return (
    <div className="transit-results">
      <div className="transit-when">
        {/* "Leave now" is its own choice rather than a blank time field: it is
            what almost every lookup wants, and it means "whatever now is when
            the answer arrives" — not a timestamp frozen at render. */}
        <select
          value={board.timing}
          onChange={(e) => board.chooseTiming(e.target.value as typeof board.timing)}
          aria-label="When to travel"
        >
          <option value="now">Leave now</option>
          <option value="depart">Depart at</option>
          <option value="arrive">Arrive by</option>
        </select>
        {board.timing === 'now' ? (
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
            aria-label={board.timing === 'arrive' ? 'Arrival time' : 'Departure time'}
          />
        )}
        <button
          type="button"
          aria-pressed={showFilters}
          onClick={() => setShowFilters((v) => !v)}
          title="Choose which modes of transport to use"
        >
          Modes{board.filtered ? ` (${transit.modes.length})` : ''}
        </button>
      </div>

      {showFilters && (
        <div className="transit-modes" role="group" aria-label="Modes of transport">
          {RIDE_MODES.map((mode) => (
            <label key={mode}>
              <input
                type="checkbox"
                checked={board.accepts(mode)}
                onChange={() => transit.toggleMode(mode)}
              />
              <span aria-hidden="true">{MODE_ICON[mode]}</span> {TRANSIT_MODE_LABEL[mode]}
            </label>
          ))}
          <p className="route-hint">
            Walking to and between stops is always included.
            {board.filtered && (
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

      {/* The chip is offered before both ends are known (that is what makes the
          mode discoverable), so the board has to say what it is still missing
          rather than sitting blank. */}
      {!transit.covered && (
        <p className="route-hint">Add a start and a destination to see journeys.</p>
      )}
      {transit.loading && <p className="route-hint">Looking up departures…</p>}
      {transit.error && <div className="route-error">{transit.error}</div>}
      {board.emptyMessage && (
        <p className="route-hint">
          {board.emptyMessage}
          {board.emptyFromFilter && (
            <>
              {' '}
              <button type="button" className="transit-link" onClick={transit.clearModes}>
                Use all modes
              </button>
            </>
          )}
        </p>
      )}
      {trips && trips.length > 0 && (
        <>
          {/* Absent, not disabled, when the planner has no earlier page: at the
              first departure of the service day there genuinely is no earlier. */}
          {board.showEarlier && (
            <button type="button" className="transit-page" onClick={board.showEarlier}>
              ↑ Earlier
            </button>
          )}
          <ol className="transit-trips">
            {trips.map((trip, i) => (
              <TripCard
                key={`${trip.startMs}-${i}`}
                trip={trip}
                expanded={transit.selected === i}
                onToggle={() => transit.select(transit.selected === i ? null : i)}
                onStartGuidance={() => onStartGuidance(trip)}
              />
            ))}
          </ol>
          {board.showLater && (
            <button type="button" className="transit-page" onClick={board.showLater}>
              ↓ Later
            </button>
          )}
        </>
      )}
      {/* Last line of the board, always: the one part of Atlas that stops
          working off-grid should say so before it is relied on. */}
      <p className="route-hint transit-live-notice">{board.liveNotice}</p>
    </div>
  );
}
