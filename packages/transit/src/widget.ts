/**
 * The home-screen widget's rows, rendered here.
 *
 * The widget used to format its own: `CommuteWidgetWorker.tripRows` built
 * `"HH:mm–HH:mm  line → line"` with `SimpleDateFormat`, a second
 * implementation of `tripSummary` in Kotlin — rule 1 — and one that dropped
 * every live fact the trip model already carried: the delay, the cancellation,
 * the platform and the disruption notice. So the rows are built in this package
 * and the widget only paints them. Kotlin formats nothing.
 *
 * Two consequences worth stating, because they are the reason this file is not
 * simply `labels.ts`:
 *
 *  - **Times are Norwegian wall-clock times**, from `clock.ts`, not the
 *    formatter's local ones. This runs on the backend, whose container clock is
 *    UTC; `fmtClock` there would put the morning bus an hour early.
 *  - **A row is one string plus flags.** The widget cannot lay out what it
 *    cannot measure, and a `RemoteViews` row has no room for a second line, so
 *    everything a commuter reads goes into `text` and the flags exist only to
 *    choose a colour — a paint decision, which is the app's, not a format
 *    decision, which is not.
 */

import {
  MINUTES_PER_DAY,
  nextCommuteInstant,
  norwayClock,
  norwayTime,
  runsOnWeekday,
} from './clock.js';
import type { CommuteEmptyReason } from './commute.js';
import { DELAY_THRESHOLD_MS } from './labels.js';
import { isRideMode, legDelayMs } from './model.js';
import type {
  TransitCommuteDirection,
  TransitCommuteQuery,
  TransitDeparture,
  TransitResult,
  TransitTrip,
} from './model.js';

/** One journey (or departure) as the widget shows it. */
export interface TransitWidgetRow {
  /** Epoch ms of the departure — what a refresh schedules against. */
  whenMs: number;
  /** The whole row, ready to display: `"07:16 (+6) · in 6 min · 280 → RE10 · plt 2"`. */
  text: string;
  /** The departure time as the timetable prints it, when it is being corrected. */
  aimed: string | null;
  /** Minutes until departure, floored at 0 — a bus does not leave "in -1 min". */
  countdownMin: number;
  /** Minutes late against the timetable (negative = early), or null when on time. */
  delayMin: number | null;
  /** Whether the displayed expected time is backed by a realtime feed. */
  realtime: boolean;
  /** Entur has live data, but warns that this particular prediction is inaccurate. */
  predictionInaccurate: boolean;
  cancelled: boolean;
  /** A disruption headline, when the operator published one worth a glance. */
  note: string | null;
}

/** One direction of the widget's board. */
export interface TransitWidgetDirection {
  key: TransitCommuteDirection;
  /** `"Engelsrud → Nationaltheatret"`. */
  label: string;
  rows: TransitWidgetRow[];
  /** Why `rows` is empty, in words, or null when it is not. */
  note: string | null;
}

/** Everything one widget instance needs, with nothing left to compute. */
export interface TransitWidgetBoard {
  /** `"Engelsrud ↔ Nationaltheatret · via Asker stasjon"`. */
  route: string;
  directions: TransitWidgetDirection[];
  /** `"Entur live · checked 07:04"` — the answer's age, always visible. */
  status: string;
  /** Epoch ms the widget should ask again at; see {@link commuteRefreshAtMs}. */
  nextRefreshMs: number;
}

/** Ask again this soon at the earliest, so a live delay still has time to land. */
const MIN_REFRESH_MS = 5 * 60_000;
/** And this late at the latest, so a widget can never sit stale for a day. */
const MAX_REFRESH_MS = 6 * 60 * 60_000;
/** Refresh this far before a departure: late enough to be live, early enough to be useful. */
const REFRESH_LEAD_MS = 2 * 60_000;
/** Wake this far before a commute window opens, so 07:12 is already right at 07:00. */
const WINDOW_LEAD_MS = 15 * 60_000;

const countdown = (whenMs: number, nowMs: number): number =>
  Math.max(0, Math.round((whenMs - nowMs) / 60_000));

