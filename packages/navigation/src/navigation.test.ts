import type { LatLng } from '@atlas/core';
import type { RouteInstruction, RoutePath } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import { cumulativeDistances, snapToPolyline } from './geometry.js';
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

    const mid = s.update(pointAtAlong(routeCum[10]!), now).state;
    expect(mid.distanceRemainingM).toBeCloseTo(routeTotal - routeCum[10]!, 0);
    expect(mid.upcoming?.instruction.text).toBe('Arrive at destination');
    expect(mid.timeRemainingMs).toBeCloseTo(60_000, -2);
  });

  it('declares arrival within the arrival radius', () => {
    const s = new NavigationSession(route());
    const end = s.update(pointAtAlong(routeTotal), 0).state;
    expect(end.status).toBe('arrived');
    expect(end.upcoming).toBeNull();
    expect(end.distanceRemainingM).toBeLessThanOrEqual(25);
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
});

describe('NavigationSession guards', () => {
  it('rejects an empty route', () => {
    expect(() => new NavigationSession({ ...route(), points: [] })).toThrow(/empty route/);
  });
});
