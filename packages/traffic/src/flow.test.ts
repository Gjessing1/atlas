import type { LatLng } from '@atlas/core';
import { describe, expect, it } from 'vitest';

import {
  corridorFlow,
  simplifyLine,
  tappedFlowProperties,
  trafficFlowFeatureCollection,
} from './flow.js';
import type { TravelTimeCorridor, TravelTimeMeasurement } from './traveltime.js';

const measurement = (
  corridorId: string,
  durationS: number | undefined,
  freeFlowS: number | undefined,
): TravelTimeMeasurement => ({
  corridorId,
  ...(durationS === undefined ? {} : { durationS }),
  ...(freeFlowS === undefined ? {} : { freeFlowS }),
  // NPRA's own word, which the live feed only ever sets to freeFlow or
  // unknown — deliberately the *wrong* one here, so a classification that
  // reads it instead of the durations fails this file.
  status: 'freeFlow',
  measuredAt: '2026-08-03T07:30:00.010+02:00',
});

/** A straight north-going line of `count` points from Oslo, 100 m apart. */
const straight = (count: number): LatLng[] =>
  Array.from({ length: count }, (_, i) => ({ lat: 59.9 + i * 0.0009, lng: 10.7 }));

const corridor = (id: string, name: string, points = straight(4)): TravelTimeCorridor => ({
  id,
  name,
  points,
});

describe('corridor flow classification', () => {
  it('grades a corridor by its ratio to its own free-flow reference', () => {
    expect(corridorFlow(measurement('a', 300, 300)).level).toBe('flowing');
    // Faster than the reference is normal — half the table is — and must not
    // become its own state.
    expect(corridorFlow(measurement('a', 190, 300)).level).toBe('flowing');
    expect(corridorFlow(measurement('a', 375, 300)).level).toBe('busy');
    expect(corridorFlow(measurement('a', 450, 300)).level).toBe('slow');
    expect(corridorFlow(measurement('a', 700, 300)).level).toBe('queuing');
    // Helsfyr–Ryen as measured live on 2026-08-03 at 07:30, while NPRA's own
    // status field said `freeFlow`.
    expect(corridorFlow(measurement('a', 506, 300))).toMatchObject({
      level: 'slow',
      delayS: 206,
    });
  });

  it('does not colour a corridor for a delay the ETA would not mention', () => {
    // Filipstad–Skøyen as measured live: 1.19x, and 29 seconds. Ratio alone
    // called it busy, and the card then had to say "3 min (normally 3 min)".
    expect(corridorFlow(measurement('a', 182, 153))).toMatchObject({
      level: 'flowing',
      delayS: 29,
    });
    // The same ratio on a corridor long enough for it to cost real time.
    expect(corridorFlow(measurement('a', 1785, 1500)).level).toBe('busy');
    // The floor never *promotes* a corridor: a minute lost on a short stretch
    // is a large ratio, and still reads as the queue it is.
    expect(corridorFlow(measurement('a', 180, 120)).level).toBe('slow');
  });

  it('never reads a missing measurement as a clear road', () => {
    // 64 of 202 corridors report exactly this on an ordinary morning.
    expect(corridorFlow(measurement('a', undefined, undefined)).level).toBe('unmeasured');
    expect(corridorFlow(measurement('a', 300, undefined)).level).toBe('unmeasured');
    expect(corridorFlow(undefined).level).toBe('unmeasured');
    // A broken detector is not a jam: past six times free flow the reading is
    // dropped rather than drawn as the worst congestion in the country.
    expect(corridorFlow(measurement('a', 2400, 300)).level).toBe('unmeasured');
    expect(corridorFlow(measurement('a', 2400, 300)).delayS).toBeUndefined();
  });
});

