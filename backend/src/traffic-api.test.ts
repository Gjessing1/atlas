import Fastify from 'fastify';
import { encodePolyline } from '@atlas/core';
import { describe, expect, it, vi } from 'vitest';

import { StatusRegistry } from './status.js';
import { registerTrafficApi } from './traffic-api.js';

const xml = `
<messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:mc="http://datex2.eu/schema/3/messageContainer"
 xmlns:sit="http://datex2.eu/schema/3/situation" xmlns:loc="http://datex2.eu/schema/3/locationReferencing"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><mc:payload xsi:type="sit:SituationPublication" lang="no">
 <publicationTime>2026-07-31T10:00:00+02:00</publicationTime><sit:situation id="closure">
 <sit:overallSeverity>high</sit:overallSeverity><sit:situationRecord xsi:type="sit:RoadOrCarriagewayOrLaneManagement" id="r1">
 <sit:validity><validityTimeSpecification><overallStartTime>2026-07-31T08:00:00+02:00</overallStartTime>
 <overallEndTime>2026-07-31T18:00:00+02:00</overallEndTime></validityTimeSpecification></sit:validity>
 <sit:generalPublicComment><sit:comment><values><value lang="no">Vegen er stengt.</value></values></sit:comment></sit:generalPublicComment>
 <sit:locationReference><loc:locationContainedInGroup><loc:coordinatesForDisplay>
 <loc:latitude>59.905</loc:latitude><loc:longitude>10.7</loc:longitude></loc:coordinatesForDisplay>
 <loc:supplementaryPositionalDescription><loc:locationDescription><values><value lang="no">E18 ved Oslo</value></values>
 </loc:locationDescription></loc:supplementaryPositionalDescription></loc:locationContainedInGroup></sit:locationReference>
 <sit:roadOrCarriagewayOrLaneManagementType>roadClosed</sit:roadOrCarriagewayOrLaneManagementType>
 </sit:situationRecord></sit:situation></mc:payload></messageContainer>`;

const weatherSitesXml = `
<messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:rtd="http://datex2.eu/schema/3/roadTrafficData"
 xmlns:loc="http://datex2.eu/schema/3/locationReferencing"><publicationTime>2026-07-31T09:00:00+02:00</publicationTime>
 <rtd:measurementSiteTable><rtd:measurementSite id="weather-1"><rtd:measurementSiteName><values>
 <value lang="nob">E18 Ice hill</value></values></rtd:measurementSiteName><rtd:measurementSiteLocation>
 <loc:supplementaryPositionalDescription><loc:roadInformation><loc:roadNumber>E18</loc:roadNumber></loc:roadInformation>
 </loc:supplementaryPositionalDescription><loc:pointByCoordinates><loc:pointCoordinates><loc:latitude>59.905</loc:latitude>
 <loc:longitude>10.7</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates></rtd:measurementSiteLocation>
 </rtd:measurementSite></rtd:measurementSiteTable></messageContainer>`;

const measuredWeatherXml = `
<messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:rtd="http://datex2.eu/schema/3/roadTrafficData"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><publicationTime>2026-07-31T10:00:00+02:00</publicationTime>
 <rtd:siteMeasurements><rtd:measurementSiteReference id="weather-1"/><rtd:physicalQuantity><rtd:physicalQuantity>
 <rtd:basicData xsi:type="rtd:RoadSurfaceConditionInformation"><rtd:weatherRelatedRoadConditionType>wet</rtd:weatherRelatedRoadConditionType>
 <rtd:roadSurfaceConditionMeasurements><roadSurfaceTemperature><temperature>0.4</temperature></roadSurfaceTemperature>
 </rtd:roadSurfaceConditionMeasurements></rtd:basicData></rtd:physicalQuantity></rtd:physicalQuantity>
 <rtd:measurementTimeDefault><rtd:timeValue>2026-07-31T10:00:00+02:00</rtd:timeValue></rtd:measurementTimeDefault>
 </rtd:siteMeasurements></messageContainer>`;

