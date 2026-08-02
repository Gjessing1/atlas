import { wgs84ToUtm33, type LatLng } from '@atlas/core';
import type { RouteInstruction, RoutePath } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import { applyTrafficDelay, formatTrafficDelay, trafficDelayForRoute } from './delay.js';
import {
  parseTravelTimeCorridors,
  parseTravelTimeSnapshot,
  type TravelTimeCorridor,
} from './traveltime.js';

/**
 * Both fixtures keep NPRA's real namespacing and element order — the parsers
 * are streaming readers keyed on local names and parent paths, so a tidied-up
 * shape would test something the live feed never sends.
 */
const locationsXml = (body: string) => `
<ns2:messageContainer xmlns="http://datex2.eu/schema/3/common"
 xmlns:ns2="http://datex2.eu/schema/3/messageContainer"
 xmlns:ns8="http://datex2.eu/schema/3/locationReferencing"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <ns2:payload xsi:type="ns8:PredefinedLocationsPublication" lang="no" modelBaseVersion="3">
  <publicationTime>2026-08-02T11:05:47.692+02:00</publicationTime>${body}
 </ns2:payload>
</ns2:messageContainer>`;

const corridorXml = (id: string, name: string, posList: string) => `
 <ns8:predefinedLocationReference xsi:type="ns8:PredefinedLocation" id="${id}" version="1">
  <ns8:predefinedLocationName><values><value lang="no">${name}</value></values></ns8:predefinedLocationName>
  <ns8:location xsi:type="ns8:LinearLocation">
   <ns8:gmlLineString srsName="http://www.opengis.net/gml/srs/epsg.xml#32633">
    <ns8:posList>${posList}</ns8:posList>
   </ns8:gmlLineString>
  </ns8:location>
 </ns8:predefinedLocationReference>`;

const dataXml = (body: string) => `
<ns2:messageContainer xmlns="http://datex2.eu/schema/3/common"
 xmlns:ns2="http://datex2.eu/schema/3/messageContainer"
 xmlns:ns8="http://datex2.eu/schema/3/locationReferencing"
 xmlns:ns10="http://datex2.eu/schema/3/roadTrafficData"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <ns2:payload xsi:type="ns10:ElaboratedDataPublication" lang="no" modelBaseVersion="3">
  <publicationTime>2026-08-02T16:10:44.759+02:00</publicationTime>${body}
 </ns2:payload>
</ns2:messageContainer>`;

const travelTimeXml = (id: string, durationS: number | null, freeFlowS: number) => `
  <ns10:physicalQuantity xsi:type="ns10:SinglePhysicalQuantity">
   <ns10:pertinentLocation xsi:type="ns8:LocationByReference">
    <ns8:predefinedLocationReference targetClass="loc:PredefinedLocation" id="${id}" version="1"/>
   </ns10:pertinentLocation>
   <ns10:basicData xsi:type="ns10:TravelTimeData">
    <ns10:measurementOrCalculationTime><ns10:period>
     <startOfPeriod>2026-08-02T16:05:00.010+02:00</startOfPeriod>
     <endOfPeriod>2026-08-02T16:10:00.010+02:00</endOfPeriod>
    </ns10:period></ns10:measurementOrCalculationTime>
    <ns10:travelTimeTrendType>stable</ns10:travelTimeTrendType>
    ${durationS === null ? '' : `<ns10:travelTime><ns10:duration>${durationS}</ns10:duration></ns10:travelTime>`}
    ${durationS === null ? '' : `<ns10:freeFlowTravelTime><ns10:duration>${freeFlowS}</ns10:duration></ns10:freeFlowTravelTime>`}
   </ns10:basicData>
  </ns10:physicalQuantity>`;