describe('line simplification', () => {
  it('drops collinear vertices and keeps both ends', () => {
    const points = straight(50);
    const simplified = simplifyLine(points, 10);
    expect(simplified).toHaveLength(2);
    expect(simplified[0]).toEqual(points[0]);
    expect(simplified.at(-1)).toEqual(points.at(-1));
  });

  it('keeps a bend that is wider than the tolerance', () => {
    const points: LatLng[] = [
      { lat: 59.9, lng: 10.7 },
      // ~55 m east of the straight line between its neighbours.
      { lat: 59.905, lng: 10.701 },
      { lat: 59.91, lng: 10.7 },
    ];
    expect(simplifyLine(points, 10)).toHaveLength(3);
    expect(simplifyLine(points, 200)).toHaveLength(2);
  });

  it('returns short lines untouched', () => {
    expect(simplifyLine([], 10)).toEqual([]);
    expect(simplifyLine(straight(2), 10)).toHaveLength(2);
  });
});

describe('choosing the tapped corridor', () => {
  /** A hit as either client's queryRenderedFeatures returns it. */
  const hit = (name: string, level: string, lng: number) => ({
    geometry: {
      type: 'LineString',
      coordinates: [
        [lng, 59.9],
        [lng, 59.92],
      ],
    },
    properties: { name, level },
  });

  it('describes the line under the tap, not whichever came back first', () => {
    // The far corridor is the worse one; the tap was not on it.
    const chosen = tappedFlowProperties({ lat: 59.91, lng: 10.7 }, [
      hit('Far - Away', 'queuing', 10.71),
      hit('Under - Tap', 'flowing', 10.7),
    ]);
    expect(chosen).toMatchObject({ name: 'Under - Tap' });
  });

  it('names the worse direction when both carriageways are under the same tap', () => {
    // NPRA separates the two directions of a road by a median of 13 m, so no
    // tap can distinguish them; the queue is the answer worth giving, and the
    // card names the stretch, so the direction is still stated.
    const at = { lat: 59.91, lng: 10.7 };
    const inbound = hit('Ryen - Helsfyr', 'slow', 10.70012);
    const outbound = hit('Helsfyr - Ryen', 'flowing', 10.7);
    expect(tappedFlowProperties(at, [outbound, inbound])).toMatchObject({
      name: 'Ryen - Helsfyr',
    });
    expect(tappedFlowProperties(at, [inbound, outbound])).toMatchObject({
      name: 'Ryen - Helsfyr',
    });
  });

  it('has nothing to say about an empty tap', () => {
    expect(tappedFlowProperties({ lat: 59.9, lng: 10.7 }, [])).toBeNull();
    expect(tappedFlowProperties({ lat: 59.9, lng: 10.7 }, undefined)).toBeNull();
  });
});

describe('traffic flow overlay', () => {
  it('draws every corridor, measured or not, with its own colour', () => {
    const collection = trafficFlowFeatureCollection(
      [corridor('1', 'Helsfyr - Ryen'), corridor('2', 'Ryen - Helsfyr')],
      [measurement('1', 506, 300)],
    );
    expect(collection.features).toHaveLength(2);
    expect(collection.features[0]!.properties).toMatchObject({
      id: '1',
      name: 'Helsfyr - Ryen',
      level: 'slow',
      durationS: 506,
      freeFlowS: 300,
      delayS: 206,
      measuredAt: '2026-08-03T07:30:00.010+02:00',
    });
    // A corridor with no measurement is drawn grey and says nothing else: its
    // absence from the map would read as "no corridor here", which is a
    // different and untrue claim.
    const unmeasured = collection.features[1]!.properties;
    expect(unmeasured).toMatchObject({ level: 'unmeasured', color: '#9ca3af' });
    expect(unmeasured.durationS).toBeUndefined();
    expect(unmeasured.delayS).toBeUndefined();
    expect(collection.features[0]!.properties.color).not.toBe(unmeasured.color);
  });

  it('simplifies the drawn geometry and rounds it to about a metre', () => {
    const collection = trafficFlowFeatureCollection([corridor('1', 'A - B', straight(400))], []);
    const coordinates = collection.features[0]!.geometry.coordinates;
    expect(coordinates.length).toBeLessThan(10);
    expect(coordinates[0]).toEqual([10.7, 59.9]);
    for (const [lng, lat] of coordinates) {
      expect(String(lng).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5);
      expect(String(lat).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(5);
    }
  });
});
