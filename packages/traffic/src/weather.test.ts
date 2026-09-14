import { describe, expect, it } from 'vitest';

import {
  formatRoadWeatherWarning,
  parseForecastRoadWeather,
  parseMeasuredRoadWeather,
  parseRoadWeatherSites,
  roadIceRisk,
  roadWeatherFeatureCollection,
  roadWeatherForRoute,
  type RoadWeatherReading,
} from './weather.js';

const sitesXml = `
<messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:rtd="http://datex2.eu/schema/3/roadTrafficData"
 xmlns:loc="http://datex2.eu/schema/3/locationReferencing">
 <publicationTime>2026-01-02T08:00:00+01:00</publicationTime>
 <rtd:measurementSiteTable><rtd:measurementSite id="ice-1">
  <rtd:measurementSiteName><values><value lang="nob">E18 Frost valley</value></values></rtd:measurementSiteName>
  <rtd:measurementSiteLocation><loc:supplementaryPositionalDescription><loc:roadInformation>
   <loc:roadNumber>E18</loc:roadNumber>
  </loc:roadInformation></loc:supplementaryPositionalDescription><loc:pointByCoordinates>
   <loc:pointCoordinates><loc:latitude>59.905</loc:latitude><loc:longitude>10.7</loc:longitude></loc:pointCoordinates>
  </loc:pointByCoordinates></rtd:measurementSiteLocation>
 </rtd:measurementSite></rtd:measurementSiteTable>
</messageContainer>`;

const measuredXml = `
<messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:rtd="http://datex2.eu/schema/3/roadTrafficData"
 xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <publicationTime>2026-01-02T08:02:00+01:00</publicationTime><rtd:siteMeasurements>
  <rtd:measurementSiteReference id="ice-1"/><rtd:physicalQuantity index="801"><rtd:physicalQuantity>
   <rtd:basicData xsi:type="rtd:RoadSurfaceConditionInformation"><rtd:roadSurfaceConditionMeasurements>
    <roadSurfaceTemperature><temperature>-0.6</temperature></roadSurfaceTemperature>
   </rtd:roadSurfaceConditionMeasurements></rtd:basicData>
  </rtd:physicalQuantity></rtd:physicalQuantity><rtd:physicalQuantity index="11201"><rtd:physicalQuantity>
   <rtd:basicData xsi:type="rtd:RoadSurfaceConditionInformation"><rtd:weatherRelatedRoadConditionType>wet</rtd:weatherRelatedRoadConditionType></rtd:basicData>
  </rtd:physicalQuantity></rtd:physicalQuantity><rtd:measurementTimeDefault>
   <rtd:timeValue>2026-01-02T08:00:00+01:00</rtd:timeValue>
  </rtd:measurementTimeDefault>
 </rtd:siteMeasurements></messageContainer>`;

const forecastXml = `
<messageContainer xmlns="http://datex2.eu/schema/3/common" xmlns:rtd="http://datex2.eu/schema/3/roadTrafficData"
 xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <publicationTime>2026-01-02T08:00:00+01:00</publicationTime><rtd:physicalQuantity>
  <rtd:pertinentLocation><loc:predefinedLocationReference id="ice-1"/></rtd:pertinentLocation>
  <rtd:basicData xsi:type="rtd:RoadSurfaceConditionInformation"><rtd:measurementOrCalculationTime>
   <rtd:timeValue>2026-01-02T09:00:00+01:00</rtd:timeValue></rtd:measurementOrCalculationTime>
   <rtd:weatherRelatedRoadConditionType>moist</rtd:weatherRelatedRoadConditionType>
   <rtd:roadSurfaceConditionMeasurements><roadSurfaceTemperature><temperature>1.8</temperature></roadSurfaceTemperature></rtd:roadSurfaceConditionMeasurements>
  </rtd:basicData><rtd:basicData xsi:type="rtd:RoadSurfaceConditionInformation">
   <rtd:measurementOrCalculationTime><rtd:timeValue>2026-01-02T10:00:00+01:00</rtd:timeValue></rtd:measurementOrCalculationTime>
   <rtd:weatherRelatedRoadConditionType>slippery</rtd:weatherRelatedRoadConditionType>
   <rtd:roadSurfaceConditionMeasurements><roadSurfaceTemperature><temperature>-1.2</temperature></roadSurfaceTemperature></rtd:roadSurfaceConditionMeasurements>
  </rtd:basicData>
 </rtd:physicalQuantity></messageContainer>`;