const forecastWeatherXml = `
<messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:rtd="http://datex2.eu/schema/3/roadTrafficData"
 xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <publicationTime>2026-07-31T10:00:00+02:00</publicationTime><rtd:physicalQuantity><rtd:pertinentLocation>
 <loc:predefinedLocationReference id="weather-1"/></rtd:pertinentLocation><rtd:basicData xsi:type="rtd:RoadSurfaceConditionInformation">
 <rtd:measurementOrCalculationTime><rtd:timeValue>2026-07-31T10:00:00+02:00</rtd:timeValue></rtd:measurementOrCalculationTime>
 <rtd:weatherRelatedRoadConditionType>wet</rtd:weatherRelatedRoadConditionType><rtd:roadSurfaceConditionMeasurements>
 <roadSurfaceTemperature><temperature>0.2</temperature></roadSurfaceTemperature></rtd:roadSurfaceConditionMeasurements>
 </rtd:basicData></rtd:physicalQuantity></messageContainer>`;

/** Serves each DATEX publication from its own URL, as the real server does. */
const datexFetch = (overrides: Record<string, () => Response> = {}) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    expect((init?.headers as Record<string, string>)['Authorization']).toMatch(/^Basic /);
    const key = href.includes('GetMeasurementWeatherSiteTable')
      ? 'weatherSites'
      : href.includes('GetMeasuredWeatherData')
        ? 'measuredWeather'
        : href.includes('GetForecastPointData')
          ? 'forecastWeather'
          : 'situations';
    const override = overrides[key];
    if (override) return override();
    const body = {
      situations: xml,
      weatherSites: weatherSitesXml,
      measuredWeather: measuredWeatherXml,
      forecastWeather: forecastWeatherXml,
    }[key]!;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } });
  }) as typeof fetch;