const statusXml = (id: string, status: string) => `
  <ns10:physicalQuantity xsi:type="ns10:SinglePhysicalQuantity">
   <ns10:pertinentLocation xsi:type="ns8:LocationByReference">
    <ns8:predefinedLocationReference targetClass="loc:PredefinedLocation" id="${id}" version="1"/>
   </ns10:pertinentLocation>
   <ns10:basicData xsi:type="ns10:TrafficStatus">
    <ns10:trafficStatus><ns10:trafficStatusValue>${status}</ns10:trafficStatusValue></ns10:trafficStatus>
   </ns10:basicData>
  </ns10:physicalQuantity>`;

describe('parseTravelTimeCorridors', () => {
  it('reprojects the corridor table out of UTM33, both sides of the meridian', () => {
    // Verbatim first vertices of NPRA 100361 (Ammerud - Bjerke, Oslo) and
    // 100357 (Åsanevegen - Eikås, Bergen — negative eastings).
    const { publishedAt, corridors } = parseTravelTimeCorridors(
      locationsXml(
        corridorXml('100361', 'Ammerud - Bjerke', '269553 6653843 269528 6653821 269514 6653806') +
          corridorXml('100357', 'Åsanevegen - Eikås', '-30621 6742669 -30603 6742707'),
      ),
    );
    expect(publishedAt).toBe('2026-08-02T11:05:47.692+02:00');
    expect(corridors).toHaveLength(2);
    expect(corridors[0]).toMatchObject({ id: '100361', name: 'Ammerud - Bjerke' });
    expect(corridors[0]!.points[0]!.lat).toBeCloseTo(59.9573, 3);
    expect(corridors[0]!.points[0]!.lng).toBeCloseTo(10.872, 3);
    expect(corridors[1]!.points[0]!.lat).toBeCloseTo(60.4682, 3);
    expect(corridors[1]!.points[0]!.lng).toBeCloseTo(5.3264, 3);
  });

  it('drops a corridor with no usable geometry rather than inventing a point', () => {
    const { corridors } = parseTravelTimeCorridors(
      locationsXml(corridorXml('1', 'Nowhere', '269553 6653843')),
    );
    expect(corridors).toEqual([]);
  });
});

describe('parseTravelTimeSnapshot', () => {
  it('joins the travel time and the traffic status of one corridor', () => {
    const snapshot = parseTravelTimeSnapshot(
      dataXml(travelTimeXml('100361', 320, 250) + statusXml('100361', 'slow')),
    );
    expect(snapshot.publishedAt).toBe('2026-08-02T16:10:44.759+02:00');
    expect(snapshot.measurements).toEqual([
      {
        corridorId: '100361',
        durationS: 320,
        freeFlowS: 250,
        status: 'slow',
        measuredAt: '2026-08-02T16:10:00.010+02:00',
      },
    ]);
  });

  it('reports an unmeasured corridor as unknown, never as free-flowing', () => {
    // 62 of 202 corridors were in exactly this state on the first live probe:
    // present, no duration. Treating that as "no delay" is a guess; treating it
    // as unknown is the truth, and both read the same in an ETA — the point is
    // that the status never claims the road is clear.
    const snapshot = parseTravelTimeSnapshot(
      dataXml(travelTimeXml('100999', null, 0) + statusXml('100999', 'unknown')),
    );
    expect(snapshot.measurements[0]).toMatchObject({ status: 'unknown' });
    expect(snapshot.measurements[0]?.durationS).toBeUndefined();
  });
});

/** A straight corridor of `count` points, `stepM` apart, heading north. */
const line = (from: LatLng, count: number, stepM: number): LatLng[] =>
  Array.from({ length: count }, (_, i) => ({
    lat: from.lat + (i * stepM) / 111_320,
    lng: from.lng,
  }));

const corridor = (id: string, name: string, points: LatLng[]): TravelTimeCorridor => ({
  id,
  name,
  points,
});

const start: LatLng = { lat: 59.9, lng: 10.75 };

