import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/entur-asker-nationaltheatret.json' with { type: 'json' };
import { buildEnturRequest, parseEnturResponse, TransitError } from './entur.js';
import { fetchTransitTrips } from './client.js';
import { isRideMode, legDelayMs, transferCount, transitCoverage, tripLineCodes } from './model.js';

/**
 * The fixture is a real Entur v3 response, recorded 2026-07-20 for an
 * Asker → Nationaltheatret morning trip (polylines truncated to whole
 * coordinate pairs, intermediate calls capped — nothing reshaped). Testing
 * against recorded wire rather than a hand-written mock is what catches Entur
 * changing a field name on us.
 */

const asker = { lat: 59.8337, lng: 10.4348 };
const nationaltheatret = { lat: 59.9147, lng: 10.7333 };

describe('buildEnturRequest', () => {
  it('maps an Atlas query onto Entur variables', () => {
    const { variables } = buildEnturRequest({
      from: asker,
      to: nationaltheatret,
      dateTimeMs: Date.UTC(2026, 6, 21, 5, 30),
      walkSpeedMps: 1.1,
      limit: 3,
    });
    expect(variables.from).toEqual({ coordinates: { latitude: 59.8337, longitude: 10.4348 } });
    expect(variables.dateTime).toBe('2026-07-21T05:30:00.000Z');
    expect(variables.arriveBy).toBe(false);
    expect(variables.num).toBe(3);
    expect(variables.walkSpeed).toBe(1.1);
  });

  it('sends no mode filter unless the traveller picked modes', () => {
    // An unfiltered query must not pin `modes`: Entur then uses every mode,
    // and an empty selection means "all", never "none".
    expect(buildEnturRequest({ from: asker, to: nationaltheatret }).variables.modes).toBeNull();
    expect(
      buildEnturRequest({ from: asker, to: nationaltheatret, modes: [] }).variables.modes,
    ).toBeNull();
  });

  it('maps picked ride modes onto transportModes, keeping foot access', () => {
    const { variables } = buildEnturRequest({
      from: asker,
      to: nationaltheatret,
      modes: ['bus', 'tram'],
    });
    expect(variables.modes).toEqual({
      // Walking to and between stops is never negotiable — that is what makes
      // this a travel mode rather than the `foot` routing profile.
      accessMode: 'foot',
      egressMode: 'foot',
      directMode: 'foot',
      transportModes: [{ transportMode: 'bus' }, { transportMode: 'tram' }],
    });
  });

  it('drops modes with no wire equivalent rather than filtering to nothing', () => {
    const { variables } = buildEnturRequest({
      from: asker,
      to: nationaltheatret,
      modes: ['foot', 'unknown'],
    });
    expect(variables.modes).toBeNull();
  });

  it('defaults the time to the planner (null) and clamps the trip count', () => {
    const wide = buildEnturRequest({ from: asker, to: nationaltheatret, limit: 99 });
    expect(wide.variables.dateTime).toBeNull();
    expect(wide.variables.num).toBe(10);
    expect(buildEnturRequest({ from: asker, to: nationaltheatret, limit: 0 }).variables.num).toBe(
      1,
    );
  });
});

describe('parseEnturResponse', () => {
  const result = parseEnturResponse(fixture);

  it('reads the journey as walk / ride / walk legs', () => {
    const trip = result.trips[0]!;
    expect(trip.legs.map((leg) => leg.mode)).toEqual(['foot', 'rail', 'foot']);
    expect(trip.legs.filter((leg) => isRideMode(leg.mode))).toHaveLength(1);
    expect(transferCount(trip)).toBe(0);
    expect(tripLineCodes(trip)).toEqual(['R14']);
  });

  it('keeps the line, operator, headsign and colours a departure board needs', () => {
    const ride = result.trips[0]!.legs[1]!;
    expect(ride.line).toMatchObject({
      publicCode: 'R14',
      name: 'Asker-Oslo S-Kongsvinger',
      operator: 'Vy',
      headsign: 'Kongsvinger',
    });
    // Entur sends bare hex; CSS needs the '#'.
    expect(ride.line?.colour).toBe('#DF2027');
    expect(ride.line?.textColour).toBe('#FFFFFF');
  });

  it('keeps the quay, which is the part travellers actually need', () => {
    const ride = result.trips[0]!.legs[1]!;
    expect(ride.from.name).toBe('Asker stasjon');
    expect(ride.from.quay).toMatchObject({ id: 'NSR:Quay:700', publicCode: '2' });
    expect(ride.to.name).toBe('Nationaltheatret stasjon');
    expect(ride.to.quay?.publicCode).toBe('3');
  });

  it('parses times to epoch ms and derives the trip window from its legs', () => {
    const trip = result.trips[0]!;
    const ride = trip.legs[1]!;
    expect(new Date(ride.expectedStartMs).toISOString()).toBe('2026-07-21T05:33:00.000Z');
    expect(new Date(ride.expectedEndMs).toISOString()).toBe('2026-07-21T05:51:00.000Z');
    expect(trip.startMs).toBe(trip.legs[0]!.expectedStartMs);
    expect(trip.endMs).toBe(trip.legs[trip.legs.length - 1]!.expectedEndMs);
    expect(trip.durationMs).toBe(1458_000);
    expect(Math.round(trip.walkDistanceM)).toBe(410);
  });

  it('reports no delay when the live feed agrees with the timetable', () => {
    expect(legDelayMs(result.trips[0]!.legs[1]!)).toBe(0);
    expect(result.trips[0]!.legs[1]!.realtime).toBe(true);
  });

  it('decodes leg geometry as a precision-5 polyline', () => {
    const ride = result.trips[0]!.legs[1]!;
    expect(ride.points.length).toBeGreaterThan(1);
    // Precision 6 would divide these by ten and land the train in the Atlantic.
    expect(ride.points[0]!.lat).toBeCloseTo(59.83, 1);
    expect(ride.points[0]!.lng).toBeCloseTo(10.43, 1);
  });

  it('lists intermediate stops with their quays', () => {
    const stops = result.trips[0]!.legs[1]!.intermediateStops;
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0]!.name).toBe('Sandvika stasjon');
    expect(stops[0]!.quay?.publicCode).toBe('4');
  });

  it('returns several journey options', () => {
    expect(result.trips.length).toBeGreaterThan(1);
    expect(tripLineCodes(result.trips[1]!)).toEqual(['R13']);
  });
});