describe('DATEX road weather', () => {
  it('joins point-table identity to measured and forecast road conditions', () => {
    const table = parseRoadWeatherSites(sitesXml);
    const measured = parseMeasuredRoadWeather(measuredXml);
    const forecast = parseForecastRoadWeather(forecastXml);
    expect(table.sites).toEqual([
      {
        id: 'ice-1',
        name: 'E18 Frost valley',
        roadNumber: 'E18',
        position: { lat: 59.905, lng: 10.7 },
      },
    ]);
    expect(measured.readings[0]).toMatchObject({
      siteId: 'ice-1',
      validAt: '2026-01-02T08:00:00+01:00',
      surfaceTemperatureC: -0.6,
      condition: 'wet',
    });
    expect(forecast.readings).toHaveLength(2);
    expect(forecast.readings[1]).toMatchObject({
      condition: 'slippery',
      surfaceTemperatureC: -1.2,
    });
  });

  it('uses explicit ice/slippery evidence and temperature plus moisture', () => {
    const reading = (partial: Partial<RoadWeatherReading>): RoadWeatherReading => ({
      siteId: 'x',
      source: 'forecast',
      validAt: '2026-01-02T08:00:00Z',
      ...partial,
    });
    expect(roadIceRisk(reading({ condition: 'slippery', surfaceTemperatureC: 4 }))).toBe('high');
    expect(roadIceRisk(reading({ condition: 'wet', surfaceTemperatureC: 0.5 }))).toBe('high');
    expect(roadIceRisk(reading({ condition: 'moist', surfaceTemperatureC: 2 }))).toBe('possible');
    expect(roadIceRisk(reading({ condition: 'dry', surfaceTemperatureC: -8 }))).toBe('none');
    expect(
      roadIceRisk(
        reading({ surfaceTemperatureC: 0, airTemperatureC: 10, dewPointTemperatureC: 7 }),
      ),
    ).toBe('none');
    expect(roadIceRisk(reading({ friction: 0, surfaceTemperatureC: 14 }))).toBe('none');
  });

  it('distrusts a near-freezing road only under warm air, never for the size of the gap', () => {
    const reading = (partial: Partial<RoadWeatherReading>): RoadWeatherReading => ({
      siteId: 'x',
      source: 'forecast',
      validAt: '2026-09-14T19:00:00+02:00',
      ...partial,
    });
    // Fv 5256 Steinrusten's forecast on 2026-09-14, started from a stuck sensor.
    expect(
      roadIceRisk(
        reading({
          condition: 'slippery',
          surfaceTemperatureC: -0.1,
          airTemperatureC: 13.2,
          dewPointTemperatureC: 7.8,
          snowDepthM: 32.3,
        }),
      ),
    ).toBe('none');
    // Fv 542 Bremnes, measured the same evening.
    expect(
      roadIceRisk(reading({ condition: 'wet', surfaceTemperatureC: 1.1, airTemperatureC: 14.6 })),
    ).toBe('none');
    // A clear winter night really does put the road far below the air
    // (Fv 863 Gamnes, March: 6.6 °C colder) — the case the feature exists for.
    expect(
      roadIceRisk(reading({ condition: 'wet', surfaceTemperatureC: -11.5, airTemperatureC: -4.9 })),
    ).toBe('high');
    expect(
      roadIceRisk(
        reading({ precipitationMmH: 0.4, surfaceTemperatureC: -1.5, airTemperatureC: 4.5 }),
      ),
    ).toBe('high');
    // A broken air sensor cannot vouch against the road.
    expect(
      roadIceRisk(reading({ condition: 'wet', surfaceTemperatureC: -2, airTemperatureC: 60 })),
    ).toBe('high');
    // Low grip on a warm wet road is water (E10 Bjørnfjell); on a cold one it is ice.
    expect(
      roadIceRisk(
        reading({
          condition: 'wet',
          friction: 0.48,
          surfaceTemperatureC: 9.2,
          airTemperatureC: 4.3,
        }),
      ),
    ).toBe('none');
    expect(roadIceRisk(reading({ friction: 0.3, surfaceTemperatureC: -3 }))).toBe('high');
  });

  it("drops a station's forecast while its own sensor is contradicted by warm air", () => {
    const site = {
      id: 'stuck',
      name: 'Fv 714 Våvatnet',
      roadNumber: 'Fv714',
      position: { lat: 59.905, lng: 10.7 },
    };
    const route = [
      { lat: 59.9, lng: 10.7 },
      { lat: 59.91, lng: 10.7 },
    ];
    const now = new Date('2026-09-14T19:45:00+02:00');
    const measured: RoadWeatherReading[] = [
      {
        siteId: 'stuck',
        source: 'measured',
        validAt: '2026-09-14T19:40:00+02:00',
        surfaceTemperatureC: 0,
        airTemperatureC: 8.1,
        dewPointTemperatureC: 5.9,
      },
    ];
    // By 01:00 the air has cooled below the warm-air gate, but the forecast
    // still starts from the stuck sensor.
    const forecast: RoadWeatherReading[] = [
      {
        siteId: 'stuck',
        source: 'forecast',
        validAt: '2026-09-15T01:00:00+02:00',
        condition: 'slippery',
        surfaceTemperatureC: 0,
        airTemperatureC: 5.7,
        snowDepthM: 0.7,
      },
    ];
    // Half-way along a 10.5-hour route: reached at 01:00.
    const durationMs = 10.5 * 60 * 60_000;
    expect(
      roadWeatherForRoute(route, durationMs, [site], measured, forecast, now).warnings,
    ).toEqual([]);
    const healthy = [{ ...measured[0]!, surfaceTemperatureC: 7.6 }];
    expect(
      roadWeatherForRoute(route, durationMs, [site], healthy, forecast, now).warnings,
    ).toHaveLength(1);
  });

  it('times stations from the distance already driven', () => {
    const route = [
      { lat: 59.9, lng: 10.7 },
      { lat: 59.91, lng: 10.7 },
    ];
    const at = (traveledM: number) =>
      roadWeatherForRoute(
        route,
        4 * 60 * 60_000,
        parseRoadWeatherSites(sitesXml).sites,
        [],
        parseForecastRoadWeather(forecastXml).readings,
        new Date('2026-01-02T08:40:00+01:00'),
        traveledM,
      ).warnings[0];
    // From the start the half-way station is two hours off: the 10:00 forecast.
    expect(at(0)).toMatchObject({ id: 'ice-1', condition: 'slippery', risk: 'high' });
    // 500 m in, it is minutes away: the 09:00 forecast.
    expect(at(500)).toMatchObject({ id: 'ice-1', condition: 'moist', risk: 'possible' });
  });

  it('states the forecast time on the 24-hour clock', () => {
    expect(
      formatRoadWeatherWarning({
        id: 'ice-1',
        stationName: 'E18 Frost valley',
        roadNumber: 'E18',
        position: { lat: 59.905, lng: 10.7 },
        atM: 556,
        offsetM: 0,
        validAt: new Date(2026, 0, 2, 21, 5).toISOString(),
        source: 'forecast',
        risk: 'high',
        surfaceTemperatureC: -1.2,
        condition: 'slushOnRoad',
      }),
    ).toBe('Forecast ice risk at 21:05 near E18 Frost valley · road -1 °C · slush on road');
  });

  it('marks a contradicted surface sensor on the map instead of printing its reading', () => {
    const [feature] = roadWeatherFeatureCollection(
      [
        {
          id: 'stuck',
          name: 'E136 Tresfjordbrua',
          roadNumber: 'E136',
          position: { lat: 62.5, lng: 7.1 },
        },
      ],
      [
        {
          siteId: 'stuck',
          source: 'measured',
          validAt: '2026-09-14T19:50:00+02:00',
          surfaceTemperatureC: 0,
          airTemperatureC: 10.9,
        },
      ],
      [],
      new Date('2026-09-14T19:55:00+02:00'),
    ).features;
    expect(feature?.properties).toMatchObject({
      risk: 'none',
      airTemperatureC: 10.9,
      surfaceSuspect: true,
    });
    expect(feature?.properties.surfaceTemperatureC).toBeUndefined();
  });

  it('warns with the condition expected when the route reaches the station', () => {
    const sites = parseRoadWeatherSites(sitesXml).sites;
    const result = roadWeatherForRoute(
      [
        { lat: 59.9, lng: 10.7 },
        { lat: 59.91, lng: 10.7 },
      ],
      4 * 60 * 60_000,
      sites,
      parseMeasuredRoadWeather(measuredXml).readings,
      parseForecastRoadWeather(forecastXml).readings,
      new Date('2026-01-02T08:00:00+01:00'),
    );
    expect(result.matchedSites).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      stationName: 'E18 Frost valley',
      source: 'forecast',
      risk: 'high',
      condition: 'slippery',
    });
    expect(result.warnings[0]!.atM).toBeGreaterThan(500);
  });

  it('draws current observations and states their freshness', () => {
    const features = roadWeatherFeatureCollection(
      parseRoadWeatherSites(sitesXml).sites,
      parseMeasuredRoadWeather(measuredXml).readings,
      [],
      new Date('2026-01-02T08:05:00+01:00'),
    );
    expect(features.features[0]?.properties).toMatchObject({
      name: 'E18 Frost valley',
      surfaceTemperatureC: -0.6,
      condition: 'wet',
      risk: 'high',
      markerColor: '#dc2626',
    });
  });
});
