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

/** One corridor along the test route, and a measurement 60 s over free flow. */
const corridorsXml = `
<mc:messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:mc="http://datex2.eu/schema/3/messageContainer"
 xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <mc:payload xsi:type="loc:PredefinedLocationsPublication" lang="no">
 <publicationTime>2026-07-31T09:00:00+02:00</publicationTime>
 <loc:predefinedLocationReference xsi:type="loc:PredefinedLocation" id="100" version="1">
  <loc:predefinedLocationName><values><value lang="no">Teststrekning nord</value></values></loc:predefinedLocationName>
  <loc:location xsi:type="loc:LinearLocation"><loc:gmlLineString srsName="http://www.opengis.net/gml/srs/epsg.xml#32633">
   <loc:posList>259545 6648086 259581 6648642 259617 6649198</loc:posList>
  </loc:gmlLineString></loc:location>
 </loc:predefinedLocationReference></mc:payload></mc:messageContainer>`;

const travelTimesXml = `
<mc:messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:mc="http://datex2.eu/schema/3/messageContainer"
 xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:rtd="http://datex2.eu/schema/3/roadTrafficData"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <mc:payload xsi:type="rtd:ElaboratedDataPublication" lang="no">
 <publicationTime>2026-07-31T10:00:00+02:00</publicationTime>
 <rtd:physicalQuantity xsi:type="rtd:SinglePhysicalQuantity">
  <rtd:pertinentLocation xsi:type="loc:LocationByReference">
   <loc:predefinedLocationReference targetClass="loc:PredefinedLocation" id="100" version="1"/>
  </rtd:pertinentLocation>
  <rtd:basicData xsi:type="rtd:TravelTimeData">
   <rtd:measurementOrCalculationTime><rtd:period>
    <startOfPeriod>2026-07-31T09:55:00+02:00</startOfPeriod><endOfPeriod>2026-07-31T10:00:00+02:00</endOfPeriod>
   </rtd:period></rtd:measurementOrCalculationTime>
   <rtd:travelTime><rtd:duration>180</rtd:duration></rtd:travelTime>
   <rtd:freeFlowTravelTime><rtd:duration>120</rtd:duration></rtd:freeFlowTravelTime>
  </rtd:basicData></rtd:physicalQuantity>
 <rtd:physicalQuantity xsi:type="rtd:SinglePhysicalQuantity">
  <rtd:pertinentLocation xsi:type="loc:LocationByReference">
   <loc:predefinedLocationReference targetClass="loc:PredefinedLocation" id="100" version="1"/>
  </rtd:pertinentLocation>
  <rtd:basicData xsi:type="rtd:TrafficStatus">
   <rtd:trafficStatus><rtd:trafficStatusValue>slow</rtd:trafficStatusValue></rtd:trafficStatus>
</rtd:basicData></rtd:physicalQuantity></mc:payload></mc:messageContainer>`;

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
          : href.includes('GetPredefinedTravelTimeLocations')
            ? 'corridors'
            : href.includes('GetTravelTimeData')
              ? 'travelTimes'
              : 'situations';
    const override = overrides[key];
    if (override) return override();
    const body = {
      corridors: corridorsXml,
      travelTimes: travelTimesXml,
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
    expect((await app.inject('/api/overlay/traffic-flow/features')).statusCode).toBe(404);
    await app.close();
  });

  it('draws the corridors it measures, and says which it is not measuring', async () => {
    const app = Fastify();
    expect(
      registerTrafficApi(app, new StatusRegistry(), {
        username: 'user',
        password: 'secret',
        fetchImpl: datexFetch(),
        now: () => new Date('2026-07-31T10:00:00+02:00'),
      }).metas.map((meta) => meta.id),
    ).toEqual(['traffic', 'traffic-flow', 'road-weather']);
    await app.ready();
    const flow = await app.inject('/api/overlay/traffic-flow/features');
    expect(flow.statusCode).toBe(200);
    const [feature] = flow.json().features as Array<{
      properties: Record<string, unknown>;
      geometry: { coordinates: [number, number][] };
    }>;
    // 180 s against a 120 s reference is 1.5× — slow, whatever the feed's own
    // `trafficStatusValue` says (the fixture says `slow` too, but the live one
    // says `freeFlow` for every corridor it measures).
    expect(feature!.properties).toMatchObject({
      id: '100',
      name: 'Teststrekning nord',
      level: 'slow',
      durationS: 180,
      freeFlowS: 120,
      delayS: 60,
    });
    expect(feature!.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  it('reports an unreachable corridor table as a failure, not an empty road network', async () => {
    const app = Fastify();
    registerTrafficApi(app, new StatusRegistry(), {
      username: 'user',
      password: 'secret',
      fetchImpl: datexFetch({ corridors: () => new Response('nope', { status: 503 }) }),
    });
    await app.ready();
    expect((await app.inject('/api/overlay/traffic-flow/features')).statusCode).toBe(502);
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
    // The situation feed is fetched once and cached; the corridor table and
    // the three road-weather publications are warmed alongside it.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    await app.close();
  });

  it('prices a route by the corridors it runs on', async () => {
    const fetchImpl = datexFetch();
    const app = Fastify();
    registerTrafficApi(app, new StatusRegistry(), {
      username: 'user',
      password: 'secret',
      fetchImpl,
      now: () => new Date('2026-07-31T10:00:00+02:00'),
    });
    await app.ready();
    const priced = await app.inject({
      method: 'POST',
      url: '/api/traffic/travel-times',
      payload: {
        points: [
          { lat: 59.9, lng: 10.7 },
          { lat: 59.905, lng: 10.7 },
          { lat: 59.91, lng: 10.7 },
        ],
      },
    });
    expect(priced.statusCode).toBe(200);
    expect(priced.json()).toMatchObject({
      delayMs: 60_000,
      measuredAt: '2026-07-31T10:00:00+02:00',
      segments: [{ corridorId: '100', name: 'Teststrekning nord', status: 'slow' }],
    });

    const elsewhere = await app.inject({
      method: 'POST',
      url: '/api/traffic/travel-times',
      payload: {
        points: [
          { lat: 63.43, lng: 10.39 },
          { lat: 63.44, lng: 10.39 },
        ],
      },
    });
    expect(elsewhere.json()).toMatchObject({ delayMs: 0, segments: [] });
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

  it('says on the status page how many corridors are actually measuring', async () => {
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
    await app.inject({
      method: 'POST',
      url: '/api/traffic/travel-times',
      payload: {
        points: [
          { lat: 59.9, lng: 10.7 },
          { lat: 59.91, lng: 10.7 },
        ],
      },
    });
    const sources = registry.toStatus();
    expect(sources.find((source) => source.id === 'datex-traveltime')).toMatchObject({
      health: 'ok',
      detail: '1 of 1 corridors measuring',
    });
    expect(sources.find((source) => source.id === 'datex')?.detail).toBe('1 current situations');
    await app.close();
  });

  it('rejects a request without a route and reports an upstream failure', async () => {
    const fetchImpl = datexFetch({
      travelTimes: () => new Response('nope', { status: 503 }),
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
      url: '/api/traffic/travel-times',
      payload: { points: [{ lat: 59.9, lng: 10.7 }] },
    });
    expect(short.statusCode).toBe(400);
    const failed = await app.inject({
      method: 'POST',
      url: '/api/traffic/travel-times',
      payload: {
        points: [
          { lat: 59.9, lng: 10.7 },
          { lat: 59.91, lng: 10.7 },
        ],
      },
    });
    // 502, not a fabricated zero: the client treats a failure as "no
    // measurement" itself, and the two must stay distinguishable here.
    expect(failed.statusCode).toBe(502);
    await app.close();
  });
});
