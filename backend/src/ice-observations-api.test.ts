import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  iceObservationFeature,
  iceObservationLayerMeta,
  registerIceObservationsApi,
} from './ice-observations-api.js';
import { registerOverlayApi } from './overlay/index.js';

const NOW = Date.parse('2026-01-20T12:00:00Z');

describe('ice observation conversion', () => {
  it('uses distinct report kinds while the colour follows observation age', () => {
    expect(
      iceObservationFeature(
        {
          RegId: 10,
          DtObsTime: '2026-01-19T08:30:00+01:00',
          ObsLocation: { Latitude: 60.1, Longitude: 10.2 },
          IceCoverObs: { IceCoverTID: 1, IceCoverName: 'Ice free', Comment: 'Open by outlet' },
          Observer: { NickName: 'Kari' },
        },
        NOW,
      ),
    ).toMatchObject({
      geometry: { coordinates: [10.2, 60.1] },
      properties: {
        kind: 'open-water',
        label: 'Open water',
        symbol: '≈',
        age: 'fresh',
        markerColor: '#16a34a',
        observer: 'Kari',
        summary: 'Ice free · Open by outlet',
      },
    });

    expect(
      iceObservationFeature(
        {
          RegId: 11,
          DtObsTime: '2025-12-15T12:00:00Z',
          ObsLocation: { Latitude: 60, Longitude: 10 },
          IceCoverObs: { IceCoverTID: 2 },
          DangerObs: [{ DangerSignName: 'Unsafe ice' }],
        },
        NOW,
      )?.properties,
    ).toMatchObject({
      kind: 'danger',
      label: 'Ice hazard',
      symbol: '!',
      age: 'stale',
      markerColor: '#dc2626',
    });
  });

  it('drops records without valid identity, time or point geometry', () => {
    expect(
      iceObservationFeature(
        { RegId: 1, DtObsTime: 'bad', ObsLocation: { Latitude: 60, Longitude: 10 } },
        NOW,
      ),
    ).toBeNull();
    expect(
      iceObservationFeature({ RegId: 1, DtObsTime: new Date(NOW).toISOString() }, NOW),
    ).toBeNull();
  });
});

describe('Regobs ice observations route', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('queries the same public rolling source as Iskart, deduplicates and caches the viewport', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        LangKey: 2,
        SelectedGeoHazards: [70],
        NumberOfRecords: 500,
        Offset: 0,
        Extent: {
          TopLeft: { Latitude: 61, Longitude: 9 },
          BottomRight: { Latitude: 59, Longitude: 12 },
        },
      });
      return new Response(
        JSON.stringify([
          {
            RegId: 42,
            DtObsTime: '2026-01-19T10:15:00+01:00',
            ObsLocation: { Latitude: 60, Longitude: 10 },
            IceThickness: { IceThicknessSum: 0.18 },
          },
          // A duplicate record across an upstream page must not draw twice.
          {
            RegId: 42,
            DtObsTime: '2026-01-19T10:15:00+01:00',
            ObsLocation: { Latitude: 60, Longitude: 10 },
          },
        ]),
        { status: 200 },
      );
    });
    const app = Fastify();
    apps.push(app);
    // The production order registers the generic `:id/features` overlay route
    // first. A static route must still win for this rolling vector source.
    registerOverlayApi(app, {
      cacheDir: '/tmp/atlas-ice-observations-test',
      layers: [],
      extraMeta: [iceObservationLayerMeta()],
    });
    registerIceObservationsApi(app, { fetchImpl: fetchImpl as typeof fetch, now: () => NOW });

    const catalog = await app.inject({ method: 'GET', url: '/api/layers' });
    expect(catalog.json().layers).toContainEqual(iceObservationLayerMeta());

    const first = await app.inject({
      method: 'GET',
      url: '/api/overlay/ice-observations/features?bbox=9,59,12,61',
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toContain('max-age=300');
    expect(first.json().features).toHaveLength(1);
    expect(first.json().features[0].properties).toMatchObject({
      regId: 42,
      kind: 'ice',
      observedAt: '2026-01-19T10:15:00+01:00',
      summary: '18 cm total ice',
    });

    const second = await app.inject({
      method: 'GET',
      url: '/api/overlay/ice-observations/features?bbox=9,59,12,61',
    });
    expect(second.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unbounded queries and maps an unavailable upstream to 502', async () => {
    const app = Fastify();
    apps.push(app);
    registerIceObservationsApi(app, {
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }) as typeof fetch,
      now: () => NOW,
    });

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/overlay/ice-observations/features?bbox=-180,-80,180,80',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/overlay/ice-observations/features?bbox=9,59,12,61',
        })
      ).statusCode,
    ).toBe(502);
  });
});

describe('ice observation catalog row', () => {
  it('states the 90-day age legend and never claims blank water is safe', () => {
    const meta = iceObservationLayerMeta();
    expect(meta.id).toBe('ice-observations');
    expect(meta.vector).toBe(true);
    expect(meta.profiles).toEqual(['fishing', 'hunting', 'ski']);
    expect(meta.coverageNote).toContain('green 0–2 days');
    expect(meta.coverageNote).toContain('never safe ice');
  });
});
