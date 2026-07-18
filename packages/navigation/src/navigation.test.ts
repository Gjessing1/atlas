import type { LatLng } from '@atlas/core';
import type { RouteInstruction, RoutePath } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import { followZoom, zoomForSpeed } from './camera.js';
import {
  bearingDeg,
  cumulativeDistances,
  pointAtDistance,
  snapToPolyline,
  snapToRoute,
  subPolyline,
} from './geometry.js';
import { maneuverArrowsGeoJSON } from './overlays.js';
import { NavigationSession } from './session.js';

// A straight eastward route at lat 60: 21 points, lng 10.000 → 10.020.
const routePoints: LatLng[] = Array.from({ length: 21 }, (_, i) => ({
  lat: 60,
  lng: 10 + i * 0.001,
}));
const routeCum = cumulativeDistances(routePoints);
const routeTotal = routeCum[routeCum.length - 1]!;

const instructions: RouteInstruction[] = [
  { text: 'Head east', distanceM: routeCum[10]!, timeMs: 60_000, sign: 0, interval: [0, 10] },
  {
    text: 'Turn right onto Elm Street',
    distanceM: routeTotal - routeCum[10]!,
    timeMs: 60_000,
    sign: 2,
    interval: [10, 20],
  },
  { text: 'Arrive at destination', distanceM: 0, timeMs: 0, sign: 4, interval: [20, 20] },
];

function route(withInstructions = true): RoutePath {
  return {
    points: routePoints,
    distanceM: routeTotal,
    timeMs: 120_000,
    ascentM: 0,
    descentM: 0,
    ...(withInstructions ? { instructions } : {}),
  };
}

