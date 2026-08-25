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
 * Three consequences worth stating, because they are the reason this file is not
 * simply `labels.ts`:
 *
 *  - **Times are Norwegian wall-clock times**, from `clock.ts`, not the
 *    formatter's local ones. This runs on the backend, whose container clock is
 *    UTC; `fmtClock` there would put the morning bus an hour early.
 *  - **A row is its parts, not one string.** Each part arrives ready to paint —
 *    `time`, `delayLabel`, `countdown`, `lines`, `platform` — so the widget can
 *    give the clock its own column and the delay its own colour without
 *    re-deriving anything. `text` is still built here, from those same parts, and
 *    is what a screen reader reads out and what a surface with nowhere to lay
 *    them out paints.
 *  - **A row says what it *is*, in `state`.** Cancelled, delayed, early, live or
 *    merely timetabled is the one thing a colour may be chosen from; colouring by
 *    position in the list — which the first layout did, fading rows two and three
 *    — says "less important" about a cancellation.
 *
 * And one rule the rows learned late, from the board they sit beside: **a widget
 * row is a dashboard journey, compressed**. It used to be a *departure* — the
 * time you leave and the vehicles involved — which answers half of what someone
 * glancing at their home screen wants and none of what the panel two taps away
 * would have told them: when they arrive, how long it takes, and how long the
 * change at Asker is. Those come from `commuteJourney` now rather than from a
 * second derivation here, so the two surfaces of one commute cannot quote
 * different numbers for one bus.
 */

import {
  MINUTES_PER_DAY,
  nextCommuteInstant,
  norwayClock,
  norwayTime,
  runsOnWeekday,
} from './clock.js';
import type { CommuteEmptyReason } from './commute.js';
// The `import type` above this one, in dashboard.ts, is the other half of a
// deliberate pair: this module owns the *state* vocabulary and the dashboard
// borrows the type, so the runtime edge only ever runs this way.
import { commuteJourney } from './dashboard.js';
import { DELAY_THRESHOLD_MS, clockDelayMinutes } from './labels.js';
import { isRideMode } from './model.js';
import type {
  TransitCommuteDirection,
  TransitCommuteQuery,
  TransitDeparture,
  TransitResult,
  TransitTrip,
} from './model.js';

/**
 * What a row *is* — the only thing a client may choose a colour from.
 *
 * `live` is a realtime departure running to time; `scheduled` is one the
 * operator has published no live prediction for, which is a weaker promise and
 * should read as one.
 */
export type TransitWidgetRowState = 'cancelled' | 'delayed' | 'early' | 'live' | 'scheduled';