describe('parseEnturResponse — degenerate payloads', () => {
  it('treats no departures as an empty answer, not a failure', () => {
    // 01:00 on a Tuesday is a real query with a real, empty answer.
    expect(parseEnturResponse({ data: { trip: { tripPatterns: [] } } })).toEqual({ trips: [] });
    expect(parseEnturResponse({ data: { trip: null } })).toEqual({ trips: [] });
    expect(parseEnturResponse(null)).toEqual({ trips: [] });
  });

  it('throws on a GraphQL error', () => {
    expect(() => parseEnturResponse({ errors: [{ message: 'Invalid coordinates' }] })).toThrow(
      TransitError,
    );
    expect(() => parseEnturResponse({ errors: [{ message: 'Invalid coordinates' }] })).toThrow(
      'Invalid coordinates',
    );
  });

  it('falls back to the timetable when a leg carries no real-time update', () => {
    const [trip] = parseEnturResponse({
      data: {
        trip: {
          tripPatterns: [
            {
              duration: 60,
              walkDistance: 0,
              legs: [
                {
                  mode: 'bus',
                  aimedStartTime: '2026-07-21T07:33:00+02:00',
                  aimedEndTime: '2026-07-21T07:34:00+02:00',
                  line: { publicCode: '280' },
                },
              ],
            },
          ],
        },
      },
    }).trips;
    const leg = trip!.legs[0]!;
    expect(leg.expectedStartMs).toBe(leg.aimedStartMs);
    expect(legDelayMs(leg)).toBe(0);
    expect(leg.realtime).toBe(false);
    expect(leg.points).toEqual([]);
    expect(leg.intermediateStops).toEqual([]);
  });

  it('surfaces a real delay as the gap between aimed and expected', () => {
    const [trip] = parseEnturResponse({
      data: {
        trip: {
          tripPatterns: [
            {
              legs: [
                {
                  mode: 'bus',
                  realtime: true,
                  aimedStartTime: '2026-07-21T07:33:00+02:00',
                  expectedStartTime: '2026-07-21T07:36:30+02:00',
                  aimedEndTime: '2026-07-21T07:50:00+02:00',
                  expectedEndTime: '2026-07-21T07:53:00+02:00',
                },
              ],
            },
          ],
        },
      },
    }).trips;
    expect(legDelayMs(trip!.legs[0]!)).toBe(210_000);
  });

  it('names an unknown mode rather than dropping the leg', () => {
    const [trip] = parseEnturResponse({
      data: { trip: { tripPatterns: [{ legs: [{ mode: 'hyperloop' }] }] } },
    }).trips;
    expect(trip!.legs[0]!.mode).toBe('unknown');
  });
});

describe('transitCoverage', () => {
  it('covers journeys inside Norway', () => {
    expect(transitCoverage(asker, nationaltheatret)).toBe(true);
    expect(transitCoverage({ lat: 69.65, lng: 18.96 }, { lat: 58.15, lng: 8.0 })).toBe(true);
  });

  it('excludes journeys with an endpoint outside Norway', () => {
    const berlin = { lat: 52.52, lng: 13.4 };
    expect(transitCoverage(asker, berlin)).toBe(false);
    expect(transitCoverage(berlin, asker)).toBe(false);
    // Svalbard has no journey-planner coverage, so it is deliberately outside.
    expect(transitCoverage({ lat: 78.22, lng: 15.65 }, nationaltheatret)).toBe(false);
  });
});

describe('fetchTransitTrips', () => {
  it('posts the query to the backend and returns the trips', async () => {
    let seen: { url: string; body: unknown } | undefined;
    const result = await fetchTransitTrips(
      { from: asker, to: nationaltheatret },
      {
        fetchImpl: (async (url: string, init: RequestInit) => {
          seen = { url, body: JSON.parse(String(init.body)) };
          return new Response(JSON.stringify({ trips: [{ legs: [] }] }), { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    expect(seen?.url).toBe('/api/transit');
    expect(seen?.body).toMatchObject({ from: asker, to: nationaltheatret });
    expect(result.trips).toHaveLength(1);
  });

  it('refuses a journey outside Norway without calling the backend', async () => {
    const fetchImpl = (() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    await expect(
      fetchTransitTrips({ from: asker, to: { lat: 52.52, lng: 13.4 } }, { fetchImpl }),
    ).rejects.toThrow(/within Norway/);
  });

  it('turns a backend error into a TransitError carrying the status', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'journey planner unavailable' }), {
        status: 502,
      })) as unknown as typeof fetch;
    await expect(
      fetchTransitTrips({ from: asker, to: nationaltheatret }, { fetchImpl }),
    ).rejects.toMatchObject({ name: 'TransitError', status: 502 });
  });
});