/** A LatLng exactly `target` metres along the route polyline. */
function pointAtAlong(target: number): LatLng {
  const clamped = Math.min(Math.max(target, 0), routeTotal);
  for (let i = 0; i < routePoints.length - 1; i++) {
    if (clamped <= routeCum[i + 1]!) {
      const seg = routeCum[i + 1]! - routeCum[i]!;
      const t = seg > 0 ? (clamped - routeCum[i]!) / seg : 0;
      const a = routePoints[i]!;
      const b = routePoints[i + 1]!;
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
  }
  return routePoints[routePoints.length - 1]!;
}

describe('cumulativeDistances', () => {
  it('is monotonic, starts at zero, and handles edge sizes', () => {
    expect(cumulativeDistances([])).toEqual([]);
    expect(cumulativeDistances([{ lat: 60, lng: 10 }])).toEqual([0]);
    expect(routeCum[0]).toBe(0);
    for (let i = 1; i < routeCum.length; i++)
      expect(routeCum[i]!).toBeGreaterThan(routeCum[i - 1]!);
  });
});

describe('snapToPolyline', () => {
  it('projects a point onto the nearest segment with cross-track distance', () => {
    // ~100 m north of the middle of the line (0.0009° lat ≈ 100 m).
    const snap = snapToPolyline({ lat: 60.0009, lng: 10.01 }, routePoints, routeCum);
    expect(snap.crossTrackM).toBeGreaterThan(90);
    expect(snap.crossTrackM).toBeLessThan(110);
    expect(snap.point.lat).toBeCloseTo(60, 4);
    expect(snap.alongM).toBeCloseTo(routeCum[10]!, 0);
  });

  it('degenerates gracefully to a single-point route', () => {
    const snap = snapToPolyline({ lat: 60.001, lng: 10 }, [{ lat: 60, lng: 10 }], [0]);
    expect(snap.alongM).toBe(0);
    expect(snap.crossTrackM).toBeGreaterThan(0);
  });
});

describe('snapToRoute map matching', () => {
  // An out-and-back: east along lat 60, U-turn, back west ~33 m to the north.
  // Every point on the outbound leg has a near-equidistant rival on the
  // return leg — exactly the ambiguity the hints must resolve.
  const outAndBack: LatLng[] = [
    ...Array.from({ length: 11 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.001 })),
    ...Array.from({ length: 11 }, (_, i) => ({ lat: 60.0003, lng: 10.01 - i * 0.001 })),
  ];
  const oabCum = cumulativeDistances(outAndBack);
  const oabTotal = oabCum[oabCum.length - 1]!;
  // Midway between the legs, slightly nearer the return leg.
  const between = { lat: 60.00016, lng: 10.005 };

  it('matches snapToPolyline when no hint is given', () => {
    const q = { lat: 60.0009, lng: 10.01 };
    expect(snapToRoute(q, routePoints, routeCum)).toEqual(snapToPolyline(q, routePoints, routeCum));
  });

  it('stays on the outbound leg when progress says so', () => {
    const plain = snapToRoute(between, outAndBack, oabCum);
    expect(plain.alongM).toBeGreaterThan(oabTotal / 2); // rival leg wins unhinted
    const hinted = snapToRoute(between, outAndBack, oabCum, { prevAlongM: 250 });
    expect(hinted.alongM).toBeLessThan(oabTotal / 2);
    expect(hinted.point.lat).toBeCloseTo(60, 4);
  });

  it('follows the return leg once progress has passed the turn-around', () => {
    const hinted = snapToRoute(between, outAndBack, oabCum, { prevAlongM: oabTotal - 250 });
    expect(hinted.alongM).toBeGreaterThan(oabTotal / 2);
    expect(hinted.point.lat).toBeCloseTo(60.0003, 4);
  });

  it('uses the travel direction to pick between opposing segments', () => {
    // Nearer the outbound leg, but driving west: the return leg must win.
    const nearOutbound = { lat: 60.0001, lng: 10.005 };
    const east = snapToRoute(nearOutbound, outAndBack, oabCum, { headingDeg: 90 });
    expect(east.point.lat).toBeCloseTo(60, 4);
    const west = snapToRoute(nearOutbound, outAndBack, oabCum, { headingDeg: 270 });
    expect(west.point.lat).toBeCloseTo(60.0003, 4);
  });

  it('never lets hints override a clearly nearest segment', () => {
    // Right on the outbound leg: even an opposing heading must not drag the
    // snap 33 m sideways to the return leg.
    const onOutbound = { lat: 60, lng: 10.005 };
    const snap = snapToRoute(onOutbound, outAndBack, oabCum, { headingDeg: 270 });
    expect(snap.point.lat).toBeCloseTo(60, 4);
  });
});

describe('NavigationSession progress', () => {
  it('tracks remaining distance, the next maneuver, and ETA', () => {
    const s = new NavigationSession(route());
    const now = 1_000_000;

    const start = s.update(pointAtAlong(0), now).state;
    expect(start.status).toBe('navigating');
    expect(start.distanceRemainingM).toBeCloseTo(routeTotal, 0);
    expect(start.upcoming?.instruction.text).toBe('Turn right onto Elm Street');
    expect(start.upcoming?.distanceToM).toBeCloseTo(routeCum[10]!, 0);
    expect(start.timeRemainingMs).toBeCloseTo(120_000, -2);
    expect(start.etaEpochMs).toBeCloseTo(now + 120_000, -2);
    expect(start.routeProgress).toBeCloseTo(0, 3);

    const mid = s.update(pointAtAlong(routeCum[10]!), now).state;
    expect(mid.distanceRemainingM).toBeCloseTo(routeTotal - routeCum[10]!, 0);
    expect(mid.upcoming?.instruction.text).toBe('Arrive at destination');
    expect(mid.timeRemainingMs).toBeCloseTo(60_000, -2);
    expect(mid.routeProgress).toBeCloseTo(0.5, 2);
  });

  it('declares arrival within the arrival radius', () => {
    const s = new NavigationSession(route());
    const end = s.update(pointAtAlong(routeTotal), 0).state;
    expect(end.status).toBe('arrived');
    expect(end.upcoming).toBeNull();
    expect(end.distanceRemainingM).toBeLessThanOrEqual(25);
    expect(end.routeProgress).toBe(1);
  });

  it('estimates remaining time proportionally when there are no instructions', () => {
    const s = new NavigationSession(route(false));
    const mid = s.update(pointAtAlong(routeTotal / 2), 0).state;
    expect(mid.upcoming).toBeNull();
    expect(mid.timeRemainingMs).toBeCloseTo(60_000, -2);
  });
});

