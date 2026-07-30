import { isRideMode } from './model.js';
import type {
  TransitCommuteFilter,
  TransitCommuteQuery,
  TransitQuery,
  TransitResult,
  TransitTrip,
} from './model.js';

const normalized = (value: string): string => value.trim().toLocaleLowerCase('nb-NO');

/**
 * Whether a journey obeys the commute's exact service rules.
 *
 * Walking is always allowed. Bus/coach legs must be explicitly allow-listed,
 * rail legs must not call at an excluded station, and every other vehicle mode
 * is rejected. Stop matching is intentionally substring-based so the saved
 * name "Hvalstad" also excludes Entur's "Hvalstad stasjon".
 */
export function commuteTripMatches(trip: TransitTrip, filter: TransitCommuteFilter): boolean {
  const allowedBuses = new Set(filter.allowedBusLines.map(normalized).filter(Boolean));
  const excludedRail = filter.excludedRailStops.map(normalized).filter(Boolean);

  return trip.legs.every((leg) => {
    if (!isRideMode(leg.mode)) return true;
    if (leg.mode === 'bus' || leg.mode === 'coach') {
      return Boolean(leg.line && allowedBuses.has(normalized(leg.line.publicCode)));
    }
    if (leg.mode !== 'rail') return false;
    const calls = [leg.from, ...leg.intermediateStops, leg.to].map((place) =>
      normalized(place.name),
    );
    return !excludedRail.some((excluded) => calls.some((call) => call.includes(excluded)));
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

/** Build the two Entur questions represented by a reversible commute. */
export function commuteTransitQueries(query: TransitCommuteQuery): {
  outbound: TransitQuery;
  inbound: TransitQuery;
} {
  const limit = query.limit ?? 10;
  return {
    outbound: {
      from: query.from,
      via: query.via,
      to: query.to,
      modes: ['bus', 'rail'],
      limit,
    },
    inbound: {
      from: query.to,
      via: [...query.via].reverse(),
      to: query.from,
      modes: ['bus', 'rail'],
      limit,
    },
  };
}
