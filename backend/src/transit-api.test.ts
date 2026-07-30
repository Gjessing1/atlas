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
    from: { name: 'Engelsrud', lat: 59.82, lng: 10.42, stopId: 'NSR:StopPlace:3369' },
    via: [{ name: 'Asker stasjon', ...asker, stopId: 'NSR:StopPlace:59616' }],
    to: { name: 'Nationaltheatret', ...nationaltheatret, stopId: 'NSR:StopPlace:58404' },
    filter: {
      select: [{ id: 'VYG:Line:R14', publicCode: 'R14', mode: 'rail' }],
      exclude: [{ id: 'VYG:Line:L1', publicCode: 'L1', mode: 'rail' }],
      modes: [],
    },
    outboundTime: { minutesOfDay: null, arriveBy: false },
    inboundTime: { minutesOfDay: null, arriveBy: false },
    days: [],
  };

  it('returns journeys in both directions', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/transit/commute', payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outbound.trips).toHaveLength(1);
    expect(body.inbound.trips).toHaveLength(1);
    expect(res.headers['cache-control']).toBe('private, max-age=30');
  });

  /**
   * The rework's whole point: the lines go *into* the question. The previous
   * board asked unfiltered, discarded most of the answer locally, then re-asked
   * at 6 h and 24 h windows — up to three upstream calls per direction, six per
   * widget refresh.
   */
  it('asks Entur for the chosen lines rather than filtering the answer', async () => {
    const filters: unknown[] = [];
    respond = () => {
      filters.push(captured!.body.variables.filters);
      return new Response(JSON.stringify(enturReply), { status: 200 });
    };
    await app.inject({ method: 'POST', url: '/api/transit/commute', payload });
    expect(filters).toHaveLength(2);
    expect(filters[0]).toEqual([
      { select: [{ lines: ['VYG:Line:R14'] }], not: [{ lines: ['VYG:Line:L1'] }] },
    ]);
  });

  /**
   * `filters: []` is not "no filter" upstream — it reads as "match none of
   * these" and answers `noTransitConnection` on a corridor with five journeys.
   * A commute with nothing ticked yet is the *default*, so getting this wrong
   * would make a fresh board report the route as unserved.
   */
  it('sends no filter at all for a commute with no lines chosen', async () => {
    const filters: unknown[] = [];
    respond = () => {
      filters.push(captured!.body.variables.filters);
      return new Response(JSON.stringify(enturReply), { status: 200 });
    };
    await app.inject({
      method: 'POST',
      url: '/api/transit/commute',
      payload: { ...payload, filter: { select: [], exclude: [], modes: [] } },
    });
    expect(filters).toEqual([null, null]);
  });

  it('accepts a commute with no lines chosen — it is the honest first run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/transit/commute',
      payload: { ...payload, filter: { select: [], exclude: [], modes: [] } },
    });
    expect(res.statusCode).toBe(200);
  });

  it('bans no ride mode by default, so a metro leg is not secretly disqualified', async () => {
    const modes: unknown[] = [];
    respond = () => {
      modes.push(captured!.body.variables.modes);
      return new Response(JSON.stringify(enturReply), { status: 200 });
    };
    await app.inject({ method: 'POST', url: '/api/transit/commute', payload });
    expect(modes).toEqual([null, null]);
  });

  it('drops a line reference that could never be filtered on', async () => {
    const filters: unknown[] = [];
    respond = () => {
      filters.push(captured!.body.variables.filters);
      return new Response(JSON.stringify(enturReply), { status: 200 });
    };
    await app.inject({
      method: 'POST',
      url: '/api/transit/commute',
      payload: {
        ...payload,
        filter: {
          select: [{ publicCode: '280', mode: 'bus' }, { id: 'nonsense' }],
          exclude: [],
          modes: [],
        },
      },
    });
    expect(filters).toEqual([null, null]);
  });

  /**
   * A commute defined by a time of day answers about *that* time. The old board
   * reached tomorrow morning by widening a search window until something fell
   * out; asking about tomorrow's 07:10 is one call.
   */
  it('asks about the commute’s own time, and then never widens the window', async () => {
    const asked: { dateTime: unknown; window: unknown }[] = [];
    respond = () => {
      asked.push({
        dateTime: captured!.body.variables.dateTime,
        window: captured!.body.variables.searchWindow,
      });
      // Nothing matches — the old code would have escalated to 6 h and 24 h.
      return new Response(JSON.stringify({ data: { trip: { tripPatterns: [] } } }), {
        status: 200,
      });
    };
    await app.inject({
      method: 'POST',
      url: '/api/transit/commute',
      payload: { ...payload, outboundTime: { minutesOfDay: 430, arriveBy: false } },
    });
    const outbound = asked.filter((call) => call.dateTime !== null);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.window).toBeNull();
  });

  /**
   * The retry survives only for "leave now": on a sparse route the next
   * departure genuinely can be tomorrow morning, and Entur's default look-ahead
   * reports nothing. Measured: Å i Lofoten → Svolvær at 23:30.
   */
  it('still widens the window for a commute with no time of day', async () => {
    const windows: unknown[] = [];
    respond = () => {
      const window = captured!.body.variables.searchWindow;
      windows.push(window);
      return new Response(
        JSON.stringify(window === null ? { data: { trip: { tripPatterns: [] } } } : enturReply),
        { status: 200 },
      );
    };
    const res = await app.inject({ method: 'POST', url: '/api/transit/commute', payload });
    expect(res.statusCode).toBe(200);
    expect(windows.filter((value) => value === null)).toHaveLength(2);
    expect(windows.filter((value) => value === 6 * 60)).toHaveLength(2);
    expect(windows).not.toContain(24 * 60);
  });

  it('leaves a board that already answered alone', async () => {
    let calls = 0;
    respond = () => {
      calls += 1;
      return new Response(JSON.stringify(enturReply), { status: 200 });
    };
    await app.inject({ method: 'POST', url: '/api/transit/commute', payload });
    // One question per direction, where the old board made up to three.
    expect(calls).toBe(2);
  });

  /**
   * "Nothing runs" and "your lines removed everything" call for opposite
   * reactions, and the previous board rendered both as one sentence about
   * "these exact line and stop rules".
   */
  it('says which nothing an empty direction was', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          data: { trip: { tripPatterns: [], routingErrors: [{ code: 'noTransitConnection' }] } },
        }),
        { status: 200 },
      );
    const res = await app.inject({ method: 'POST', url: '/api/transit/commute', payload });
    expect(res.json().emptyReason).toEqual({ outbound: 'filtered', inbound: 'filtered' });

    respond = () =>
      new Response(
        JSON.stringify({
          data: { trip: { tripPatterns: [], routingErrors: [{ code: 'noTransitConnection' }] } },
        }),
        { status: 200 },
      );
    const unfiltered = await app.inject({
      method: 'POST',
      url: '/api/transit/commute',
      payload: { ...payload, filter: { select: [], exclude: [], modes: [] } },
    });
    expect(unfiltered.json().emptyReason.outbound).toBe('upstream');
  });

  it('refuses a commute outside Norway, and one with no ends', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transit/commute',
          payload: { ...payload, to: { name: 'Berlin', lat: 52.5, lng: 13.4 } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/transit/commute', payload: {} })).statusCode,
    ).toBe(400);
  });
});