describe('trafficDelayForRoute', () => {
  const route = line(start, 21, 100); // 2 km due north

  it('charges only the measured time above free flow', () => {
    const delay = trafficDelayForRoute(
      route,
      [corridor('a', 'Ammerud - Bjerke', line(start, 11, 100))],
      [{ corridorId: 'a', durationS: 300, freeFlowS: 240, status: 'slow', measuredAt: 'now' }],
    );
    expect(delay.delayMs).toBe(60_000);
    expect(delay.segments[0]).toMatchObject({ corridorId: 'a', name: 'Ammerud - Bjerke' });
    expect(delay.segments[0]!.endM).toBeCloseTo(1000, -1);
  });

  it('never shortens an ETA when a corridor beats its own free-flow reference', () => {
    // Half the corridors measure faster than NPRA's reference; promising the
    // driver that pace is not a measurement we are entitled to make.
    const delay = trafficDelayForRoute(
      route,
      [corridor('a', 'Fast corridor', line(start, 11, 100))],
      [{ corridorId: 'a', durationS: 150, freeFlowS: 240, status: 'freeFlow', measuredAt: 'now' }],
    );
    expect(delay.delayMs).toBe(0);
    expect(delay.segments).toEqual([]);
  });

  it('ignores the opposite carriageway', () => {
    // Same road, reversed: NPRA publishes both directions and only one queues.
    const delay = trafficDelayForRoute(
      route,
      [corridor('b', 'Bjerke - Ammerud', [...line(start, 11, 100)].reverse())],
      [{ corridorId: 'b', durationS: 600, freeFlowS: 240, status: 'queuing', measuredAt: 'now' }],
    );
    expect(delay.delayMs).toBe(0);
  });

  it('takes only the share of a corridor the route actually covers', () => {
    // The corridor runs 2 km further north than the route does.
    const delay = trafficDelayForRoute(
      line(start, 11, 100),
      [corridor('a', 'Long corridor', line(start, 21, 100))],
      [{ corridorId: 'a', durationS: 300, freeFlowS: 240, status: 'slow', measuredAt: 'now' }],
    );
    expect(delay.delayMs).toBeGreaterThan(25_000);
    expect(delay.delayMs).toBeLessThan(35_000);
  });

  it('does not charge a shared kilometre twice when corridors overlap', () => {
    // NPRA measures Bjerke–Helsfyr and Bjerke–Teisen over the same first
    // kilometre; adding both would invent a minute nobody will spend.
    const overlapping = trafficDelayForRoute(
      route,
      [
        corridor('a', 'Bjerke - Helsfyr', line(start, 11, 100)),
        corridor('b', 'Bjerke - Teisen', line(start, 11, 100)),
      ],
      [
        { corridorId: 'a', durationS: 300, freeFlowS: 240, status: 'slow', measuredAt: 'now' },
        { corridorId: 'b', durationS: 300, freeFlowS: 240, status: 'slow', measuredAt: 'now' },
      ],
    );
    expect(overlapping.delayMs).toBe(60_000);
  });

  it('leaves a route that merely crosses a corridor alone', () => {
    // Due east across the middle of the north-south corridor.
    const crossing = Array.from({ length: 11 }, (_, i) => ({
      lat: 59.905,
      lng: 10.7 + i * 0.001,
    }));
    const delay = trafficDelayForRoute(
      crossing,
      [corridor('a', 'North-south', line(start, 21, 100))],
      [{ corridorId: 'a', durationS: 600, freeFlowS: 240, status: 'queuing', measuredAt: 'now' }],
    );
    expect(delay.delayMs).toBe(0);
  });

  it('discards an implausible measurement instead of ruining the ETA', () => {
    const delay = trafficDelayForRoute(
      route,
      [corridor('a', 'Broken detector', line(start, 11, 100))],
      [{ corridorId: 'a', durationS: 9_000, freeFlowS: 240, status: 'slow', measuredAt: 'now' }],
    );
    expect(delay.delayMs).toBe(0);
  });

  it('answers zero when the corridor table and the route share no road', () => {
    const delay = trafficDelayForRoute(
      route,
      [corridor('a', 'Bergen', line({ lat: 60.46, lng: 5.32 }, 11, 100))],
      [{ corridorId: 'a', durationS: 300, freeFlowS: 240, status: 'slow', measuredAt: 'now' }],
    );
    expect(delay).toMatchObject({ delayMs: 0, segments: [] });
  });
});

