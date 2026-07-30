import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerTransitApi } from './transit-api.js';
import { StatusRegistry } from './status.js';

const asker = { lat: 59.8337, lng: 10.4348 };
const nationaltheatret = { lat: 59.9147, lng: 10.7333 };

/** A minimal but wire-accurate Entur reply: one walk leg, one rail leg. */
const enturReply = {
  data: {
    trip: {
      tripPatterns: [
        {
          duration: 1458,
          walkDistance: 410.37,
          legs: [
            {
              mode: 'foot',
              distance: 44,
              duration: 34,
              aimedStartTime: '2026-07-21T07:32:26+02:00',
              aimedEndTime: '2026-07-21T07:33:00+02:00',
              fromPlace: { name: 'Origin', latitude: 59.8337, longitude: 10.4348 },
              toPlace: { name: 'Asker stasjon', latitude: 59.8334, longitude: 10.4343 },
            },
            {
              mode: 'rail',
              distance: 21562,
              duration: 1080,
              realtime: true,
              aimedStartTime: '2026-07-21T07:33:00+02:00',
              expectedStartTime: '2026-07-21T07:33:00+02:00',
              aimedEndTime: '2026-07-21T07:51:00+02:00',
              expectedEndTime: '2026-07-21T07:51:00+02:00',
              line: { publicCode: 'R14', name: 'Asker-Oslo S-Kongsvinger' },
              authority: { name: 'Vy' },
              fromPlace: {
                name: 'Asker stasjon',
                latitude: 59.8334,
                longitude: 10.4343,
                quay: { id: 'NSR:Quay:700', publicCode: '2' },
              },
              toPlace: {
                name: 'Nationaltheatret stasjon',
                latitude: 59.9154,
                longitude: 10.7276,
                quay: { id: 'NSR:Quay:477', publicCode: '3' },
              },
            },
          ],
        },
      ],
    },
  },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

let app: FastifyInstance;
let captured: Captured | undefined;
let respond: () => Response;

beforeEach(async () => {
  captured = undefined;
  respond = () => new Response(JSON.stringify(enturReply), { status: 200 });
  app = Fastify();
  registerTransitApi(app, {
    status: new StatusRegistry(),
    fetchImpl: (async (url: string, init: RequestInit) => {
      captured = {
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: init.body
          ? (JSON.parse(String(init.body)) as Captured['body'])
          : { query: '', variables: {} },
      };
      return respond();
    }) as unknown as typeof fetch,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const plan = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/transit', payload: payload as object });

describe('POST /api/transit', () => {
  it('pins a searched endpoint to its exact NSR StopPlace id', async () => {
    await plan({
      from: { ...asker, stopId: 'NSR:StopPlace:59872' },
      to: { ...nationaltheatret, stopId: 'NSR:StopPlace:58404' },
    });

    expect(captured?.body.variables).toMatchObject({
      from: { place: 'NSR:StopPlace:59872' },
      to: { place: 'NSR:StopPlace:58404' },
    });
  });

  it('falls back to coordinates when optional stop metadata is malformed', async () => {
    await plan({
      from: { ...asker, stopId: 'not-a-stop' },
      to: nationaltheatret,
    });

    expect(captured?.body.variables.from).toEqual({
      coordinates: { latitude: asker.lat, longitude: asker.lng },
    });
  });

  it('widens a step at a time when the planner returned nothing', async () => {
    // Measured against live Entur: Å i Lofoten → Svolvær at 23:30 comes back
    // empty although a 04:24 bus exists, because Entur's own look-ahead is a
    // dynamic few hours. An empty answer is therefore not believed first time.
    // The cheap 6 h step answers first — a full day costs 7.5 s upstream, close
    // enough to UPSTREAM_TIMEOUT_MS to fail on the very route that needs it.
    const windows: unknown[] = [];
    let calls = 0;
    respond = () => {
      calls += 1;
      windows.push(captured!.body.variables.searchWindow);
      const body = calls === 1 ? { data: { trip: { tripPatterns: [] } } } : enturReply;
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const res = await plan({ from: asker, to: nationaltheatret });

    expect(calls).toBe(2);
    expect(windows).toEqual([null, 6 * 60]);
    expect(res.json().trips).toHaveLength(1);
  });

  it('escalates to a full day only when the cheaper window is also empty', async () => {
    const windows: unknown[] = [];
    respond = () => {
      windows.push(captured!.body.variables.searchWindow);
      // Nothing runs at all: every window must be tried, widest last.
      return new Response(JSON.stringify({ data: { trip: { tripPatterns: [] } } }), {
        status: 200,
      });
    };

    const res = await plan({ from: asker, to: nationaltheatret });

    expect(windows).toEqual([null, 6 * 60, 24 * 60]);
    expect(res.json().trips).toEqual([]);
  });

  it('does not widen the window when the first answer already has departures', async () => {
    let calls = 0;
    respond = () => {
      calls += 1;
      return new Response(JSON.stringify(enturReply), { status: 200 });
    };

    await plan({ from: asker, to: nationaltheatret });

    // A wide window costs the planner real work; the default already answered.
    expect(calls).toBe(1);
    expect(captured!.body.variables.searchWindow).toBeNull();
  });

  it('respects a window the caller chose, rather than overriding it on empty', async () => {
    let calls = 0;
    respond = () => {
      calls += 1;
      return new Response(JSON.stringify({ data: { trip: { tripPatterns: [] } } }), {
        status: 200,
      });
    };

    const res = await plan({ from: asker, to: nationaltheatret, searchWindowMinutes: 60 });

    expect(calls).toBe(1);
    expect(captured!.body.variables.searchWindow).toBe(60);
    expect(res.json().trips).toEqual([]);
  });

  it('returns the journey in the Atlas trip model, not Entur GraphQL', async () => {
    const res = await plan({ from: asker, to: nationaltheatret });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      trips: { legs: { mode: string; line?: { publicCode: string; operator?: string } }[] }[];
    };
    expect(body.trips).toHaveLength(1);
    expect(body.trips[0]!.legs.map((l) => l.mode)).toEqual(['foot', 'rail']);
    expect(body.trips[0]!.legs[1]!.line).toMatchObject({ publicCode: 'R14', operator: 'Vy' });
  });

  it('sends the ET-Client-Name header Entur requires', async () => {
    await plan({ from: asker, to: nationaltheatret });
    expect(captured?.headers['ET-Client-Name']).toBe('atlas-journeyplanner');
    expect(captured?.url).toContain('journey-planner/v3/graphql');
  });

  it('forwards departure time, arriveBy and walk speed to the planner', async () => {
    const dateTimeMs = Date.UTC(2026, 6, 21, 5, 30);
    await plan({ from: asker, to: nationaltheatret, dateTimeMs, arriveBy: true, walkSpeedMps: 1 });
    expect(captured?.body.variables).toMatchObject({
      dateTime: '2026-07-21T05:30:00.000Z',
      arriveBy: true,
      walkSpeed: 1,
    });
  });

  it('forwards ordered via places as real timetable visits', async () => {
    await plan({
      from: { lat: 59.82, lng: 10.42 },
      via: [{ ...asker, stopId: 'NSR:StopPlace:59872' }],
      to: nationaltheatret,
    });
    expect(captured?.body.variables.via).toEqual([
      {
        visit: {
          stopLocationIds: ['NSR:StopPlace:59872'],
          minimumWaitTime: 'PT0S',
        },
      },
    ]);
  });

  it('forwards a mode selection, ignoring names it does not know', async () => {
    await plan({ from: asker, to: nationaltheatret, modes: ['bus', 'hovercraft', 'rail'] });
    expect(captured?.body.variables.modes).toMatchObject({
      // Bus brings coach: one control upstream, two modes on the wire.
      transportModes: [
        { transportMode: 'bus' },
        { transportMode: 'coach' },
        { transportMode: 'rail' },
      ],
    });
  });

  it('treats a selection of only unknown modes as no filter at all', async () => {
    // Dropping the filter beats 400ing a newer client, and beats a query that
    // can only ever answer "nothing runs".
    await plan({ from: asker, to: nationaltheatret, modes: ['hovercraft'] });
    expect(captured?.body.variables.modes).toBeNull();
  });

  it('passes an empty result through as a 200 — no service is an answer', async () => {
    respond = () =>
      new Response(JSON.stringify({ data: { trip: { tripPatterns: [] } } }), { status: 200 });
    const res = await plan({ from: asker, to: nationaltheatret });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ trips: [], problems: [] });
  });

  it('rejects a journey outside Norway without calling Entur', async () => {
    const res = await plan({ from: asker, to: { lat: 52.52, lng: 13.4 } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/within Norway/);
    expect(captured).toBeUndefined();
  });

  it('rejects malformed coordinates', async () => {
    expect((await plan({ from: asker })).statusCode).toBe(400);
    expect((await plan({ from: asker, to: { lat: 'x', lng: 3 } })).statusCode).toBe(400);
    expect((await plan({ from: asker, to: { lat: 91, lng: 3 } })).statusCode).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('502s when Entur errors or is unreachable', async () => {
    respond = () => new Response('rate limited', { status: 429 });
    expect((await plan({ from: asker, to: nationaltheatret })).statusCode).toBe(502);

    respond = () => {
      throw new Error('ECONNREFUSED');
    };
    const down = await plan({ from: asker, to: nationaltheatret });
    expect(down.statusCode).toBe(502);
    expect((down.json() as { error: string }).error).toBe('journey planner unavailable');
  });

  it('502s on a GraphQL-level error rather than returning a half-parsed trip', async () => {
    respond = () =>
      new Response(JSON.stringify({ errors: [{ message: 'Invalid coordinates' }] }), {
        status: 200,
      });
    expect((await plan({ from: asker, to: nationaltheatret })).statusCode).toBe(502);
  });
});

describe('GET /api/transit/stops', () => {
  const geocoderReply = {
    type: 'FeatureCollection',
    features: [
      {
        geometry: { type: 'Point', coordinates: [10.753051, 59.910357] },
        properties: {
          id: 'NSR:StopPlace:59872',
          name: 'Oslo S',
          label: 'Oslo S, Oslo',
          layer: 'venue',
          category: ['onstreetBus', 'railStation'],
          locality: 'Oslo',
        },
      },
    ],
  };

  it('searches Norwegian NSR stops with Entur identification and viewport bias', async () => {
    respond = () => new Response(JSON.stringify(geocoderReply), { status: 200 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/stops?q=Oslo%20S&limit=3&lat=59.91&lon=10.75',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        {
          name: 'Oslo S',
          label: 'Bus · Train · Oslo',
          position: { lat: 59.910357, lng: 10.753051 },
          kind: 'public_transport/onstreetBus',
          transitStopId: 'NSR:StopPlace:59872',
        },
      ],
    });
    const upstream = new URL(captured!.url);
    expect(upstream.pathname).toBe('/geocoder/v1/autocomplete');
    expect(Object.fromEntries(upstream.searchParams)).toMatchObject({
      text: 'Oslo S',
      lang: 'en',
      size: '3',
      layers: 'venue',
      'boundary.country': 'NOR',
      multiModal: 'parent',
      'focus.point.lat': '59.91',
      'focus.point.lon': '10.75',
    });
    expect(captured?.headers['ET-Client-Name']).toBe('atlas-journeyplanner');
  });

  it('rejects tiny queries without calling Entur', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/transit/stops?q=O' });
    expect(res.statusCode).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('reports an unavailable Entur geocoder without leaking its response', async () => {
    respond = () => new Response('rate limited', { status: 429 });
    const res = await app.inject({ method: 'GET', url: '/api/transit/stops?q=Oslo' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'public transport stop search unavailable' });
  });
});

describe('GET /api/transit/departures', () => {
  const departureReply = {
    data: {
      stopPlace: {
        id: 'NSR:StopPlace:59872',
        name: 'Asker stasjon',
        latitude: asker.lat,
        longitude: asker.lng,
        estimatedCalls: [
          {
            aimedDepartureTime: '2026-07-21T07:33:00+02:00',
            expectedDepartureTime: '2026-07-21T07:36:00+02:00',
            realtime: true,
            cancellation: false,
            forBoarding: true,
            destinationDisplay: { frontText: 'Kongsvinger' },
            quay: { id: 'NSR:Quay:700', publicCode: '2' },
            serviceJourney: {
              id: 'NSR:ServiceJourney:1',
              transportMode: 'rail',
              line: { publicCode: 'R14', name: 'Asker–Kongsvinger', operator: { name: 'Vy' } },
            },
            situations: [],
          },
        ],
      },
    },
  };

  it('returns a next-hour exact-stop board in the Atlas model', async () => {
    respond = () => new Response(JSON.stringify(departureReply), { status: 200 });
    const res = await app.inject({
      method: 'GET',
      url: `/api/transit/departures?lat=${asker.lat}&lon=${asker.lng}&stopId=NSR%3AStopPlace%3A59872`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      stop: { id: 'NSR:StopPlace:59872', name: 'Asker stasjon' },
      departures: [
        {
          mode: 'rail',
          destination: 'Kongsvinger',
          realtime: true,
          line: { publicCode: 'R14', operator: 'Vy' },
          quay: { publicCode: '2' },
        },
      ],
    });
    expect(captured?.body.variables.id).toBe('NSR:StopPlace:59872');
    expect(res.headers['cache-control']).toBe('private, max-age=15');
  });

  it('rejects malformed and non-Norwegian departure locations', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/api/transit/departures?lat=x&lon=10' })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/transit/departures?lat=52.52&lon=13.4',
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('POST /api/transit/commute', () => {
  const payload = {
    from: { name: 'Engelsrud', lat: 59.82, lng: 10.42 },
    via: [{ name: 'Asker', ...asker }],
    to: { name: 'Nationaltheatret', ...nationaltheatret },
    allowedBusLines: ['280', '71'],
    excludedRailStops: ['Hvalstad'],
  };

  it('returns matching journeys in both directions', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transit/commute', payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outbound.trips).toHaveLength(1);
    expect(body.inbound.trips).toHaveLength(1);
    expect(res.headers['cache-control']).toBe('private, max-age=30');
  });

  it('rejects a commute without an allowed bus line', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/transit/commute',
      payload: { ...payload, allowedBusLines: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * Measured against live Entur: Engelsrud → Nationaltheatret asked at 22:30
   * answers `noTransitConnectionInSearchWindow`, and asked between the 280s
   * answers with services this commute excludes. Both must widen — a board
   * checked the night before has to show tomorrow's 03:20, not "nothing
   * matches your rules". So the retry is keyed on the filtered list, unlike
   * `/api/transit`, which only ever sees an empty planner answer.
   */
  it('widens the window when the filter, not the planner, emptied the board', async () => {
    // The narrow window offers only a bus this commute excludes.
    const wrongBus = structuredClone(enturReply);
    wrongBus.data.trip.tripPatterns[0]!.legs[1] = {
      ...wrongBus.data.trip.tripPatterns[0]!.legs[1]!,
      mode: 'bus',
      line: { publicCode: '999', name: 'Not this commute' },
    };
    const windows: unknown[] = [];
    respond = () => {
      const window = captured!.body.variables.searchWindow;
      windows.push(window);
      return new Response(JSON.stringify(window === null ? wrongBus : enturReply), { status: 200 });
    };

    const res = await app.inject({ method: 'POST', url: '/api/transit/commute', payload });

    expect(res.statusCode).toBe(200);
    // Two directions, each asked at the default window and then one step wider —
    // the 6 h step matches, so neither direction pays for a full day.
    expect(windows.filter((value) => value === null)).toHaveLength(2);
    expect(windows.filter((value) => value === 6 * 60)).toHaveLength(2);
    expect(windows).not.toContain(24 * 60);
    expect(res.json().outbound.trips).toHaveLength(1);
    expect(res.json().inbound.trips).toHaveLength(1);
  });

  it('leaves a board that already matched alone', async () => {
    let calls = 0;
    respond = () => {
      calls += 1;
      return new Response(JSON.stringify(enturReply), { status: 200 });
    };

    await app.inject({ method: 'POST', url: '/api/transit/commute', payload });

    // One question per direction: a wide window costs the planner real work.
    expect(calls).toBe(2);
  });
});