/** One journey (or departure) as the widget shows it, part by part. */
export interface TransitWidgetRow {
  /** Epoch ms of the departure — what a countdown ticks towards and a refresh schedules against. */
  whenMs: number;
  /**
   * **The** departure time, as the timetable prints it: `"07:10"`.
   *
   * The scheduled one, never the live estimate — the board's §3 rule, which the
   * widget used to break. A row that replaces 07:10 with 07:16 disagrees with
   * the sign at the stop, with the app's own commute board, and with the
   * timetable the reader has memorised; the correction belongs beside the time
   * (`delayLabel`), not on top of it.
   */
  time: string;
  /** The live estimate when it differs: `"07:16"`, else null. */
  expected: string | null;
  /** `"+6"` / `"-2"` — the correction against the timetable, or null when there is none. */
  delayLabel: string | null;
  /** Minutes late against the timetable (negative = early), or null when on time. */
  delayMin: number | null;
  /**
   * Scheduled arrival at the far end: `"08:14"`. Null on a stop board, which
   * knows when the 280 leaves and nothing about where the reader is going.
   */
  arrival: string | null;
  /** `"48 min"` door to door, or null for the same reason as {@link arrival}. */
  duration: string | null;
  /** What you board, in ride order: `"280 → RE10"`, or `"walk"` for a journey with no ride. */
  lines: string;
  /**
   * The interchanges, as the board states them: `"9 min at Asker stasjon"`.
   * Null for a direct journey — and for a stop board, which has no journey.
   */
  changes: string | null;
  /** `"plt 2"`, or null — including for a cancelled departure, which has no platform to go to. */
  platform: string | null;
  /** The live phrase in the countdown's place: `"in 6 min"`, `"now"`, or `"cancelled"`. */
  countdown: string;
  /** Minutes until departure, floored at 0 — a bus does not leave "in -1 min". */
  countdownMin: number;
  /** Whether the displayed expected time is backed by a realtime feed. */
  realtime: boolean;
  /** Entur has live data, but warns that this particular prediction is inaccurate. */
  predictionInaccurate: boolean;
  cancelled: boolean;
  /** {@link TransitWidgetRowState} — colour by this, never by position. */
  state: TransitWidgetRowState;
  /** A disruption headline, when the operator published one worth a glance. */
  note: string | null;
  /**
   * The whole row on one line: `"07:10 (+6) → 08:14 · 48 min · in 6 min · 280 →
   * RE10 · 9 min at Asker stasjon · plt 2"`. Built from the parts above, so it
   * cannot drift from them. This is what a screen reader reads out, and what a
   * surface with nowhere to lay the parts out paints.
   */
  text: string;
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
  /**
   * Epoch ms this board was rendered. A widget ages its own answer from this —
   * "checked 07:04" is only true for a few minutes, and the difference between
   * fresh and half an hour old is exactly what makes a widget worth trusting.
   */
  checkedMs: number;
  /** Where the answer came from, with no clock in it: `"Entur live"`, or why there is nothing. */
  source: string;
  /** `"checked 07:04"` — the clock half on its own, for a client composing its own line. */
  checked: string;
  /** `"Entur live · checked 07:04"` — the whole line, for a client that cannot age it itself. */
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

/**
 * `"+6"` / `"-2"`, or null when the difference is timetable noise.
 *
 * The threshold is the real difference; the number is the one the printed times
 * differ by (`clockDelayMinutes`), so "18:59 (+3)" can never sit beside an
 * estimate of 19:01.
 */
function delayMinutes(aimedMs: number, expectedMs: number, realtime: boolean): number | null {
  if (!realtime || Math.abs(expectedMs - aimedMs) < DELAY_THRESHOLD_MS) return null;
  return clockDelayMinutes(aimedMs, expectedMs) || null;
}

function joinRow(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
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

function rowState(cancelled: boolean, delayMin: number | null, realtime: boolean) {
  if (cancelled) return 'cancelled';
  if (delayMin !== null && delayMin > 0) return 'delayed';
  if (delayMin !== null && delayMin < 0) return 'early';
  return realtime ? 'live' : 'scheduled';
}

/**
 * One row, assembled from what a trip and a departure both have.
 *
 * Both kinds go through here so the parts and the one-line `text` are composed
 * once: two composers is how a widget ends up reading `"07:16 (+6)"` in its
 * clock column and `"07:16"` in its spoken description.
 */
function widgetRow({
  whenMs,
  aimedMs,
  arrival,
  duration,
  lines,
  changes,
  quay,
  realtime,
  predictionInaccurate,
  cancelled,
  note,
  nowMs,
}: {
  whenMs: number;
  aimedMs: number;
  arrival: string | null;
  duration: string | null;
  lines: string;
  changes: string | null;
  quay: string | undefined;
  realtime: boolean;
  predictionInaccurate: boolean;
  cancelled: boolean;
  note: string | null;
  nowMs: number;
}): TransitWidgetRow {
  const delayMin = cancelled ? null : delayMinutes(aimedMs, whenMs, realtime);
  const delayLabel = delayMin === null ? null : `${delayMin > 0 ? '+' : ''}${delayMin}`;
  const time = norwayClock(aimedMs);
  const countdownMin = countdown(whenMs, nowMs);
  // A cancelled departure has no platform to walk to.
  const platform = !cancelled && quay ? `plt ${quay}` : null;
  const countdownText = cancelled ? 'cancelled' : countdownLabel(countdownMin);
  // The scan line the board leads with, as far as one widget row can carry it:
  // "07:10 (+6) → 08:14". The correction rides *with* the time rather than
  // replacing it, and the arrival is part of the same clause because
  // "07:10 · → 08:14" reads to a screen reader as two unrelated facts.
  const head =
    (delayLabel === null ? time : `${time} (${delayLabel})`) + (arrival ? ` → ${arrival}` : '');
  return {
    whenMs,
    time,
    expected: delayLabel === null ? null : norwayClock(whenMs),
    delayLabel,
    delayMin,
    arrival,
    duration,
    lines,
    changes,
    platform,
    countdown: countdownText,
    countdownMin,
    realtime,
    predictionInaccurate: realtime && predictionInaccurate,
    cancelled,
    state: rowState(cancelled, delayMin, realtime),
    note,
    text: joinRow([head, duration, countdownText, lines, changes, platform]),
  };
}

/**
 * One journey as a widget row — the dashboard's journey, compressed to a line.
 *
 * Built through `commuteJourney` rather than off the trip directly, which is
 * what stops the home screen and the panel two taps away from disagreeing: the
 * arrival, the total and the change at Asker are the same derivations the board
 * prints, not a second reading of the same legs.
 */
export function tripWidgetRow(trip: TransitTrip, nowMs: number): TransitWidgetRow {
  const journey = commuteJourney(trip, nowMs);
  // The same leg `commuteJourney` made its first ride from, read here for the
  // live facts a *row* needs and a journey has no single value for: which
  // vehicle's delay decides whether you make it, and which platform to stand on.
  const ride = firstRide(trip);
  const realtime = ride?.realtime === true;
  return widgetRow({
    whenMs: ride?.expectedStartMs ?? trip.startMs,
    aimedMs: ride?.aimedStartMs ?? trip.startMs,
    arrival: journey.arrival.aimed,
    duration: journey.duration,
    lines: journey.rides.length > 0 ? journey.rides.map((entry) => entry.line).join(' → ') : 'walk',
    changes:
      journey.connections.length > 0
        ? journey.connections.map((change) => change.chip).join(' · ')
        : null,
    quay: ride?.from.quay?.publicCode,
    realtime,
    predictionInaccurate: ride?.startPredictionInaccurate === true,
    // A planned journey carries no cancellation flag — the planner simply stops
    // offering a cancelled service. Its disruption notice is the honest signal,
    // and it lands in `note`.
    cancelled: false,
    note: tripNote(trip),
    nowMs,
  });
}

/**
 * One departure as a widget row — the cheaper sibling board. The destination is
 * part of the row rather than optional decoration: filtering Engelsrud's board
 * to `RUT:Line:280` returns departures towards Dikemark *and* towards Asker,
 * interleaved, so a row without its direction is half an answer.
 */
export function departureWidgetRow(departure: TransitDeparture, nowMs: number): TransitWidgetRow {
  return widgetRow({
    whenMs: departure.expectedDepartureMs,
    aimedMs: departure.aimedDepartureMs,
    // A stop board knows when the 280 leaves and nothing about where its reader
    // is going; inventing an arrival for it would be the widget's one number
    // nobody could check.
    arrival: null,
    duration: null,
    lines: `${departure.line.publicCode} → ${departure.destination}`,
    changes: null,
    quay: departure.quay.publicCode,
    realtime: departure.realtime,
    predictionInaccurate: departure.predictionInaccurate === true,
    cancelled: departure.cancelled,
    note: departure.situations[0]?.summary ?? null,
    nowMs,
  });
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

/** `"Entur live"`, or the reason there is nothing to show. */
export function widgetSourceLabel(hasRows: boolean, note: string | null): string {
  return hasRows ? 'Entur live' : (note ?? 'Nothing upcoming');
}

/** `"checked 07:04"` — when this answer was true, in the clock the commuter reads. */
export function widgetCheckedLabel(checkedMs: number): string {
  return `checked ${norwayClock(checkedMs)}`;
}

/** `"Entur live · checked 07:04"` — the one-line form, for a client that cannot age it. */
export function widgetStatusLine(source: string, checkedMs: number): string {
  return `${source} · ${widgetCheckedLabel(checkedMs)}`;
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
 * already trimmed to what its layout can hold, which the widget measures from
 * its own bounds and sends as `maxRows`.
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
  const source = widgetSourceLabel(
    allRows.length > 0,
    directions.find((direction) => direction.note)?.note ?? null,
  );
  return {
    route: commuteRouteLabel(query),
    directions,
    checkedMs: nowMs,
    source,
    checked: widgetCheckedLabel(nowMs),
    status: widgetStatusLine(source, nowMs),
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