describe('applyTrafficDelay', () => {
  const points = line(start, 21, 100).map((point) => ({ ...point }));
  const instruction = (from: number, to: number, timeMs: number): RouteInstruction => ({
    text: 'Continue',
    distanceM: (to - from) * 100,
    timeMs,
    sign: 0,
    interval: [from, to],
  });
  const path: RoutePath = {
    points,
    distanceM: 2000,
    timeMs: 200_000,
    ascentM: 0,
    descentM: 0,
    instructions: [instruction(0, 10, 100_000), instruction(10, 20, 100_000)],
  };

  it('puts the delay on the maneuvers the jam sits on, not on the whole trip', () => {
    // Navigation prices the rest of the drive from the maneuver schedule, so a
    // delay added to the total alone would still be charged after passing it.
    const updated = applyTrafficDelay(path, {
      delayMs: 60_000,
      measuredAt: 'now',
      segments: [
        { corridorId: 'a', name: 'A', startM: 0, endM: 1000, delayMs: 60_000, status: 'slow' },
      ],
    });
    expect(updated.timeMs).toBe(260_000);
    expect(updated.trafficDelayMs).toBe(60_000);
    expect(updated.instructions?.[0]?.timeMs).toBeCloseTo(160_000, -3);
    expect(updated.instructions?.[1]?.timeMs).toBeCloseTo(100_000, -3);
  });

  it('keeps the maneuver schedule summing to the adjusted total', () => {
    const updated = applyTrafficDelay(path, {
      delayMs: 90_000,
      measuredAt: 'now',
      // Half of this segment runs past the end of the route.
      segments: [
        { corridorId: 'a', name: 'A', startM: 1000, endM: 3000, delayMs: 90_000, status: 'slow' },
      ],
    });
    const scheduled = (updated.instructions ?? []).reduce((sum, step) => sum + step.timeMs, 0);
    expect(scheduled).toBe(updated.timeMs);
  });

  it('leaves a path without instructions with its total adjusted', () => {
    const bare: RoutePath = { ...path, instructions: undefined };
    const updated = applyTrafficDelay(bare, {
      delayMs: 60_000,
      measuredAt: 'now',
      segments: [
        { corridorId: 'a', name: 'A', startM: 0, endM: 1000, delayMs: 60_000, status: 'slow' },
      ],
    });
    expect(updated.timeMs).toBe(260_000);
    expect(updated.instructions).toBeUndefined();
  });

  it('is a no-op when nothing was measured', () => {
    expect(applyTrafficDelay(path, { delayMs: 0, segments: [], measuredAt: '' })).toBe(path);
  });
});

describe('formatTrafficDelay', () => {
  it('stays silent below a minute, where an ETA is not honest anyway', () => {
    expect(formatTrafficDelay(undefined)).toBeNull();
    expect(formatTrafficDelay(0)).toBeNull();
    expect(formatTrafficDelay(45_000)).toBeNull();
    expect(formatTrafficDelay(360_000)).toBe('+6 min traffic');
  });
});

describe('UTM33 fixtures', () => {
  it('projects a corridor vertex back to where NPRA published it', () => {
    // Guards the fixtures above: if the projection ever moves, these corridor
    // coordinates stop being the Oslo road they are named after.
    const { x, y } = wgs84ToUtm33(10.872011, 59.957267);
    expect(x).toBeCloseTo(269553, -1);
    expect(y).toBeCloseTo(6653843, -1);
  });
});
