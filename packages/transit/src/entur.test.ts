import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/entur-asker-nationaltheatret.json' with { type: 'json' };
import {
  buildEnturDeparturesRequest,
  buildEnturRequest,
  parseEnturDeparturesResponse,
  parseEnturResponse,
  parseEnturStopLinesResponse,
  TransitError,
} from './entur.js';
import { fetchTransitDepartures, fetchTransitTrips } from './client.js';
import {
  isRideMode,
  legDelayMs,
  transferCount,
  transitCoverage,
  transitTripBounds,
  tripLineCodes,
} from './model.js';

/**
 * The fixture is a real Entur v3 response, recorded 2026-07-20 for an
 * Asker → Nationaltheatret morning trip (polylines truncated to whole
 * coordinate pairs, intermediate calls capped — nothing reshaped). Testing
 * against recorded wire rather than a hand-written mock is what catches Entur
 * changing a field name on us.
 */

const asker = { lat: 59.8337, lng: 10.4348 };
const nationaltheatret = { lat: 59.9147, lng: 10.7333 };

const departureCall = {
  aimedDepartureTime: '2026-07-21T07:33:00+02:00',
  expectedDepartureTime: '2026-07-21T07:36:00+02:00',
  realtime: true,
  cancellation: false,
  forBoarding: true,
  destinationDisplay: { frontText: 'Kongsvinger' },
  quay: { id: 'NSR:Quay:700', publicCode: '2', name: 'Asker stasjon' },
  serviceJourney: {
    id: 'NSB:ServiceJourney:123',
    transportMode: 'rail',
    line: {
      publicCode: 'R14',
      name: 'Asker-Oslo S-Kongsvinger',
      presentation: { colour: 'DF2027', textColour: 'FFFFFF' },
      operator: { name: 'Vy' },
    },
  },
  situations: [
    {
      situationNumber: 'VY:Situation:1',
      severity: 'normal',
      summary: [{ value: 'Signalfeil', language: 'no' }],
    },
  ],
};

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

  it('uses an exact searched stop id instead of re-snapping its coordinate', () => {
    const { variables } = buildEnturRequest({
      from: { ...asker, stopId: 'NSR:StopPlace:59872' },
      to: { ...nationaltheatret, stopId: 'NSR:StopPlace:58404' },
    });
    expect(variables.from).toEqual({ place: 'NSR:StopPlace:59872' });
    expect(variables.to).toEqual({ place: 'NSR:StopPlace:58404' });
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
      // The Bus chip carries coach with it: they are one control, even though
      // the wire (and a leg's own label) keeps them apart.
      transportModes: [
        { transportMode: 'bus' },
        { transportMode: 'coach' },
        { transportMode: 'tram' },
      ],
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

  /**
   * Measured against the live planner on 2026-07-30, and the reason this is
   * asserted rather than assumed: `filters: []` is **not** "no filter". It reads
   * as "match none of these", and Engelsrud → Nationaltheatret — five journeys
   * with `filters: null` — answers `noTransitConnection` with the empty array.
   * So a commute with nothing ticked yet must send null, or the honest default
   * reports the corridor as unserved.
   */
  it('sends no line filter as null, never as an empty array', () => {
    for (const lineFilter of [undefined, { select: [] }, { select: [], exclude: [] }]) {
      expect(
        buildEnturRequest({ from: asker, to: nationaltheatret, lineFilter }).variables.filters,
      ).toBeNull();
    }
  });

  it('asks the planner for the chosen lines, and against the excluded ones', () => {
    const { variables } = buildEnturRequest({
      from: asker,
      to: nationaltheatret,
      lineFilter: { select: ['RUT:Line:280', 'VYG:Line:RE10'], exclude: ['VYG:Line:L1'] },
    });
    expect(variables.filters).toEqual([
      {
        select: [{ lines: ['RUT:Line:280', 'VYG:Line:RE10'] }],
        not: [{ lines: ['VYG:Line:L1'] }],
      },
    ]);
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

  it('frames every decoded leg for the map hand-off', () => {
    const bounds = transitTripBounds(result.trips[0]!);
    expect(bounds).not.toBeNull();
    const [west, south, east, north] = bounds!;
    expect(west).toBeLessThan(east);
    expect(south).toBeLessThan(north);
    for (const leg of result.trips[0]!.legs) {
      for (const point of leg.points) {
        expect(point.lng).toBeGreaterThanOrEqual(west);
        expect(point.lng).toBeLessThanOrEqual(east);
        expect(point.lat).toBeGreaterThanOrEqual(south);
        expect(point.lat).toBeLessThanOrEqual(north);
      }
    }
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
    expect(parseEnturResponse({ data: { trip: { tripPatterns: [] } } })).toEqual({
      trips: [],
      problems: [],
    });
    expect(parseEnturResponse({ data: { trip: null } })).toEqual({ trips: [], problems: [] });
    expect(parseEnturResponse(null)).toEqual({ trips: [], problems: [] });
  });

  it('keeps the planner’s own reason for an empty answer', () => {
    // "Nothing runs at that hour" and "there are no stops near you" send a
    // traveller in opposite directions; collapsing them into one message sends
    // half of them the wrong way.
    const result = parseEnturResponse({
      data: {
        trip: {
          tripPatterns: [],
          routingErrors: [
            { code: 'noStopsInRange', inputField: 'to' },
            { code: 'somethingEnturAddedLater' },
          ],
        },
      },
    });
    expect(result.problems).toEqual([
      { code: 'noStopsInRange', inputField: 'to' },
      // An unknown code still counts as *a* reason, so the board does not fall
      // back to inventing one.
      { code: 'unknown' },
    ]);
  });

  it('carries the page cursors so Earlier/Later can page departures', () => {
    const result = parseEnturResponse({
      data: {
        trip: { tripPatterns: [], nextPageCursor: 'next-abc', previousPageCursor: 'prev-xyz' },
      },
    });
    expect(result.nextCursor).toBe('next-abc');
    expect(result.previousCursor).toBe('prev-xyz');
    // Absent rather than empty-string at the ends of the timetable, so a UI can
    // hide the control instead of paging to nowhere.
    expect(parseEnturResponse({ data: { trip: { tripPatterns: [] } } }).nextCursor).toBeUndefined();
  });

  it('sends a page cursor instead of a time window when paging', () => {
    const { variables } = buildEnturRequest({
      from: asker,
      to: nationaltheatret,
      pageCursor: 'next-abc',
    });
    expect(variables.pageCursor).toBe('next-abc');
  });

  it('takes the per-passenger CO₂ figure, and refuses a nonsensical one', () => {
    /** One trip pattern carrying the given `emission` wire value. */
    const co2Of = (emission: unknown) =>
      parseEnturResponse({
        data: {
          trip: {
            tripPatterns: [
              { duration: 600, walkDistance: 0, emission, legs: [{ mode: 'rail', duration: 600 }] },
            ],
          },
        },
      }).trips[0]!.co2Grams;

    // Grams per passenger, as Entur reports them for this exact journey.
    expect(co2Of({ co2: 742.871 })).toBe(742.871);
    // A trip Entur cannot account for says nothing rather than "0 g" — and a
    // negative figure is a data fault, not a carbon-negative train.
    expect(co2Of(null)).toBeUndefined();
    expect(co2Of({ co2: null })).toBeUndefined();
    expect(co2Of({ co2: -5 })).toBeUndefined();
    // An all-walk journey has no emitting leg to account for.
    expect(co2Of(undefined)).toBeUndefined();
  });

  it('asks Entur for the emission figure', () => {
    expect(buildEnturRequest({ from: asker, to: nationaltheatret }).query).toContain(
      'emission{co2}',
    );
  });

  /** One trip with one ride leg carrying the given extra wire fields. */
  function legWith(extra: Record<string, unknown>) {
    const [trip] = parseEnturResponse({
      data: {
        trip: {
          tripPatterns: [
            { duration: 600, walkDistance: 0, legs: [{ mode: 'rail', duration: 600, ...extra }] },
          ],
        },
      },
    }).trips;
    return trip!.legs[0]!;
  }

  it('surfaces disruption notices, preferring Norwegian and dropping empty ones', () => {
    const leg = legWith({
      situations: [
        {
          situationNumber: 'RUT:SituationNumber:1',
          severity: 'severe',
          summary: [
            { value: 'Cancelled', language: 'en' },
            { value: 'Innstilt', language: 'no' },
          ],
          description: [{ value: 'Signalfeil ved Lysaker', language: 'no' }],
          advice: [{ value: 'Bruk buss for tog', language: 'no' }],
          infoLinks: [{ uri: 'https://vy.no/avvik' }],
        },
        // Nothing to read — an alarm icon with no message is worse than silence.
        { situationNumber: 'x', severity: 'normal', summary: [] },
      ],
    });
    expect(leg.situations).toHaveLength(1);
    expect(leg.situations[0]).toMatchObject({
      id: 'RUT:SituationNumber:1',
      summary: 'Innstilt',
      description: 'Signalfeil ved Lysaker',
      advice: 'Bruk buss for tog',
      severity: 'severe',
      url: 'https://vy.no/avvik',
    });
  });

  it('treats an unclassified notice as a warning, not as a footnote', () => {
    // Under-warning is the costlier mistake: operators leave `severity` unset
    // on cancellations more often than on trivia.
    expect(
      legWith({ situations: [{ summary: [{ value: 'Noe skjer' }] }] }).situations[0],
    ).toMatchObject({ severity: 'warning' });
    expect(
      legWith({ situations: [{ severity: 'slight', summary: [{ value: 'Litt' }] }] }).situations[0],
    ).toMatchObject({ severity: 'info' });
  });

  it('drops a description that only repeats the summary', () => {
    const leg = legWith({
      situations: [{ summary: [{ value: 'Innstilt' }], description: [{ value: 'Innstilt' }] }],
    });
    expect(leg.situations[0]!.description).toBeUndefined();
  });

  it('flags a leg that must be booked ahead, and only such a leg', () => {
    // Turning up unbooked at a `bestillingstransport` stop means nothing comes.
    const flexible = legWith({
      bookingArrangements: {
        bookingMethods: ['callOffice'],
        latestBookingTime: '14:00',
        latestBookingDay: 1,
        bookingContact: { phone: '77 00 00 00' },
      },
    });
    expect(flexible.booking).toMatchObject({
      methods: ['callOffice'],
      latestTime: '14:00',
      latestDayOffset: 1,
      phone: '77 00 00 00',
    });

    // Entur attaches an empty arrangement to ordinary scheduled legs too;
    // warning on those would make the warning meaningless.
    expect(legWith({ bookingArrangements: { bookingMethods: [] } }).booking).toBeUndefined();
    expect(legWith({}).booking).toBeUndefined();
  });

  it('leaves an undisrupted leg with no notices at all', () => {
    expect(legWith({}).situations).toEqual([]);
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

describe('departure boards', () => {
  it('queries an exact stop id, or the nearest whole stop for a coordinate', () => {
    const exact = buildEnturDeparturesRequest({
      ...asker,
      stopId: 'NSR:StopPlace:59872',
      startTimeMs: Date.UTC(2026, 6, 21, 5, 30),
      limit: 99,
    });
    expect(exact.query).toContain('stopPlace(id:$id)');
    expect(exact.variables).toEqual({
      id: 'NSR:StopPlace:59872',
      start: '2026-07-21T05:30:00.000Z',
      limit: 50,
      range: 3600,
    });

    const nearest = buildEnturDeparturesRequest(asker);
    expect(nearest.query).toContain('filterByPlaceTypes:[stopPlace]');
    expect(nearest.query).toContain('maximumDistance:1500');
    expect(nearest.variables).toEqual({
      lat: asker.lat,
      lng: asker.lng,
      limit: 30,
      range: 3600,
    });
  });

  /**
   * Measured against the live planner: `estimatedCalls(startTime:)` is not like
   * `trip(dateTime:)`. Passing an explicit null crashes Entur's resolver
   * ("Cannot invoke java.lang.Long.longValue()"), so "now" has to be an absent
   * variable — the case every card hits, since no card picks a time.
   */
  it('omits startTime entirely rather than sending null for "now"', () => {
    for (const request of [
      buildEnturDeparturesRequest(asker),
      buildEnturDeparturesRequest({ ...asker, stopId: 'NSR:StopPlace:59872' }),
    ]) {
      expect(request.variables).not.toHaveProperty('start');
      expect(Object.keys(request.variables)).not.toContain('start');
    }
  });

  it('maps live departure, platform, line and disruption details', () => {
    const result = parseEnturDeparturesResponse({
      data: {
        stopPlace: {
          id: 'NSR:StopPlace:59872',
          name: 'Asker stasjon',
          latitude: asker.lat,
          longitude: asker.lng,
          estimatedCalls: [
            { ...departureCall, forBoarding: false },
            departureCall,
            {
              ...departureCall,
              aimedDepartureTime: '2026-07-21T07:30:00+02:00',
              expectedDepartureTime: '2026-07-21T07:30:00+02:00',
              cancellation: true,
              destinationDisplay: { frontText: 'Oslo S' },
            },
          ],
        },
      },
    });

    expect(result.stop).toEqual({
      id: 'NSR:StopPlace:59872',
      name: 'Asker stasjon',
      position: asker,
    });
    // Sorted by the time the vehicle is now expected, not upstream order.
    expect(result.departures.map((departure) => departure.destination)).toEqual([
      'Oslo S',
      'Kongsvinger',
    ]);
    expect(result.departures[0]!.cancelled).toBe(true);
    expect(result.departures[1]).toMatchObject({
      mode: 'rail',
      aimedDepartureMs: Date.parse('2026-07-21T07:33:00+02:00'),
      expectedDepartureMs: Date.parse('2026-07-21T07:36:00+02:00'),
      realtime: true,
      line: {
        publicCode: 'R14',
        operator: 'Vy',
        colour: '#DF2027',
        textColour: '#FFFFFF',
      },
      quay: { id: 'NSR:Quay:700', publicCode: '2' },
      situations: [{ summary: 'Signalfeil', severity: 'warning' }],
    });
  });

  it('keeps nearest-stop distance and treats no nearby stop as an empty answer', () => {
    const nearest = parseEnturDeparturesResponse({
      data: {
        nearest: {
          edges: [
            {
              node: {
                distance: 314.4,
                place: {
                  id: 'NSR:StopPlace:1',
                  name: 'Torget',
                  latitude: 60,
                  longitude: 10,
                  estimatedCalls: [],
                },
              },
            },
          ],
        },
      },
    });
    expect(nearest.stop?.distanceM).toBe(314.4);
    expect(nearest.departures).toEqual([]);
    expect(parseEnturDeparturesResponse({ data: { nearest: { edges: [] } } })).toEqual({
      stop: null,
      departures: [],
    });
  });

  it('throws on a departure-board GraphQL error', () => {
    expect(() => parseEnturDeparturesResponse({ errors: [{ message: 'Unknown stop' }] })).toThrow(
      'Unknown stop',
    );
  });

  /**
   * The live shape for a coordinate with nothing near it. Entur answers with a
   * resolver error, not an empty edge list, so an untranslated version of this
   * tells a hiker their connection is broken.
   */
  it('reads "no stop within range" as an empty board, not a failure', () => {
    expect(
      parseEnturDeparturesResponse({
        errors: [
          {
            message:
              'Exception while fetching data (/nearest) : RoutingError{code: LOCATION_NOT_FOUND, inputField: FROM_PLACE}',
            path: ['nearest'],
            extensions: { classification: 'DataFetchingException' },
          },
        ],
        data: { nearest: null },
      }),
    ).toEqual({ stop: null, departures: [] });
  });

  it('still fails loudly when the planner itself is broken', () => {
    expect(() =>
      parseEnturDeparturesResponse({
        errors: [
          { message: 'LOCATION_NOT_FOUND somewhere else entirely', path: ['stopPlace'] },
          {
            message:
              'Exception while fetching data (/nearest) : RoutingError{code: LOCATION_NOT_FOUND}',
            path: ['nearest'],
          },
        ],
        data: { nearest: null },
      }),
    ).toThrow('LOCATION_NOT_FOUND somewhere else entirely');
  });
});

/**
 * Recorded from the live planner on 2026-07-30 for Engelsrud
 * (`NSR:StopPlace:3369`) — the stop the old board's hard-coded `['280','71']`
 * was really about. Two facts here matter more than the shape: the same two
 * lines are published under *both* stands, and the "71" is `BRA:Line:4_6071`
 * (Brakar), not the Ruter line anybody typing "71" would mean.
 */
const stopLinesWire = {
  data: {
    stopPlace: {
      id: 'NSR:StopPlace:3369',
      name: 'Engelsrud',
      latitude: 59.819858,
      longitude: 10.36596,
      quays: [
        {
          lines: [
            {
              id: 'RUT:Line:280',
              publicCode: '280',
              name: 'Asker - Dikemark - Heggedal',
              transportMode: 'bus',
              presentation: { colour: '76A300', textColour: 'FFFFFF' },
              authority: { name: 'Ruter' },
            },
            {
              id: 'BRA:Line:4_6071',
              publicCode: '71',
              name: 'Drammen - Stoppen - Lierbyen - Asker',
              transportMode: 'bus',
              presentation: { colour: null, textColour: null },
              authority: { name: 'Brakar' },
            },
          ],
        },
        {
          lines: [
            {
              id: 'BRA:Line:4_6071',
              publicCode: '71',
              name: 'Drammen - Stoppen - Lierbyen - Asker',
              transportMode: 'bus',
              authority: { name: 'Brakar' },
            },
            { id: 'RUT:Line:280', publicCode: '280', transportMode: 'bus' },
          ],
        },
      ],
    },
  },
};

describe('stop lines', () => {
  it('dedupes the lines a stop publishes under every quay', () => {
    const { stop, lines } = parseEnturStopLinesResponse(stopLinesWire);
    expect(stop).toEqual({
      id: 'NSR:StopPlace:3369',
      name: 'Engelsrud',
      position: { lat: 59.819858, lng: 10.36596 },
    });
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.id)).toEqual(['BRA:Line:4_6071', 'RUT:Line:280']);
  });

  it('keeps the identity a code cannot carry', () => {
    const { lines } = parseEnturStopLinesResponse(stopLinesWire);
    // "71" here is Brakar's, not Ruter's — the whole reason a saved commute
    // stores ids and only shows codes.
    expect(lines[0]).toEqual({
      id: 'BRA:Line:4_6071',
      publicCode: '71',
      mode: 'bus',
      name: 'Drammen - Stoppen - Lierbyen - Asker',
      operator: 'Brakar',
    });
  });

  it('sorts codes as a timetable reads them, not as text', () => {
    const wire = {
      data: {
        stopPlace: {
          id: 'x',
          name: 'x',
          quays: [
            {
              lines: [
                { id: 'a', publicCode: '280', transportMode: 'bus' },
                { id: 'b', publicCode: '71', transportMode: 'bus' },
                { id: 'c', publicCode: 'RE10', transportMode: 'rail' },
              ],
            },
          ],
        },
      },
    };
    expect(parseEnturStopLinesResponse(wire).lines.map((line) => line.publicCode)).toEqual([
      // Buses before trains (chip order), and 71 before 280.
      '71',
      '280',
      'RE10',
    ]);
  });

  it('drops a line with no id — a chip that cannot filter is a dead control', () => {
    const wire = {
      data: { stopPlace: { id: 'x', name: 'x', quays: [{ lines: [{ publicCode: '9' }] }] } },
    };
    expect(parseEnturStopLinesResponse(wire).lines).toEqual([]);
  });

  it('reports an unknown stop as an empty picker rather than an error', () => {
    expect(parseEnturStopLinesResponse({ data: { stopPlace: null } })).toEqual({
      stop: null,
      lines: [],
    });
  });

  it('surfaces a GraphQL error', () => {
    expect(() => parseEnturStopLinesResponse({ errors: [{ message: 'boom' }] })).toThrow(
      TransitError,
    );
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

describe('fetchTransitDepartures', () => {
  it('gets a next-hour board from the Atlas proxy', async () => {
    let seen = '';
    const result = await fetchTransitDepartures(
      { ...asker, stopId: 'NSR:StopPlace:59872', limit: 12 },
      {
        baseUrl: 'https://atlas.test',
        fetchImpl: (async (url: string) => {
          seen = String(url);
          return new Response(JSON.stringify({ stop: null, departures: [] }), { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    const url = new URL(seen);
    expect(url.pathname).toBe('/api/transit/departures');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      lat: String(asker.lat),
      lon: String(asker.lng),
      stopId: 'NSR:StopPlace:59872',
      limit: '12',
    });
    expect(result).toEqual({ stop: null, departures: [] });
  });

  it('refuses an outside-Norway board without calling the backend', async () => {
    const fetchImpl = (() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    await expect(fetchTransitDepartures({ lat: 52.52, lng: 13.4 }, { fetchImpl })).rejects.toThrow(
      /within Norway/,
    );
  });
});