describe('DATEX traffic API', () => {
  it('stays absent without credentials', async () => {
    const app = Fastify();
    expect(registerTrafficApi(app, new StatusRegistry(), {})).toEqual({
      enabled: false,
      metas: [],
    });
    await app.ready();
    expect((await app.inject('/api/overlay/traffic/features')).statusCode).toBe(404);
    expect((await app.inject('/api/overlay/road-weather/features')).statusCode).toBe(404);
    await app.close();
  });

  it('lists the incident and road-weather layers, and no longer serves travel times', async () => {
    const fetchImpl = datexFetch();
    const app = Fastify();
    const metas = registerTrafficApi(app, new StatusRegistry(), {
      username: 'user',
      password: 'secret',
      fetchImpl,
      now: () => new Date('2026-07-31T10:00:00+02:00'),
    }).metas;
    expect(metas.map(({ id, group, profiles }) => ({ id, group, profiles }))).toEqual([
      { id: 'traffic', group: 'Driving', profiles: ['driving'] },
      { id: 'road-weather', group: 'Driving', profiles: ['driving'] },
    ]);
    await app.ready();
    // NPRA retires GetTravelTimeData and GetPredefinedTravelTimeLocations from
    // November 2026. Bundles older than the removal still ask; a 404 is what
    // they already treat as "no measurement", so the route stands unpriced.
    expect((await app.inject('/api/overlay/traffic-flow/features')).statusCode).toBe(404);
    const priced = await app.inject({
      method: 'POST',
      url: '/api/traffic/travel-times',
      payload: {
        points: [
          { lat: 59.9, lng: 10.7 },
          { lat: 59.91, lng: 10.7 },
        ],
      },
    });
    expect(priced.statusCode).toBe(404);
    const asked = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) =>
      String(url),
    );
    expect(asked.some((url) => url.includes('TravelTime'))).toBe(false);
    await app.close();
  });

  it('serves features and only closures touching a route', async () => {
    const fetchImpl = datexFetch();
    const app = Fastify();
    expect(
      registerTrafficApi(app, new StatusRegistry(), {
        username: 'user',
        password: 'secret',
        fetchImpl,
        now: () => new Date('2026-07-31T10:00:00+02:00'),
      }).enabled,
    ).toBe(true);
    await app.ready();
    const features = await app.inject('/api/overlay/traffic/features');
    expect(features.statusCode).toBe(200);
    expect(features.json().features[0]).toMatchObject({
      properties: { kind: 'closure', message: 'Vegen er stengt.', location: 'E18 ved Oslo' },
    });
    const on = await app.inject({
      method: 'POST',
      url: '/api/traffic/closures',
      payload: {
        points: [
          { lat: 59.9, lng: 10.7 },
          { lat: 59.91, lng: 10.7 },
        ],
      },
    });
    expect(on.json().closures).toHaveLength(1);
    const off = await app.inject({
      method: 'POST',
      url: '/api/traffic/closures',
      payload: {
        points: [
          { lat: 59.9, lng: 10.8 },
          { lat: 59.91, lng: 10.8 },
        ],
      },
    });
    expect(off.json().closures).toEqual([]);
    // The situation feed is fetched once and cached; the three road-weather
    // publications are warmed alongside it.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await app.close();
  });

  it('shows road conditions and warns for ice on a planned route', async () => {
    const app = Fastify();
    registerTrafficApi(app, new StatusRegistry(), {
      username: 'user',
      password: 'secret',
      fetchImpl: datexFetch(),
      now: () => new Date('2026-07-31T10:00:00+02:00'),
    });
    await app.ready();
    const layer = await app.inject('/api/overlay/road-weather/features');
    expect(layer.statusCode).toBe(200);
    expect(layer.json().features[0].properties).toMatchObject({
      name: 'E18 Ice hill',
      condition: 'wet',
      surfaceTemperatureC: 0.4,
      risk: 'high',
    });
    const route = await app.inject({
      method: 'POST',
      url: '/api/traffic/road-weather',
      payload: {
        durationMs: 600_000,
        shape: encodePolyline([
          { lat: 59.9, lng: 10.7 },
          { lat: 59.91, lng: 10.7 },
        ]),
      },
    });
    expect(route.statusCode).toBe(200);
    expect(route.json()).toMatchObject({
      matchedSites: 1,
      warnings: [{ stationName: 'E18 Ice hill', risk: 'high' }],
    });
    await app.close();
  });

  it('says on the status page how many situations are current', async () => {
    // A healthy source whose detail line is empty is the weak half of N7: the
    // useful question is not "did the feed answer" but "how much of it is
    // reporting", and `record`'s message is dropped on success.
    const registry = new StatusRegistry();
    const app = Fastify();
    registerTrafficApi(app, registry, {
      username: 'user',
      password: 'secret',
      fetchImpl: datexFetch(),
      now: () => new Date('2026-07-31T10:00:00+02:00'),
    });
    await app.ready();
    await app.inject('/api/overlay/traffic/features');
    const sources = registry.toStatus();
    expect(sources.find((source) => source.id === 'datex')?.detail).toBe('1 current situations');
    expect(sources.find((source) => source.id === 'datex-traveltime')).toBeUndefined();
    await app.close();
  });

  it('rejects a request without a route and reports an upstream failure', async () => {
    const fetchImpl = datexFetch({
      situations: () => new Response('nope', { status: 503 }),
    });
    const app = Fastify();
    registerTrafficApi(app, new StatusRegistry(), {
      username: 'user',
      password: 'secret',
      fetchImpl,
    });
    await app.ready();
    const short = await app.inject({
      method: 'POST',
      url: '/api/traffic/closures',
      payload: { points: [{ lat: 59.9, lng: 10.7 }] },
    });
    expect(short.statusCode).toBe(400);
    const failed = await app.inject({
      method: 'POST',
      url: '/api/traffic/closures',
      payload: {
        points: [
          { lat: 59.9, lng: 10.7 },
          { lat: 59.91, lng: 10.7 },
        ],
      },
    });
    // 502, not a fabricated empty list: the client decides what an unreachable
    // feed means, and "no closures" must stay distinguishable from it.
    expect(failed.statusCode).toBe(502);
    await app.close();
  });
});
