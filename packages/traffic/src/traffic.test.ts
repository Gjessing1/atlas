import type { RouteProvider, RouteQuery, RouteResult } from '@atlas/routing';
import { describe, expect, it, vi } from 'vitest';

import { parseDatexSnapshot } from './datex.js';
import { closuresNearRoute } from './model.js';
import { httpTrafficClosures, trafficAwareRouteProvider } from './routing.js';

const publication = (records: string) => `
<messageContainer xmlns="http://datex2.eu/schema/3/common"
 xmlns:mc="http://datex2.eu/schema/3/messageContainer"
 xmlns:sit="http://datex2.eu/schema/3/situation"
 xmlns:loc="http://datex2.eu/schema/3/locationReferencing"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <mc:payload xsi:type="sit:SituationPublication" lang="no">
  <publicationTime>2026-07-31T10:00:00+02:00</publicationTime>${records}
 </mc:payload>
</messageContainer>`;

const situation = (id: string, start: string, end: string, management: string) => `
<sit:situation id="${id}"><sit:overallSeverity>high</sit:overallSeverity>
 <sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="${id}-r">
  <sit:severity>high</sit:severity>
  <sit:validity><validityStatus>definedByValidityTimeSpec</validityStatus>
   <validityTimeSpecification><overallStartTime>${start}</overallStartTime>
    <overallEndTime>${end}</overallEndTime></validityTimeSpecification>
  </sit:validity>
  <sit:generalPublicComment><sit:comment><values><value lang="no">Vegen er stengt.</value></values></sit:comment></sit:generalPublicComment>
  <sit:locationReference xsi:type="loc:LocationGroupByList"><loc:locationContainedInGroup>
   <loc:coordinatesForDisplay><loc:latitude>59.9</loc:latitude><loc:longitude>10.7</loc:longitude></loc:coordinatesForDisplay>
   <loc:supplementaryPositionalDescription><loc:locationDescription><values><value lang="no">E18 ved Oslo</value></values></loc:locationDescription>
    <loc:roadInformation><loc:roadNumber>E18</loc:roadNumber></loc:roadInformation>
   </loc:supplementaryPositionalDescription>
   <loc:gmlLineString srsName="25833"><loc:posList>259544.806 6648086.268 259617.153 6649198.368</loc:posList></loc:gmlLineString>
  </loc:locationContainedInGroup></sit:locationReference>
  <sit:roadOrCarriagewayOrLaneManagementType>${management}</sit:roadOrCarriagewayOrLaneManagementType>
 </sit:situationRecord></sit:situation>`;