describe('NavigationSession off-route detection', () => {
  it('reports off-route only after the grace count of far fixes', () => {
    const s = new NavigationSession(route());
    const offPoint = { lat: 60.001, lng: 10.01 }; // ~110 m off the line
    expect(s.update(offPoint, 0).state.status).toBe('navigating'); // 1 of 3
    expect(s.update(offPoint, 0).state.status).toBe('navigating'); // 2 of 3
    const third = s.update(offPoint, 0);
    expect(third.state.status).toBe('off-route');
    expect(third.state.offRouteM).toBeGreaterThan(90);
    expect(third.prompts).toEqual([]);
  });

  it('resets the off-route counter when the traveller returns to the route', () => {
    const s = new NavigationSession(route());
    const offPoint = { lat: 60.001, lng: 10.01 };
    s.update(offPoint, 0);
    s.update(offPoint, 0);
    expect(s.update(pointAtAlong(routeCum[10]!), 0).state.status).toBe('navigating');
    // Counter reset: two more off fixes are not yet enough to re-trip.
    s.update(offPoint, 0);
    expect(s.update(offPoint, 0).state.status).toBe('navigating');
  });
});

describe('NavigationSession voice prompts', () => {
  const maneuverAlong = routeCum[10]!;

  it('fires approach then now prompts once each as the maneuver nears', () => {
    const s = new NavigationSession(route());

    // 500 m out — beyond the 400 m threshold, no prompt yet.
    expect(s.update(pointAtAlong(maneuverAlong - 500), 0).prompts).toEqual([]);

    // 350 m out — crosses the 400 m threshold.
    const p400 = s.update(pointAtAlong(maneuverAlong - 350), 0).prompts;
    expect(p400).toHaveLength(1);
    expect(p400[0]).toMatchObject({ kind: 'approach', thresholdM: 400 });
    expect(p400[0]!.text).toBe('In 400 meters, Turn right onto Elm Street');

    // Still between 400 and 200 — no repeat.
    expect(s.update(pointAtAlong(maneuverAlong - 250), 0).prompts).toEqual([]);

    // 150 m out — crosses 200 m.
    const p200 = s.update(pointAtAlong(maneuverAlong - 150), 0).prompts;
    expect(p200).toHaveLength(1);
    expect(p200[0]).toMatchObject({ kind: 'approach', thresholdM: 200 });

    // At the maneuver — the "now" prompt, spoken as the bare instruction.
    const pNow = s.update(pointAtAlong(maneuverAlong - 20), 0).prompts;
    expect(pNow).toHaveLength(1);
    expect(pNow[0]).toMatchObject({ kind: 'now', text: 'Turn right onto Elm Street' });

    // No further prompts for the same maneuver.
    expect(s.update(pointAtAlong(maneuverAlong - 5), 0).prompts).toEqual([]);
  });

  it('collapses skipped thresholds when a fix jumps close to the maneuver', () => {
    const s = new NavigationSession(route());
    // Jump straight from far away to 150 m: only the tightest crossed
    // threshold (200 m) speaks, not a stale "in 400 meters".
    const prompts = s.update(pointAtAlong(maneuverAlong - 150), 0).prompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.thresholdM).toBe(200);
  });

  it('only speaks "now" when a fix jumps straight onto the maneuver', () => {
    const s = new NavigationSession(route());
    const prompts = s.update(pointAtAlong(maneuverAlong - 10), 0).prompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.kind).toBe('now');
  });

  it('arms the far 800 m prompt only at highway speed', () => {
    const fast = new NavigationSession(route());
    const p800 = fast.update({ ...pointAtAlong(maneuverAlong - 700), speedMps: 25 }, 0).prompts;
    expect(p800).toHaveLength(1);
    expect(p800[0]).toMatchObject({ kind: 'approach', thresholdM: 800 });
    expect(p800[0]!.text).toBe('In 800 meters, Turn right onto Elm Street');
    // The 400 m prompt still follows normally afterwards.
    const p400 = fast.update({ ...pointAtAlong(maneuverAlong - 350), speedMps: 25 }, 0).prompts;
    expect(p400[0]).toMatchObject({ thresholdM: 400 });

    // City speed: silence until the standard 400 m threshold.
    const slow = new NavigationSession(route());
    expect(slow.update({ ...pointAtAlong(maneuverAlong - 700), speedMps: 12 }, 0).prompts).toEqual(
      [],
    );
  });
});

