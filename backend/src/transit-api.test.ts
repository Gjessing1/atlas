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
        body: JSON.parse(String(init.body)),
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
  it('asks again with a full-day window when the planner returned nothing', async () => {
    // Measured against live Entur: Å i Lofoten → Svolvær at 23:30 comes back
    // empty although a 04:24 bus exists, because Entur's own look-ahead is a
    // dynamic few hours. An empty answer is therefore not believed first time.
    let calls = 0;
    respond = () => {
      calls += 1;
      const body = calls === 1 ? { data: { trip: { tripPatterns: [] } } } : enturReply;
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const res = await plan({ from: asker, to: nationaltheatret });

    expect(calls).toBe(2);
    expect(captured!.body.variables.searchWindow).toBe(24 * 60);
    expect(res.json().trips).toHaveLength(1);
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
