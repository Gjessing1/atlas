/**
 * The **v1** home-screen widget's rows, rendered here.
 *
 * ---
 * **Which widget is this?** Atlas ships two home-screen commute widgets side by
 * side, and they are different products, not two versions of one file:
 *
 *  - **v1 — "Atlas commute" (this file).** One instance answers *one board*: a
 *    direction, both directions, or one hop of the corridor, chosen in its ⚙ and
 *    fixed until someone changes it. A timetable on the home screen. Painted by
 *    `CommuteWidgetProvider`.
 *  - **v2 — "Atlas commute (live)"** — {@link file://./widget-v2.ts}, board built
 *    by `commuteWidgetV2Board`, painted by `CommuteWidgetV2Provider`. One
 *    instance holds the *whole commute*: both directions behind a compact
 *    selector, and content that follows where you are in the journey rather than
 *    where you configured it (docs/TRANSIT.md §W1–§W7).
 *
 * v1 is the fallback and the reference until v2 has survived real commuting
 * (TRANSIT.md §W7), so **nothing here may be changed to suit v2**. v2 reuses what helps
 * — `TransitWidgetRow`, `tripWidgetRow`, `commuteRefreshAtMs`, the row layouts —
 * by importing it, never by bending it.
 * ---
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
 *    `time`, `delayLabel`, `legs`, `platform` — so the widget can give the clock
 *    its own column and the delay its own colour without re-deriving anything.
 *    `text` is still built here, from those same parts, and is what a screen
 *    reader reads out and what a surface with nowhere to lay them out paints.
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
 *
 * That rule is why a row carries `legs` and no longer carries a countdown:
 *
 *  - **The legs are the panel's own leg strip.** `"280 → R14"` names the
 *    vehicles and says nothing about when the train leaves Asker or when it
 *    reaches town, which on a two-leg commute is the whole question. Each leg
 *    now states its own scheduled window and the change before it, from
 *    `CommuteRide.window` and `CommuteConnection`, so the home screen answers
 *    what the board answers without being opened.
 *  - **The countdown is gone.** "in 6 min" is the one number on the row that
 *    the departure time already implies, it was the widest column on the line,
 *    and it was the only part that had to be re-rendered to stay true. The row
 *    is a timetable — scheduled time, correction, arrival, total — and a
 *    timetable does not tick.
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
import {
  COMMUTE_STATE_LABEL,
  commuteJourney,
  commuteJourneyList,
  type CommuteSegment,
  type CommuteServiceState,
} from './dashboard.js';
import {
  DELAY_THRESHOLD_MS,
  clockDelayLabel,
  clockDelayMinutes,
  expectedTimeLabel,
  platformLabel,
  transitModeGlyph,
} from './labels.js';
import { isRideMode } from './model.js';
import type {
  TransitCommuteDirection,
  TransitCommuteQuery,
  TransitDeparture,
  TransitMode,
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

/**
 * One vehicle inside a row's journey — the board's leg strip, as far as a home
 * screen carries it.
 *
 * Every part is ready to paint and none of it is re-derived: `window` is
 * `CommuteRide.window`, `change` is `CommuteConnection.chip`, so a leg on the
 * home screen and the same leg in the panel are the same two derivations. The
 * change belongs to the leg it precedes — the strip reads "wait here, then
 * board this" in the order a traveller does it.
 */