describe('NavigationSession snapped state', () => {
  it('exposes both the snapped point and the raw fix', () => {
    const s = new NavigationSession(route());
    // ~11 m north of the line: display should hug the road, raw kept as-is.
    const fix = { lat: 60.0001, lng: 10.005 };
    const state = s.update(fix, 0).state;
    expect(state.raw).toEqual(fix);
    expect(state.snapped.lat).toBeCloseTo(60, 5);
    expect(state.offRouteM).toBeGreaterThan(8);
    expect(state.offRouteM).toBeLessThan(15);
  });
});

describe('NavigationSession guards', () => {
  it('rejects an empty route', () => {
    expect(() => new NavigationSession({ ...route(), points: [] })).toThrow(/empty route/);
  });
});

describe('zoomForSpeed', () => {
  it('uses the close-in city zoom when stationary or unknown', () => {
    expect(zoomForSpeed(null, 60)).toBe(17);
    expect(zoomForSpeed(0.5, 60)).toBe(17);
  });

  it('zooms out as speed rises, within the clamp range', () => {
    const walking = zoomForSpeed(1.5, 60);
    const driving = zoomForSpeed(25, 60);
    expect(walking).toBeGreaterThan(driving);
    expect(driving).toBeGreaterThanOrEqual(15);
    expect(walking).toBeLessThanOrEqual(17.5);
  });

  it('quantizes to quarter-zoom steps', () => {
    const z = zoomForSpeed(13, 60);
    expect(Math.round(z * 4) / 4).toBe(z);
  });
});

describe('followZoom', () => {
  it('matches the speed zoom far from a maneuver', () => {
    expect(followZoom(25, 60, null)).toBe(zoomForSpeed(25, 60));
    expect(followZoom(25, 60, 1000)).toBe(zoomForSpeed(25, 60));
  });

  it('ramps monotonically to the intersection zoom as the turn nears', () => {
    const far = followZoom(25, 60, 290);
    const mid = followZoom(25, 60, 200);
    const near = followZoom(25, 60, 100);
    expect(far).toBeGreaterThanOrEqual(zoomForSpeed(25, 60));
    expect(mid).toBeGreaterThanOrEqual(far);
    expect(near).toBeGreaterThanOrEqual(mid);
    expect(near).toBe(17.5);
  });

  it('never zooms below the speed zoom', () => {
    // Slow approach: the speed zoom is already at/above the approach zoom.
    expect(followZoom(0, 60, 50)).toBeGreaterThanOrEqual(17);
  });
});

