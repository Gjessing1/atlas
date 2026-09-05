import { mkdtemp, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerSatellitesApi, satellitesLayerMeta, starlinkLayerMeta } from './satellites-api.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');

const omm = (noradId: number, name: string, extra: Record<string, unknown> = {}) => ({
  OBJECT_NAME: name,
  OBJECT_ID: '1998-067A',
  EPOCH: '2026-09-05T11:57:50.773248',
  MEAN_MOTION: 15.48996812,
  ECCENTRICITY: 0.00050573,
  INCLINATION: 51.631,
  RA_OF_ASC_NODE: 262.6049,
  ARG_OF_PERICENTER: 109.4187,
  MEAN_ANOMALY: 250.7348,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: noradId,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 58420,
  BSTAR: 0.000081465205,
  MEAN_MOTION_DOT: 0.0000404,
  MEAN_MOTION_DDOT: 0,
  ...extra,
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A fetch stub that answers each CelesTrak group from a fixture. */
function stubFetch(groups: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const group = url.searchParams.get('GROUP') ?? '';
    const body = groups[group];
    if (body === undefined) return new Response('not found', { status: 404 });
    return ok(body);
  }) as unknown as typeof fetch;
}

async function buildTestApp(opts: {
  fetchImpl?: typeof fetch;
  dataDir?: string;
  now?: () => number;
}) {
  const app = Fastify();
  registerSatellitesApi(app, { now: () => NOW, ...opts });
  await app.ready();
  return app;
}

describe('satellite layer catalog rows', () => {
  it('offers stations+visual and Starlink as separate Curiosities rows', () => {
    const satellites = satellitesLayerMeta();
    const starlink = starlinkLayerMeta();
    expect(satellites.id).toBe('satellites');
    expect(starlink.id).toBe('starlink');
    // Separate ids mean separate toggles: the thousands of Starlink objects
    // never crowd the map unless the user asks for them.
    expect(satellites.id).not.toBe(starlink.id);
    for (const meta of [satellites, starlink]) {
      expect(meta.vector).toBe(true);
      expect(meta.profiles).toContain('curiosities');
      expect(meta.attribution).toMatch(/CelesTrak/);
    }
  });

  it('warns that the ISS does not clear the horizon in the north', () => {
    // The single most surprising fact about this layer in Norway, so it is a
    // coverage note rather than folklore.
    expect(satellitesLayerMeta().coverageNote).toMatch(/62°N/);
  });
});