export interface TransitWidgetLeg {
  /** `"280"`, `"R14"` — what is on the front of the vehicle. */
  line: string;
  mode: TransitMode;
  /**
   * The mode's glyph, rendered here rather than by the client.
   *
   * Both panels drew one from a table of their own and the widget drew none,
   * which is not a styling difference but a missing board: Kotlin formats
   * nothing, so a glyph the backend does not send is a glyph the home screen
   * cannot have. {@link transitModeGlyph} is now the one table all three read.
   */
  icon: string;
  /** `"07:12 → 07:30"` — this vehicle's own scheduled window. */
  window: string;
  /** `"280 07:12 → 07:30"` — the leg on one line, for a surface with one to give it. */
  text: string;
  /** The change before boarding: `"9 min at Asker stasjon"`, null on the first leg. */
  change: string | null;
  /**
   * The same change with the stop left implicit: `"9 min"`. A narrow instance
   * has room for one of the two, and dropping the change entirely would hide
   * the number that decides whether the journey holds together.
   */
  wait: string | null;
  /**
   * Where this vehicle leaves from: `"plat. 3"`, or null at a stop with no
   * platform to name.
   *
   * Per leg, because a row-level platform is the *first* ride's and only the
   * first ride's — which on a bus-then-train commute is a bus stop, while the
   * number the traveller actually needs is the train's platform at the change.
   * The same journey read the other way round starts on the train and did show
   * it, so the widget named a platform on the way home and not on the way out.
   */
  quay: string | null;
  /** What this vehicle is — the delayed half of a journey is the half that looks it. */
  state: CommuteServiceState;
}

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
  /**
   * The live estimate as a board states it — `"07:16 est."` — or null when
   * there is nothing to correct.
   *
   * {@link expected} on its own is a bare time in a row that already holds two,
   * and a widget cannot afford a column the reader has to work out. This is the
   * panel's own phrasing (`commuteEstimateLabel`), so the correction reads the
   * same on the home screen as it does two taps away.
   */
  expectedLabel: string | null;
  /**
   * `"+6 min"` / `"-2 min"` — the correction against the timetable, or null when
   * there is none.
   *
   * The unit is not padding. This column used to print a bare `"+6"` beside a
   * panel printing `"+6 min"`, in a row that also carries a duration in minutes
   * and two clock times — so the one number with no unit was the one number
   * whose meaning had to be guessed at.
   */
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
   *
   * Superseded on screen by {@link legs}, which says the same thing per vehicle,
   * and kept because a *widget* is not upgraded by the server that renders it: a
   * home screen still running the build before the leg strip reads this field,
   * and dropping it would blank the second line of every row until the APK
   * catches up.
   */
  changes: string | null;
  /**
   * Every vehicle with its own window and the change before it — the panel's
   * leg strip. Empty on a stop board, which knows a departure and not a journey.
   */
  legs: TransitWidgetLeg[];
  /**
   * The whole strip on one line: `"280 07:12 → 07:30 · 9 min at Asker stasjon ·
   * R14 07:39 → 07:41"`. What an instance too short for a line per leg paints,
   * and what a screen reader hears. Falls back to {@link lines} for a journey
   * with one vehicle, whose window is the scan line already.
   */
  legsText: string;
  /**
   * `"plat. 2"`, or null — including for a cancelled departure, which has no
   * platform to go to.
   *
   * The *first* ride's platform, which is all a scan line can hold; the rest of
   * the journey states its own on {@link TransitWidgetLeg.quay}. Spelled as the
   * panels spell it (`quayLabel`) rather than as the abbreviation this row
   * invented — one commute should not have two words for one platform.
   */
  platform: string | null;
  /**
   * The word for a row whose state needs one — `"Cancelled"` — and null for
   * every row whose time and correction already say everything there is.
   *
   * The countdown used to live in this column. It was removed: it restated the
   * departure time, it was the widest thing on the line, and it was the only
   * part of a row that went wrong simply by being looked at a minute later.
   */
  statusLabel: string | null;
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
   * The whole row on one line: `"07:10 (+6) → 08:14 · 48 min · 280 07:10 →
   * 07:30 · 9 min at Asker stasjon · R14 07:39 → 08:14 · plt 2"`. Built from the
   * parts above, so it cannot drift from them. This is what a screen reader
   * reads out, and what a surface with nowhere to lay the parts out paints.
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
  legs,
  quay,
  realtime,
  predictionInaccurate,
  cancelled,
  note,
}: {
  whenMs: number;
  aimedMs: number;
  arrival: string | null;
  duration: string | null;
  lines: string;
  changes: string | null;
  legs: TransitWidgetLeg[];
  quay: string | null;
  realtime: boolean;
  predictionInaccurate: boolean;
  cancelled: boolean;
  note: string | null;
}): TransitWidgetRow {
  const delayMin = cancelled ? null : delayMinutes(aimedMs, whenMs, realtime);
  const delayLabel = delayMin === null ? null : clockDelayLabel(delayMin);
  const time = norwayClock(aimedMs);
  const expected = delayLabel === null ? null : norwayClock(whenMs);
  // A cancelled departure has no platform to walk to.
  const platform = cancelled ? null : platformLabel(quay);
  const statusLabel = cancelled ? COMMUTE_STATE_LABEL.cancelled : null;
  // The scan line the board leads with, as far as one widget row can carry it:
  // "07:10 (+6 min) → 08:14". The correction rides *with* the time rather than
  // replacing it — and inside brackets against it, because a "+6" floating
  // after the arrival is a correction with two candidate times to belong to —
  // and the arrival is part of the same clause because "07:10 · → 08:14" reads
  // to a screen reader as two unrelated facts.
  const head =
    (delayLabel === null ? time : `${time} (${delayLabel})`) + (arrival ? ` → ${arrival}` : '');
  // The strip in reading order, without the ⇄ the clients draw: a glyph a
  // screen reader has to guess at is worse than the words either side of it.
  //
  // One vehicle earns no strip. Its window *is* the scan line — "07:12 → 07:22"
  // twice on one row is a line spent to add a line number — so a direct journey
  // says its vehicle the short way, exactly as it did before there were legs.
  const legsText = legs.length > 1 ? joinRow(legs.flatMap((leg) => [leg.change, leg.text])) : lines;
  return {
    whenMs,
    time,
    expected,
    expectedLabel: expected === null ? null : expectedTimeLabel(expected),
    delayLabel,
    delayMin,
    arrival,
    duration,
    lines,
    changes,
    legs,
    legsText,
    platform,
    statusLabel,
    realtime,
    predictionInaccurate: realtime && predictionInaccurate,
    cancelled,
    state: rowState(cancelled, delayMin, realtime),
    note,
    text: joinRow([head, statusLabel, duration, legsText, platform]),
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
    lines:
      journey.rides.length > 0
        ? journey.rides.map((entry) => `${transitModeGlyph(entry.mode)} ${entry.line}`).join(' → ')
        : 'walk',
    changes:
      journey.connections.length > 0
        ? journey.connections.map((change) => change.chip).join(' · ')
        : null,
    // The strip the panel draws, leg by leg. A change belongs to the vehicle it
    // precedes: `connections[i - 1]` is the wait before boarding `rides[i]`,
    // which is the same indexing both dashboards use.
    legs: journey.rides.map((entry, index) => {
      const change = journey.connections[index - 1];
      return {
        line: entry.line,
        mode: entry.mode,
        icon: transitModeGlyph(entry.mode),
        window: entry.window,
        text: `${transitModeGlyph(entry.mode)} ${entry.line} ${entry.window}`,
        change: change?.chip ?? null,
        wait: change?.label ?? null,
        // Where this vehicle is boarded, not where the journey started: the
        // train's platform at the change is the number a traveller already on
        // the bus is looking for, and the only one nothing else on the row says.
        quay: entry.fromQuay,
        state: entry.state,
      };
    }),
    quay: ride?.from.quay?.publicCode ?? null,
    realtime,
    predictionInaccurate: ride?.startPredictionInaccurate === true,
    // A planned journey carries no cancellation flag — the planner simply stops
    // offering a cancelled service. Its disruption notice is the honest signal,
    // and it lands in `note`.
    cancelled: false,
    note: tripNote(trip),
  });
}