describe('geometry helpers', () => {
  it('bearingDeg follows the compass', () => {
    const a = { lat: 60, lng: 10 };
    expect(bearingDeg(a, { lat: 60.001, lng: 10 })).toBeCloseTo(0, 1);
    expect(bearingDeg(a, { lat: 60, lng: 10.001 })).toBeCloseTo(90, 1);
    expect(bearingDeg(a, { lat: 59.999, lng: 10 })).toBeCloseTo(180, 1);
    expect(bearingDeg(a, { lat: 60, lng: 9.999 })).toBeCloseTo(270, 1);
  });

  it('pointAtDistance interpolates and clamps to the ends', () => {
    const half = pointAtDistance(routePoints, routeCum, routeTotal / 2);
    expect(half.lat).toBeCloseTo(60, 6);
    expect(half.lng).toBeCloseTo(10.01, 4);
    expect(pointAtDistance(routePoints, routeCum, -5)).toEqual(routePoints[0]);
    expect(pointAtDistance(routePoints, routeCum, routeTotal + 5)).toEqual(
      routePoints[routePoints.length - 1],
    );
  });

  it('subPolyline cuts an interpolated slice of the line', () => {
    const slice = subPolyline(routePoints, routeCum, routeCum[5]! - 10, routeCum[5]! + 10);
    expect(slice.length).toBeGreaterThanOrEqual(2);
    const len = cumulativeDistances(slice).at(-1)!;
    expect(len).toBeCloseTo(20, 0);
    expect(subPolyline(routePoints, routeCum, 50, 50)).toEqual([]);
  });
});

describe('NavState course and then-maneuver', () => {
  it('reports the route tangent as the course', () => {
    const s = new NavigationSession(route());
    // Eastward route: course ≈ 90° everywhere, including at the very end
    // (where the tangent looks back instead of ahead).
    expect(s.update(pointAtAlong(100), 0).state.courseDeg).toBeCloseTo(90, 0);
    expect(s.update(pointAtAlong(routeTotal - 30), 0).state.courseDeg).toBeCloseTo(90, 0);
  });

  it('exposes the maneuver after the upcoming one', () => {
    const s = new NavigationSession(route());
    const start = s.update(pointAtAlong(0), 0).state;
    expect(start.upcoming?.instruction.text).toBe('Turn right onto Elm Street');
    expect(start.then?.instruction.text).toBe('Arrive at destination');
    expect(start.then!.distanceToM).toBeGreaterThan(start.upcoming!.distanceToM);

    const late = s.update(pointAtAlong(routeCum[10]! + 5), 0).state;
    expect(late.upcoming?.instruction.text).toBe('Arrive at destination');
    expect(late.then).toBeNull();
  });
});

describe('maneuverArrowsGeoJSON', () => {
  it('emits one body + tip pair per real turn, skipping continue and arrive', () => {
    const fc = maneuverArrowsGeoJSON(route());
    // Only the sign-2 turn qualifies (sign 0 head-east and sign 4 arrive do not).
    expect(fc.features).toHaveLength(2);
    const body = fc.features.find((f) => f.properties.kind === 'body')!;
    const tip = fc.features.find((f) => f.properties.kind === 'tip')!;
    expect(body.properties.alongM).toBeCloseTo(routeCum[10]!, 0);

    // The body spans ~35 m either side of the maneuver point.
    const coords = (body.geometry as { coordinates: number[][] }).coordinates;
    const line = coords.map(([lng, lat]) => ({ lat: lat!, lng: lng! }));
    expect(cumulativeDistances(line).at(-1)!).toBeCloseTo(70, 0);

    // Straight eastward route: the tip points east and sits past the turn.
    expect((tip.properties as { bearingDeg: number }).bearingDeg).toBeCloseTo(90, 0);
    const [tipLng] = (tip.geometry as { coordinates: number[] }).coordinates;
    expect(tipLng!).toBeGreaterThan(10.01);
  });

  it('returns no arrows for instruction-less or degenerate routes', () => {
    expect(maneuverArrowsGeoJSON(route(false)).features).toEqual([]);
    expect(maneuverArrowsGeoJSON({ points: [{ lat: 60, lng: 10 }] }).features).toEqual([]);
  });
});