describe('DATEX II traffic', () => {
  it('sends dense route geometry as a precision-6 polyline', async () => {
    const route = Array.from({ length: 1_000 }, (_, index) => ({
      lat: 59.9 + index * 0.00004,
      lng: 10.7,
    }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { shape?: string; points?: unknown };
      expect(body.shape).toEqual(expect.any(String));
      expect(body.points).toBeUndefined();
      expect(String(init?.body).length).toBeLessThan(JSON.stringify({ points: route }).length / 4);
      return new Response(JSON.stringify({ closures: [] }), { status: 200 });
    }) as typeof fetch;
    await httpTrafficClosures('', fetchImpl)(route);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps only active records and extracts Norwegian closure data', () => {
    const snapshot = parseDatexSnapshot(
      publication(
        situation(
          'active',
          '2026-07-31T08:00:00+02:00',
          '2026-07-31T18:00:00+02:00',
          'roadClosed',
        ) +
          situation(
            'future',
            '2026-08-01T08:00:00+02:00',
            '2026-08-01T18:00:00+02:00',
            'roadClosed',
          ),
      ),
      new Date('2026-07-31T10:00:00+02:00'),
    );
    expect(snapshot.publishedAt).toBe('2026-07-31T10:00:00+02:00');
    expect(snapshot.situations).toHaveLength(1);
    expect(snapshot.situations[0]).toMatchObject({
      id: 'active',
      kind: 'closure',
      message: 'Vegen er stengt.',
      location: 'E18 ved Oslo',
      position: { lat: 59.9, lng: 10.7 },
    });
    expect(snapshot.closures).toHaveLength(1);
    expect(snapshot.closures[0]).toMatchObject({
      roadNumber: 'E18',
      roadGeometry: [
        { lat: expect.closeTo(59.9, 5), lng: expect.closeTo(10.7, 5) },
        { lat: expect.closeTo(59.91, 5), lng: expect.closeTo(10.7, 5) },
      ],
    });
  });

  it('falls back to the display point when a closure has no road geometry', () => {
    const route = [
      { lat: 59.9, lng: 10.7 },
      { lat: 59.91, lng: 10.7 },
    ];
    expect(
      closuresNearRoute(
        [
          { id: 'on', position: { lat: 59.905, lng: 10.7002 }, message: 'on' },
          { id: 'off', position: { lat: 59.905, lng: 10.71 }, message: 'off' },
        ],
        route,
      ).map((closure) => closure.id),
    ).toEqual(['on']);
  });

  it('matches the affected road stretch and rejects nearby or crossing roads', () => {
    const route = [
      { lat: 59.9, lng: 10.7 },
      { lat: 59.91, lng: 10.7 },
    ];
    const closures = closuresNearRoute(
      [
        {
          id: 'same-road',
          // The old display-point matcher misses this long closure entirely.
          position: { lat: 59.9, lng: 10.702 },
          message: 'same',
          roadGeometry: [
            { lat: 59.904, lng: 10.7 },
            { lat: 59.906, lng: 10.7 },
          ],
        },
        {
          id: 'parallel-road',
          // Display point is close enough for the old 75 m matcher; the
          // official line is the adjacent/opposite carriageway.
          position: { lat: 59.905, lng: 10.7001 },
          message: 'parallel',
          roadGeometry: [
            { lat: 59.904, lng: 10.7003 },
            { lat: 59.906, lng: 10.7003 },
          ],
        },
        {
          id: 'crossing-road',
          position: { lat: 59.905, lng: 10.7 },
          message: 'crossing',
          roadGeometry: [
            { lat: 59.905, lng: 10.699 },
            { lat: 59.905, lng: 10.701 },
          ],
        },
      ],
      route,
    );
    expect(closures.map((closure) => closure.id)).toEqual(['same-road']);
    expect(closures[0]?.position.lng).toBeCloseTo(10.7, 5);
    expect(closures[0]?.roadGeometry).toBeUndefined();
  });

  it('reruns a car route with matching closure points but leaves walking alone', async () => {
    const path = {
      points: [
        { lat: 59.9, lng: 10.7 },
        { lat: 59.91, lng: 10.7 },
      ],
      distanceM: 1000,
      timeMs: 60_000,
      ascentM: 0,
      descentM: 0,
    };
    const route = vi.fn(
      async (_query: RouteQuery, _signal?: AbortSignal): Promise<RouteResult> => ({
        paths: [path],
      }),
    );
    const provider: RouteProvider = { route };
    const closure = { id: 'c', position: { lat: 59.905, lng: 10.7 }, message: 'stengt' };
    const aware = trafficAwareRouteProvider(provider, async () => [closure]);
    await aware.route({ profile: 'car', points: path.points });
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls[1]?.[0].excludeLocations).toEqual([closure.position]);
    route.mockClear();
    await aware.route({ profile: 'foot', points: path.points });
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('checks road weather for every offered route', async () => {
    const path = {
      points: [
        { lat: 59.9, lng: 10.7 },
        { lat: 59.91, lng: 10.7 },
      ],
      distanceM: 1000,
      timeMs: 600_000,
      ascentM: 0,
      descentM: 0,
    };
    const weather = vi.fn(async () => ({
      checkedAt: '2026-01-02T08:00:00Z',
      matchedSites: 1,
      warnings: [],
    }));
    const aware = trafficAwareRouteProvider(
      { route: async () => ({ paths: [path] }) },
      async () => [],
      weather,
    );
    const result = await aware.route({ profile: 'car', points: path.points });
    expect(weather).toHaveBeenCalledWith(path.points, path.timeMs, undefined);
    expect(result.paths[0]?.roadWeather).toMatchObject({ matchedSites: 1 });
    expect(result.paths[0]?.timeMs).toBe(600_000);
  });

  it('keeps the route standing when the road-weather feed fails', async () => {
    const path = {
      points: [
        { lat: 59.9, lng: 10.7 },
        { lat: 59.91, lng: 10.7 },
      ],
      distanceM: 1000,
      timeMs: 60_000,
      ascentM: 0,
      descentM: 0,
    };
    const provider: RouteProvider = {
      route: async (): Promise<RouteResult> => ({ paths: [path] }),
    };
    const aware = trafficAwareRouteProvider(
      provider,
      async () => [],
      async () => {
        throw new Error('offline');
      },
    );
    const result = await aware.route({ profile: 'car', points: path.points });
    expect(result.paths[0]).toEqual(path);
  });
});