/**
 * One departure as a widget row — the cheaper sibling board. The destination is
 * part of the row rather than optional decoration: filtering Engelsrud's board
 * to `RUT:Line:280` returns departures towards Dikemark *and* towards Asker,
 * interleaved, so a row without its direction is half an answer.
 */
export function departureWidgetRow(departure: TransitDeparture): TransitWidgetRow {
  return widgetRow({
    whenMs: departure.expectedDepartureMs,
    aimedMs: departure.aimedDepartureMs,
    // A stop board knows when the 280 leaves and nothing about where its reader
    // is going; inventing an arrival for it would be the widget's one number
    // nobody could check. For the same reason it has no legs: one departure is
    // not a journey, and a strip of one vehicle with no window would be a
    // journey's shape around a departure's facts.
    arrival: null,
    duration: null,
    lines: `${transitModeGlyph(departure.mode)} ${departure.line.publicCode} → ${departure.destination}`,
    changes: null,
    legs: [],
    quay: departure.quay.publicCode ?? null,
    realtime: departure.realtime,
    predictionInaccurate: departure.predictionInaccurate === true,
    cancelled: departure.cancelled,
    note: departure.situations[0]?.summary ?? null,
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
 * One planner answer as widget rows.
 *
 * Ordered the way the panel orders its list, and by the same function: in time
 * order, one row per departure. Entur ranks rather than sorts, so the three rows
 * a widget has room for were three of the planner's *favourites* — which on the
 * live corridor meant 20:42 above 20:29, and the same 20:42 bus twice because
 * two trains connect from it. Trimming to `maxRows` after that, not before, is
 * the point: the rows dropped are the late ones.
 */
function widgetRows(result: TransitResult, nowMs: number, maxRows: number): TransitWidgetRow[] {
  return commuteJourneyList(result.trips.map((trip, index) => commuteJourney(trip, nowMs, index)))
    .slice(0, maxRows)
    .map((journey) => tripWidgetRow(journey.trip, nowMs));
}

/** Why a block is empty, in words — and null when it is not empty to explain. */
function boardNote(
  rows: readonly TransitWidgetRow[],
  emptyReason: CommuteEmptyReason,
): string | null {
  return rows.length === 0 && emptyReason !== 'none' ? emptyDirectionNote(emptyReason) : null;
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
    const rows = widgetRows(result, nowMs, maxRows);
    return {
      key,
      label: commuteDirectionLabel(query, key),
      rows,
      note: boardNote(rows, emptyReason),
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

/**
 * The board a widget shows when it is pointed at **one hop** of the corridor —
 * TRANSIT.md §5's individual departure boards, on the surface they are most
 * use on.
 *
 * The journey board answers "when do I leave home and when do I get to town".
 * That is the right question at 07:05 and the wrong one at 08:55, when you are
 * already on the bus and the only thing left to know is when the train leaves
 * Asker. §5 puts the four per-leg boards under the panel for exactly that
 * traveller; a home screen is where they cost no taps at all, so an instance may
 * be configured for a hop instead of for a direction — and a second instance for
 * the hop after it.
 *
 * Three things follow from a hop being a `trip(A→B)` rather than a stop board,
 * and all three are why this shares `widgetRows` with the journey board instead
 * of formatting departures of its own:
 *
 *  - **A row still carries its arrival.** Entur's `estimatedCalls` at Engelsrud
 *    knows the 270 leaves at 08:36 and nothing about where its reader is going;
 *    the hop knows it reaches Asker at 09:02. The row that results is the §5
 *    sketch — `08:36  270` — with the half the sketch left out.
 *  - **Rows come in time order, one per departure**, by the same function the
 *    panel and the journey board use. A hop is one vehicle, so the leg strip
 *    collapses onto the scan line by itself: `"08:36 → 09:02 · 26 min · 270"`.
 *  - **The block is still a direction.** A hop belongs to the way out or the way
 *    home, so `key` stays the direction it came from and only `label` narrows,
 *    to `"Engelsrud terrasse → Asker stasjon"` — which is what the widget paints
 *    as its title when it has a single block.
 */
export function commuteSegmentWidgetBoard({
  query,
  segment,
  result,
  emptyReason,
  nowMs,
  maxRows = 3,
}: {
  query: TransitCommuteQuery;
  segment: CommuteSegment;
  result: TransitResult;
  emptyReason: CommuteEmptyReason;
  nowMs: number;
  maxRows?: number;
}): TransitWidgetBoard {
  const rows = widgetRows(result, nowMs, maxRows);
  const note = boardNote(rows, emptyReason);
  const source = widgetSourceLabel(rows.length > 0, note);
  return {
    // The corridor, not the hop: with one block the widget titles itself from
    // the block's own label, and `route` is what a surface listing several
    // instances has to tell them apart by — all four hops of one commute are
    // the same commute.
    route: commuteRouteLabel(query),
    directions: [{ key: segment.direction, label: segment.label, rows, note }],
    checkedMs: nowMs,
    source,
    checked: widgetCheckedLabel(nowMs),
    status: widgetStatusLine(source, nowMs),
    // Against the commute's own window, exactly as the journey board is: a hop
    // board with nothing upcoming is a hop board at 23:40, and it should sleep
    // until the commute reopens rather than ask through the night.
    nextRefreshMs: commuteRefreshAtMs(query, rows, nowMs),
  };
}

/** Minutes past midnight as the clock shows them: `430` → `"07:10"`. */
export function minutesOfDayLabel(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}
