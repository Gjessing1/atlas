import { nextCommuteInstant, norwayTime, runsOnWeekday, type TransitWeekday } from './clock.js';
import { expandModeFilter, isRideMode, filterModeOf } from './model.js';
import type {
  TransitCommuteDirection,
  TransitCommuteFilter,
  TransitCommuteQuery,
  TransitCommuteTime,
  TransitLineFilter,
  TransitQuery,
  TransitResult,
  TransitTrip,
} from './model.js';

/**
 * A saved commute, turned into the two questions Entur is asked.
 *
 * The point of this file is that the filtering happens *in the question*.
 * Previously the board asked unfiltered, threw most of the answer away, and —
 * finding the remainder empty, which it usually was — re-asked at a 6 h and
 * then a 24 h window, up to three upstream calls per direction and six per
 * widget refresh every fifteen minutes. `trip(filters:)` does the same job
 * upstream in one 0.6 s call. `commuteTripMatches` survives only as a safety
 * net for the part of the intent the wire cannot express.
 */

/** The line ids to plan with, or undefined when the commute names no lines. */
export function commuteLineFilter(filter: TransitCommuteFilter): TransitLineFilter | undefined {
  const select = filter.select.map((line) => line.id).filter(Boolean);
  const exclude = filter.exclude.map((line) => line.id).filter(Boolean);
  if (select.length === 0 && exclude.length === 0) return undefined;
  return {
    ...(select.length > 0 ? { select } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

/**
 * Whether a journey obeys the commute's own rules.
 *
 * A safety net, not the filter: the planner has already been asked for exactly
 * these lines, so anything this rejects is either a mode the wire filter cannot
 * express or a leg Entur substituted (a replacement bus on a rail line keeps the
 * rail line's id). Kept because "the 280 or nothing" is a promise the board
 * makes, and a promise checked in one place only is a promise checked nowhere
 * when that place changes.
 *
 * Walking is always allowed — it is part of every journey, not a service the
 * traveller chose.
 */
export function commuteTripMatches(trip: TransitTrip, filter: TransitCommuteFilter): boolean {
  const selected = new Set(filter.select.map((line) => line.id));
  const excluded = new Set(filter.exclude.map((line) => line.id));
  const modes = new Set(expandModeFilter([...filter.modes]));

  return trip.legs.every((leg) => {
    if (!isRideMode(leg.mode)) return true;
    if (modes.size > 0 && !modes.has(leg.mode)) return false;
    const id = leg.line?.id;
    // A ride leg with no line id cannot be checked against a line list. It is
    // let through rather than dropped: the alternative is a board that silently
    // hides a real departure because Entur omitted a field.
    if (!id) return true;
    if (excluded.has(id)) return false;
    return selected.size === 0 || selected.has(id);
  });
}

/** Keep result metadata and filter only its journey options. */
export function filterCommuteResult(
  result: TransitResult,
  filter: TransitCommuteFilter,
): TransitResult {
  return {
    ...result,
    trips: result.trips.filter((trip) => commuteTripMatches(trip, filter)),
  };
}

/** The time argument for one direction, resolved against a Norwegian clock. */
function timeArguments(
  time: TransitCommuteTime,
  days: readonly TransitWeekday[],
  nowMs: number,
): Pick<TransitQuery, 'dateTimeMs' | 'arriveBy'> {
  // "Leave now" stays absent rather than being pinned to this millisecond, so
  // Entur applies its own "now" and a cached answer is still a valid one.
  if (time.minutesOfDay === null) return {};
  return {
    dateTimeMs: nextCommuteInstant(time.minutesOfDay, days, nowMs),
    ...(time.arriveBy ? { arriveBy: true } : {}),
  };
}

/**
 * Build the two Entur questions represented by a reversible commute.
 *
 * `nowMs` is passed in rather than read: the same resolution has to happen on
 * the backend (rendering the widget) and in a test, and a function that reads
 * the clock cannot be checked against the evening case that made the times
 * necessary.
 */
export function commuteTransitQueries(
  query: TransitCommuteQuery,
  nowMs: number,
): Record<TransitCommuteDirection, TransitQuery> {
  const limit = query.limit ?? 6;
  const lineFilter = commuteLineFilter(query.filter);
  const shared = {
    limit,
    ...(query.filter.modes.length > 0 ? { modes: query.filter.modes } : {}),
    ...(lineFilter ? { lineFilter } : {}),
  };
  return {
    outbound: {
      from: query.from,
      via: query.via,
      to: query.to,
      ...shared,
      ...timeArguments(query.outboundTime, query.days, nowMs),
    },
    inbound: {
      from: query.to,
      via: [...query.via].reverse(),
      to: query.from,
      ...shared,
      ...timeArguments(query.inboundTime, query.days, nowMs),
    },
  };
}

/**
 * Which direction a board should open on, from the clock rather than always
 * outbound. Before the outbound departure, you are going out; after it, the
 * next thing you need is the way home — which is what a board opened at 16:30
 * is being opened for. Falls back to outbound when no times are saved.
 */
export function defaultCommuteDirection(
  query: Pick<TransitCommuteQuery, 'outboundTime' | 'inboundTime'>,
  nowMs: number,
): TransitCommuteDirection {
  const out = query.outboundTime.minutesOfDay;
  const back = query.inboundTime.minutesOfDay;
  if (out === null) return 'outbound';
  const now = norwayTime(nowMs).minutesOfDay;
  if (now < out) return 'outbound';
  // Past the return time too, the useful answer is tomorrow morning again.
  if (back !== null && now >= back) return 'outbound';
  return 'inbound';
}

/**
 * Why a direction has no journeys, told apart from each other.
 *
 * `upstream` is the planner saying nothing runs at all; `filtered` is the
 * commute's own selection having removed every option. The previous board
 * rendered both as one sentence about "these exact line and stop rules",
 * leaving nobody able to tell "the last bus has gone" from "tick one more
 * line". They are distinguishable because a restricted `select` turns an
 * otherwise-served corridor into `noTransitConnection` — measured: Engelsrud →
 * Nationaltheatret with only the bus selected reports exactly that, while the
 * same query unfiltered returns five journeys.
 */
export type CommuteEmptyReason = 'none' | 'upstream' | 'filtered';

export function commuteEmptyReason(
  result: TransitResult,
  filter: TransitCommuteFilter,
  /** Journeys before the local safety net, when the caller ran one. */
  upstreamTripCount = result.trips.length,
): CommuteEmptyReason {
  if (result.trips.length > 0) return 'none';
  // The safety net rejected everything the planner offered: unambiguously ours.
  if (upstreamTripCount > 0) return 'filtered';
  const codes = new Set(result.problems.map((problem) => problem.code));
  // "Nothing at this time" and "the timetable doesn't reach that date" are the
  // planner's answers whether or not a filter is set, so they stay upstream.
  if (codes.has('noTransitConnectionInSearchWindow') || codes.has('outsideServicePeriod')) {
    return 'upstream';
  }
  const restricted =
    filter.select.length > 0 || filter.exclude.length > 0 || filter.modes.length > 0;
  return restricted && codes.has('noTransitConnection') ? 'filtered' : 'upstream';
}

/** Whether the commute is inside a window it runs in, at `nowMs`. */
export function commuteIsActive(query: TransitCommuteQuery, nowMs: number): boolean {
  return runsOnWeekday(query.days, norwayTime(nowMs).weekday);
}

/** The modes a set of journeys actually used — the chips a board should show lit. */
export function tripModes(trips: readonly TransitTrip[]): string[] {
  const modes = new Set<string>();
  for (const trip of trips) {
    for (const leg of trip.legs) {
      if (isRideMode(leg.mode)) modes.add(filterModeOf(leg.mode));
    }
  }
  return [...modes];
}