describe('GET /api/transit/stop-lines', () => {
  const stopLinesReply = {
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
                authority: { name: 'Ruter' },
              },
            ],
          },
          {
            // The same line under the other stand — deduped, or the picker shows
            // every line once per platform.
            lines: [{ id: 'RUT:Line:280', publicCode: '280', transportMode: 'bus' }],
          },
        ],
      },
    },
  };

  it('lists the lines calling at a stop, cacheable for hours', async () => {
    respond = () => new Response(JSON.stringify(stopLinesReply), { status: 200 });
    const res = await app.inject({
      method: 'GET',
      url: '/api/transit/stop-lines?stopId=NSR:StopPlace:3369',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines).toEqual([
      {
        id: 'RUT:Line:280',
        publicCode: '280',
        mode: 'bus',
        name: 'Asker - Dikemark - Heggedal',
        operator: 'Ruter',
      },
    ]);
    // A stop's line set changes with the timetable, not the minute.
    expect(res.headers['cache-control']).toBe('private, max-age=21600');
  });

  it('rejects anything that is not an NSR stop id', async () => {
    for (const stopId of ['', 'nonsense', 'NSR:Quay:5964']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/transit/stop-lines?stopId=${encodeURIComponent(stopId)}`,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('POST /api/transit/widget', () => {
  const commute = {
    from: { name: 'Engelsrud', lat: 59.82, lng: 10.42, stopId: 'NSR:StopPlace:3369' },
    via: [],
    to: { name: 'Nationaltheatret', ...nationaltheatret, stopId: 'NSR:StopPlace:58404' },
    filter: { select: [], exclude: [], modes: [] },
    outboundTime: { minutesOfDay: null, arriveBy: false },
    inboundTime: { minutesOfDay: null, arriveBy: false },
    days: [],
  };

  /**
   * The rows are rendered here so Kotlin formats nothing — deleting the widget's
   * own `SimpleDateFormat` copy of `tripSummary` is the point of the route.
   */
  it('renders rows the widget only has to paint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/transit/widget',
      payload: { kind: 'commute', commute, direction: 'outbound' },
    });
    expect(res.statusCode).toBe(200);
    const board = res.json();
    expect(board.route).toBe('Engelsrud ↔ Nationaltheatret');
    expect(board.directions).toHaveLength(1);
    expect(board.directions[0].label).toBe('Engelsrud → Nationaltheatret');
    // Norwegian wall-clock time, not the container's UTC: the fixture's train
    // leaves 07:33+02:00, and a UTC clock would render 05:33.
    expect(board.directions[0].rows[0].text).toMatch(/^07:33 · /);
    expect(board.directions[0].rows[0].text).toContain('R14');
    expect(board.status).toContain('Entur live');
    expect(board.nextRefreshMs).toBeGreaterThan(Date.now());
  });

  it('asks one direction only when the widget shows one', async () => {
    let calls = 0;
    respond = () => {
      calls += 1;
      return new Response(JSON.stringify(enturReply), { status: 200 });
    };
    await app.inject({
      method: 'POST',
      url: '/api/transit/widget',
      payload: { kind: 'commute', commute, direction: 'inbound' },
    });
    expect(calls).toBe(1);
  });

  it('answers both directions when asked for both', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/transit/widget',
      payload: { kind: 'commute', commute, direction: 'both' },
    });
    expect(res.json().directions.map((d: { key: string }) => d.key)).toEqual([
      'outbound',
      'inbound',
    ]);
  });

  it('defaults to whichever direction is next', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/transit/widget',
      payload: { kind: 'commute', commute },
    });
    expect(res.json().directions).toHaveLength(1);
  });

  /**
   * The cheaper sibling: "when is my next 280" is one line-filtered
   * `estimatedCalls` call, where a trip board costs two to six `trip` calls.
   * Each row states its direction because one line at one stop runs both ways.
   */
  it('answers a one-stop board from a single departures call', async () => {
    const departures = {
      data: {
        stopPlace: {
          id: 'NSR:StopPlace:3369',
          name: 'Engelsrud',
          latitude: 59.82,
          longitude: 10.36,
          estimatedCalls: [
            {
              aimedDepartureTime: '2026-07-21T07:22:00+02:00',
              expectedDepartureTime: '2026-07-21T07:22:00+02:00',
              realtime: true,
              cancellation: false,
              forBoarding: true,
              destinationDisplay: { frontText: 'Dikemark' },
              quay: { id: 'NSR:Quay:5964', publicCode: '1' },
              serviceJourney: {
                id: 'RUT:ServiceJourney:1',
                transportMode: 'bus',
                line: { id: 'RUT:Line:280', publicCode: '280' },
              },
            },
          ],
        },
      },
    };
    let calls = 0;
    respond = () => {
      calls += 1;
      return new Response(JSON.stringify(departures), { status: 200 });
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/transit/widget',
      payload: {
        kind: 'stop',
        stop: { lat: 59.82, lng: 10.36, stopId: 'NSR:StopPlace:3369' },
        lines: ['RUT:Line:280'],
      },
    });
    expect(calls).toBe(1);
    expect(captured!.body.variables.lines).toEqual({ lines: ['RUT:Line:280'] });
    const board = res.json();
    expect(board.route).toBe('Engelsrud');
    // The clock and the direction are fixed by the fixture; the countdown is
    // relative to now, so it is not asserted against a recorded departure time.
    expect(board.directions[0].rows[0].text).toMatch(/^07:22 · .* · 280 → Dikemark · plt 1$/);
  });

  it('refuses a stop board outside Norway and a commute it cannot read', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transit/widget',
          payload: { kind: 'stop', stop: { lat: 52.5, lng: 13.4 } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/transit/widget',
          payload: { kind: 'commute', commute: {} },
        })
      ).statusCode,
    ).toBe(400);
  });
});