describe('GET /api/overlay/:id/elements', () => {
  it('merges the groups a layer is built from, de-duplicated', async () => {
    const fetchImpl = stubFetch({
      stations: [omm(25544, 'ISS (ZARYA)'), omm(48274, 'CSS (TIANHE)')],
      // The ISS is in both groups upstream; one dot, one pass list.
      visual: [omm(25544, 'ISS (ZARYA)'), omm(694, 'ATLAS CENTAUR 2')],
    });
    const app = await buildTestApp({ fetchImpl });
    const res = await app.inject({ url: '/api/overlay/satellites/elements' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toEqual(['stations', 'visual']);
    expect(body.satellites.map((s: { NORAD_CAT_ID: number }) => s.NORAD_CAT_ID)).toEqual([
      25544, 48274, 694,
    ]);
    expect(body.fetchedAt).toBe(new Date(NOW).toISOString());
    await app.close();
  });

  it('serves Starlink from its own group', async () => {
    const fetchImpl = stubFetch({ starlink: [omm(44713, 'STARLINK-1007')] });
    const app = await buildTestApp({ fetchImpl });
    const body = (await app.inject({ url: '/api/overlay/starlink/elements' })).json();
    expect(body.groups).toEqual(['starlink']);
    expect(body.satellites).toHaveLength(1);
    await app.close();
  });

  it('asks CelesTrak once per two-hour cycle, however many clients ask', async () => {
    const fetchImpl = stubFetch({ stations: [omm(25544, 'ISS (ZARYA)')], visual: [] });
    let clock = NOW;
    const app = await buildTestApp({ fetchImpl, now: () => clock });

    await app.inject({ url: '/api/overlay/satellites/elements' });
    await app.inject({ url: '/api/overlay/satellites/elements' });
    await app.inject({ url: '/api/overlay/satellites/elements' });
    // Two groups, one cycle — three client requests must not become six.
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock += 2 * 60 * 60_000 + 1000;
    await app.inject({ url: '/api/overlay/satellites/elements' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await app.close();
  });

  it('coalesces simultaneous cold requests into one upstream fetch', async () => {
    const fetchImpl = stubFetch({ stations: [omm(25544, 'ISS (ZARYA)')], visual: [] });
    const app = await buildTestApp({ fetchImpl });
    await Promise.all(
      Array.from({ length: 5 }, () => app.inject({ url: '/api/overlay/satellites/elements' })),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('keeps flying on the last good set when upstream fails', async () => {
    let fail = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (fail) return new Response('rate limited', { status: 429 });
      const group = new URL(String(input)).searchParams.get('GROUP');
      return ok(group === 'stations' ? [omm(25544, 'ISS (ZARYA)')] : []);
    }) as unknown as typeof fetch;

    let clock = NOW;
    const app = await buildTestApp({ fetchImpl, now: () => clock });
    await app.inject({ url: '/api/overlay/satellites/elements' });

    // A 429 is exactly the response CelesTrak's policy says to stop on. The
    // route must not retry into it, and must not go blank either: elements
    // hours old still put a satellite within a kilometre of where it is.
    fail = true;
    clock += 2 * 60 * 60_000 + 1000;
    const res = await app.inject({ url: '/api/overlay/satellites/elements' });
    expect(res.statusCode).toBe(200);
    expect(res.json().satellites).toHaveLength(1);
    expect(res.json().fetchedAt).toBe(new Date(NOW).toISOString());
    await app.close();
  });

  it('answers 502 when it has never had a set at all', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;
    const app = await buildTestApp({ fetchImpl });
    const res = await app.inject({ url: '/api/overlay/satellites/elements' });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('treats an upstream that answers with junk as a failure', async () => {
    const fetchImpl = stubFetch({ stations: { error: 'nope' }, visual: { error: 'nope' } });
    const app = await buildTestApp({ fetchImpl });
    expect((await app.inject({ url: '/api/overlay/satellites/elements' })).statusCode).toBe(502);
    await app.close();
  });

  it('rejects a layer id it does not serve', async () => {
    const app = await buildTestApp({ fetchImpl: stubFetch({}) });
    const res = await app.inject({ url: '/api/overlay/ice-observations/elements' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('survives a restart without spending an upstream fetch', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-sat-'));
    const fetchImpl = stubFetch({ stations: [omm(25544, 'ISS (ZARYA)')], visual: [] });

    const first = await buildTestApp({ fetchImpl, dataDir });
    await first.inject({ url: '/api/overlay/satellites/elements' });
    await first.close();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const persisted = JSON.parse(
      await readFile(path.join(dataDir, 'satellites', 'satellites.json'), 'utf8'),
    );
    expect(persisted.satellites).toHaveLength(1);

    // A restart inside the cycle must serve from disk. Otherwise a crash-loop
    // turns into a request flood at the one upstream that firewalls for it.
    const second = await buildTestApp({ fetchImpl, dataDir });
    const res = await second.inject({ url: '/api/overlay/satellites/elements' });
    expect(res.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await second.close();
  });

  it('serves the payload gzipped to clients that take it, plain to those that do not', async () => {
    const fetchImpl = stubFetch({ stations: [omm(25544, 'ISS (ZARYA)')], visual: [] });
    const app = await buildTestApp({ fetchImpl });

    const compressed = await app.inject({
      url: '/api/overlay/satellites/elements',
      headers: { 'accept-encoding': 'gzip, deflate' },
    });
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(compressed.headers.vary).toBe('accept-encoding');
    expect(gunzipSync(compressed.rawPayload).toString('utf8')).toContain('ISS (ZARYA)');

    const plain = await app.inject({ url: '/api/overlay/satellites/elements' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.json().satellites).toHaveLength(1);
    await app.close();
  });

  it('caps cache lifetime at what is left of the upstream cycle', async () => {
    const fetchImpl = stubFetch({ stations: [omm(25544, 'ISS (ZARYA)')], visual: [] });
    let clock = NOW;
    const app = await buildTestApp({ fetchImpl, now: () => clock });
    await app.inject({ url: '/api/overlay/satellites/elements' });
    clock += 90 * 60_000;
    const res = await app.inject({ url: '/api/overlay/satellites/elements' });
    // 30 minutes of the two-hour cycle left.
    expect(res.headers['cache-control']).toContain('max-age=1800');
    await app.close();
  });
});