/** `"in 6 min"` / `"now"` — a countdown is what a commuter actually reads. */
function countdownLabel(minutes: number): string {
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

/** `"+6"` / `"-2"`, or null when the difference is timetable noise. */
function delayMinutes(deltaMs: number, realtime: boolean): number | null {
  if (!realtime || Math.abs(deltaMs) < DELAY_THRESHOLD_MS) return null;
  return Math.round(deltaMs / 60_000);
}

function joinRow(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

/** A journey's ride legs as the traveller describes it: `"280 → RE10"`. */
function tripLines(trip: TransitTrip): string {
  const codes = trip.legs.flatMap((leg) => (leg.line ? [leg.line.publicCode] : []));
  return codes.length > 0 ? codes.join(' → ') : 'walk';
}

/** The first thing boarded — the platform and delay that decide whether you make it. */
function firstRide(trip: TransitTrip) {
  return trip.legs.find((leg) => isRideMode(leg.mode));
}

/** The worst notice on the journey, in one clause. */
function tripNote(trip: TransitTrip): string | null {
  for (const severity of ['severe', 'warning'] as const) {
    for (const leg of trip.legs) {
      const hit = leg.situations.find((situation) => situation.severity === severity);
      if (hit) return hit.summary;
    }
  }
  return null;
}

/** One journey as a widget row. */
export function tripWidgetRow(trip: TransitTrip, nowMs: number): TransitWidgetRow {
  const ride = firstRide(trip);
  const aimedMs = ride?.aimedStartMs ?? trip.startMs;
  const whenMs = ride?.expectedStartMs ?? trip.startMs;
  const delay = delayMinutes(ride ? legDelayMs(ride) : 0, ride?.realtime === true);
  const minutes = countdown(whenMs, nowMs);
  const platform = ride?.from.quay?.publicCode;
  const text = joinRow([
    delay === null
      ? norwayClock(whenMs)
      : `${norwayClock(whenMs)} (${delay > 0 ? '+' : ''}${delay})`,
    countdownLabel(minutes),
    tripLines(trip),
    platform ? `plt ${platform}` : null,
  ]);
  return {
    whenMs,
    text,
    aimed: delay === null ? null : norwayClock(aimedMs),
    countdownMin: minutes,
    delayMin: delay,
    realtime: ride?.realtime === true,
    predictionInaccurate: ride?.realtime === true && ride.startPredictionInaccurate === true,
    // A planned journey carries no cancellation flag — the planner simply stops
    // offering a cancelled service. Its disruption notice is the honest signal,
    // and it lands in `note`.
    cancelled: false,
    note: tripNote(trip),
  };
}

/**
 * One departure as a widget row — the cheaper sibling board. The destination is
 * part of the row rather than optional decoration: filtering Engelsrud's board
 * to `RUT:Line:280` returns departures towards Dikemark *and* towards Asker,
 * interleaved, so a row without its direction is half an answer.
 */
export function departureWidgetRow(departure: TransitDeparture, nowMs: number): TransitWidgetRow {
  const delay = delayMinutes(
    departure.expectedDepartureMs - departure.aimedDepartureMs,
    departure.realtime,
  );
  const whenMs = departure.expectedDepartureMs;
  const minutes = countdown(whenMs, nowMs);
  const clock =
    delay === null
      ? norwayClock(whenMs)
      : `${norwayClock(whenMs)} (${delay > 0 ? '+' : ''}${delay})`;
  const text = departure.cancelled
    ? joinRow([
        norwayClock(departure.aimedDepartureMs),
        'cancelled',
        `${departure.line.publicCode} → ${departure.destination}`,
      ])
    : joinRow([
        clock,
        countdownLabel(minutes),
        `${departure.line.publicCode} → ${departure.destination}`,
        departure.quay.publicCode ? `plt ${departure.quay.publicCode}` : null,
      ]);
  return {
    whenMs,
    text,
    aimed: delay === null ? null : norwayClock(departure.aimedDepartureMs),
    countdownMin: minutes,
    delayMin: delay,
    realtime: departure.realtime,
    predictionInaccurate: departure.realtime && departure.predictionInaccurate === true,
    cancelled: departure.cancelled,
    note: departure.situations[0]?.summary ?? null,
  };
}

/** `"Engelsrud ↔ Nationaltheatret · via Asker stasjon"`. */
export function commuteRouteLabel(query: TransitCommuteQuery): string {
  const via = query.via[0]?.name;
  const ends = `${query.from.name} ↔ ${query.to.name}`;
  return via ? `${ends} · via ${via}` : ends;
}

/** `"Engelsrud → Nationaltheatret"` for the direction actually being shown. */
export function commuteDirectionLabel(
  query: TransitCommuteQuery,
  direction: TransitCommuteDirection,
): string {
  return direction === 'outbound'
    ? `${query.from.name} → ${query.to.name}`
    : `${query.to.name} → ${query.from.name}`;
}

/**
 * The next instant at which asking is worth an upstream call.
 *
 * A fixed fifteen-minute period was wrong in both directions: it asked all night
 * and all weekend, and could still be fifteen minutes stale at 08:05, which is
 * the one moment the widget exists for. So the schedule follows the departures —
 * two minutes before the next one, which is late enough that a live delay has
 * landed — and when there is nothing upcoming it follows the commute's own
 * window instead of the wall clock, waking a quarter of an hour before it opens.
 */
export function commuteRefreshAtMs(
  query: TransitCommuteQuery,
  rows: readonly TransitWidgetRow[],
  nowMs: number,
): number {
  const next = rows.map((row) => row.whenMs).filter((when) => when > nowMs)[0];
  const target =
    next === undefined ? windowOpensAtMs(query, nowMs) - WINDOW_LEAD_MS : next - REFRESH_LEAD_MS;
  const delay = Math.min(Math.max(target - nowMs, MIN_REFRESH_MS), MAX_REFRESH_MS);
  return nowMs + delay;
}

/**
 * When this commute is next travelled. Both directions count — an evening
 * widget should wake for the way home, not for tomorrow's outbound — and a
 * commute with no times saved is treated as always open, which is what "leave
 * now" means.
 */
export function windowOpensAtMs(query: TransitCommuteQuery, nowMs: number): number {
  const candidates = [query.outboundTime, query.inboundTime]
    .map((time) => time.minutesOfDay)
    .filter((minutes): minutes is number => minutes !== null)
    .map((minutes) => nextCommuteInstant(minutes, query.days, nowMs));
  if (candidates.length === 0) {
    // No time of day: only the day list can close the window.
    if (runsOnWeekday(query.days, norwayTime(nowMs).weekday)) return nowMs;
    return nextCommuteInstant(0, query.days, nowMs);
  }
  return Math.min(...candidates);
}

/** `"Entur live · checked 07:04"`, or the reason there is nothing to show. */
function statusLine(checkedMs: number, hasRows: boolean, note: string | null): string {
  const checked = `checked ${norwayClock(checkedMs)}`;
  if (hasRows) return `Entur live · ${checked}`;
  return `${note ?? 'Nothing upcoming'} · ${checked}`;
}

/** How a direction with no rows explains itself. */
export function emptyDirectionNote(reason: 'upstream' | 'filtered'): string {
  return reason === 'filtered'
    ? 'No journey uses only your chosen lines'
    : 'Nothing runs in this window';
}

/**
 * Assemble the board one widget instance renders.
 *
 * `directions` is what the caller asked for — a widget configured for one
 * direction costs one upstream call, not two — and the rows inside each are
 * already trimmed to what its layout can hold.
 */
export function commuteWidgetBoard({
  query,
  results,
  nowMs,
  maxRows = 3,
}: {
  query: TransitCommuteQuery;
  results: readonly {
    key: TransitCommuteDirection;
    result: TransitResult;
    emptyReason: CommuteEmptyReason;
  }[];
  nowMs: number;
  maxRows?: number;
}): TransitWidgetBoard {
  const directions = results.map(({ key, result, emptyReason }) => {
    const rows = result.trips.slice(0, maxRows).map((trip) => tripWidgetRow(trip, nowMs));
    return {
      key,
      label: commuteDirectionLabel(query, key),
      rows,
      note: rows.length === 0 && emptyReason !== 'none' ? emptyDirectionNote(emptyReason) : null,
    };
  });
  const allRows = directions.flatMap((direction) => direction.rows);
  return {
    route: commuteRouteLabel(query),
    directions,
    status: statusLine(
      nowMs,
      allRows.length > 0,
      directions.find((direction) => direction.note)?.note ?? null,
    ),
    nextRefreshMs: commuteRefreshAtMs(
      query,
      [...allRows].sort((a, b) => a.whenMs - b.whenMs),
      nowMs,
    ),
  };
}

/** Minutes past midnight as the clock shows them: `430` → `"07:10"`. */
export function minutesOfDayLabel(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}
