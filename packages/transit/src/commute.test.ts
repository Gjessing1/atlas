import { describe, expect, it } from 'vitest';
import { commuteTransitQueries, commuteTripMatches, filterCommuteResult } from './commute.js';
import type { TransitLeg, TransitTrip } from './model.js';

const place = (name: string) => ({ name, position: { lat: 59.9, lng: 10.6 } });

function leg(
  mode: TransitLeg['mode'],
  line: string | undefined,
  intermediateStops: string[] = [],
): TransitLeg {
  return {
    mode,
    distanceM: 1_000,
    durationMs: 300_000,
    aimedStartMs: 1,
    expectedStartMs: 1,
    aimedEndMs: 2,
    expectedEndMs: 2,
    realtime: true,
    from: place('Asker stasjon'),
    to: place('Nationaltheatret stasjon'),
    ...(line ? { line: { publicCode: line } } : {}),
    intermediateStops: intermediateStops.map(place),
    points: [],
    situations: [],
  };
}

const trip = (...legs: TransitLeg[]): TransitTrip => ({
  startMs: 1,
  endMs: 2,
  durationMs: 1,
  walkDistanceM: 0,
  legs,
});

const filter = { allowedBusLines: ['280', '71'], excludedRailStops: ['Hvalstad'] };

describe('saved commute filtering', () => {
  it('allows walking, exact allowed buses and express trains', () => {
    expect(
      commuteTripMatches(
        trip(leg('foot', undefined), leg('bus', '280'), leg('rail', 'R14', ['Sandvika stasjon'])),
        filter,
      ),
    ).toBe(true);
  });

  it('rejects another bus even when the rest of the journey matches', () => {
    expect(commuteTripMatches(trip(leg('bus', '281'), leg('rail', 'R14')), filter)).toBe(false);
  });

  it('rejects trains that call at an excluded small station', () => {
    expect(commuteTripMatches(trip(leg('rail', 'L1', ['Hvalstad stasjon'])), filter)).toBe(false);
  });

  it('matches line codes case-insensitively but never substitutes another ride mode', () => {
    expect(commuteTripMatches(trip(leg('coach', ' 280 ')), filter)).toBe(true);
    expect(commuteTripMatches(trip(leg('metro', '5')), filter)).toBe(false);
  });

  it('preserves result metadata while removing non-matching options', () => {
    const accepted = trip(leg('bus', '71'));
    const rejected = trip(leg('bus', '70'));
    expect(
      filterCommuteResult(
        { trips: [rejected, accepted], problems: [], nextCursor: 'later' },
        filter,
      ),
    ).toEqual({ trips: [accepted], problems: [], nextCursor: 'later' });
  });

  it('reverses both ends and the ordered interchanges for the return query', () => {
    const from = { name: 'Engelsrud', lat: 59.82, lng: 10.42 };
    const asker = { name: 'Asker', lat: 59.83, lng: 10.43 };
    const to = { name: 'Nationaltheatret', lat: 59.91, lng: 10.73 };
    const queries = commuteTransitQueries({ from, via: [asker], to, ...filter });
    expect(queries.outbound).toMatchObject({ from, via: [asker], to, limit: 10 });
    expect(queries.inbound).toMatchObject({ from: to, via: [asker], to: from, limit: 10 });
    expect(queries.outbound.modes).toEqual(['bus', 'rail']);
  });
});
