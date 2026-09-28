import type { LatLng } from '@atlas/core';
import type { RouteInstruction, RoutePath } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import { followZoom, remainingRouteBounds, zoomForSpeed } from './camera.js';
import {
  bearingDeg,
  cumulativeDistances,
  cumulativeLineMetrics,
  pointAtDistance,
  renderedLineProgress,
  snapToPolyline,
  snapToRoute,
  subPolyline,
} from './geometry.js';
import { maneuverArrowsGeoJSON } from './overlays.js';
import { laneGlyphs, laneLabel } from './lanes.js';
import { headingRateDegPerSec } from './sensors.js';
import { navOptionsForProfile } from './profiles.js';
import { DEFAULT_NAV_OPTIONS, FOLLOW_CAMERA_EASE_MS, navLineProgress } from './model.js';
import { NavigationSession } from './session.js';

// A straight eastward route at lat 60: 21 points, lng 10.000 → 10.020.
const routePoints: LatLng[] = Array.from({ length: 21 }, (_, i) => ({
  lat: 60,
  lng: 10 + i * 0.001,
}));
const routeCum = cumulativeDistances(routePoints);
const routeTotal = routeCum[routeCum.length - 1]!;

const instructions: RouteInstruction[] = [
  {
    text: 'Head east',
    distanceM: routeCum[10]!,
    timeMs: 60_000,
    sign: 0,
    streetName: 'Main Street',
    interval: [0, 10],
  },
  {
    text: 'Turn right onto Elm Street',
    distanceM: routeTotal - routeCum[10]!,
    timeMs: 60_000,
    sign: 2,
    streetName: 'Elm Street',
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

// A ~22 km eastbound leg on E18 followed by a short final turn. Long enough
// to exercise highway warning timing and the sustain banner state.
const longRoutePoints: LatLng[] = Array.from({ length: 21 }, (_, i) => ({
  lat: 60,
  lng: 10 + i * 0.02,
}));
const longRouteCum = cumulativeDistances(longRoutePoints);
const longTurnAlong = longRouteCum[18]!;
const longRoute: RoutePath = {
  points: longRoutePoints,
  distanceM: longRouteCum[20]!,
  timeMs: 900_000,
  ascentM: 0,
  descentM: 0,
  instructions: [
    {
      text: 'Head east on E18',
      distanceM: longTurnAlong,
      timeMs: 720_000,
      sign: 0,
      streetName: 'E18',
      interval: [0, 18],
    },
    {
      text: 'Take exit 43 toward Oslo',
      distanceM: longRouteCum[20]! - longTurnAlong,
      timeMs: 180_000,
      sign: 7,
      kind: 'exit',
      interval: [18, 20],
    },
    {
      text: 'Arrive at destination',
      distanceM: 0,
      timeMs: 0,
      sign: 4,
      interval: [20, 20],
    },
  ],
};

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

  it('names the road of the maneuver leg containing the position', () => {
    const s = new NavigationSession(route());
    expect(s.update(pointAtAlong(routeCum[5]!), 0).state.currentRoad).toBe('Main Street');
    expect(s.update(pointAtAlong(routeCum[15]!), 0).state.currentRoad).toBe('Elm Street');
    const bare = new NavigationSession(route(false));
    expect(bare.update(pointAtAlong(routeCum[5]!), 0).state.currentRoad).toBeNull();
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
    expect(p400[0]!.text).toBe('In 350 meters, Turn right onto Elm Street');

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

  it('expands the far warning and immediate cue by time at highway speed', () => {
    const fast = new NavigationSession(longRoute);
    const far = fast.update(
      {
        ...pointAtDistance(longRoutePoints, longRouteCum, longTurnAlong - 2900),
        speedMps: 30,
      },
      0,
    ).prompts;
    expect(far).toHaveLength(1);
    expect(far[0]).toMatchObject({ kind: 'approach', thresholdM: 3000 });
    expect(far[0]!.text).toBe('In 2.9 kilometers, Take exit 43 toward Oslo');

    // The early alert is not repeated at the ordinary approach band; the
    // pre-turn cue follows around 15 seconds out instead.
    expect(
      fast.update(
        {
          ...pointAtDistance(longRoutePoints, longRouteCum, longTurnAlong - 1000),
          speedMps: 30,
        },
        1000,
      ).prompts,
    ).toEqual([]);
    expect(
      fast.update(
        {
          ...pointAtDistance(longRoutePoints, longRouteCum, longTurnAlong - 430),
          speedMps: 30,
        },
        2000,
      ).prompts[0],
    ).toMatchObject({ kind: 'approach', thresholdM: 450 });

    // Four seconds at 30 m/s is 120 m: safely earlier than the old fixed 40 m.
    expect(
      fast.update(
        {
          ...pointAtDistance(longRoutePoints, longRouteCum, longTurnAlong - 110),
          speedMps: 30,
        },
        3000,
      ).prompts[0],
    ).toMatchObject({ kind: 'now' });
  });
});

describe('NavigationSession via stops (multi-stop trips)', () => {
  const viaAlong = routeCum[10]!;
  const viaRoute: RoutePath = {
    points: routePoints,
    distanceM: routeTotal,
    timeMs: 120_000,
    ascentM: 0,
    descentM: 0,
    instructions: [
      {
        text: 'Head east',
        distanceM: viaAlong,
        timeMs: 60_000,
        sign: 0,
        streetName: 'Main Street',
        interval: [0, 10],
      },
      {
        text: 'Arrive at via point',
        distanceM: 0,
        timeMs: 0,
        sign: 5,
        interval: [10, 10],
        verbal: {
          alert: 'You will arrive at your via point',
          pre: 'You will arrive at your via point',
          succinct: 'You have arrived at your via point',
        },
      },
      {
        text: 'Continue east',
        distanceM: routeTotal - viaAlong,
        timeMs: 60_000,
        sign: 0,
        streetName: 'Main Street',
        interval: [10, 20],
      },
      { text: 'Arrive at destination', distanceM: 0, timeMs: 0, sign: 4, interval: [20, 20] },
    ],
  };

  it('counts via stops as they are passed — the reroute drop signal', () => {
    const s = new NavigationSession(viaRoute);
    expect(s.update(pointAtAlong(routeCum[5]!), 0).state.viasPassed).toBe(0);
    // Just short of the stop still counts as ahead.
    expect(s.update(pointAtAlong(viaAlong - 30), 1000).state.viasPassed).toBe(0);
    expect(s.update(pointAtAlong(routeCum[12]!), 2000).state.viasPassed).toBe(1);
  });

  it('reads 0 for the whole of an ordinary single-destination trip', () => {
    const s = new NavigationSession(route());
    expect(s.update(pointAtAlong(routeCum[15]!), 0).state.viasPassed).toBe(0);
  });

  it('announces the via arrival through the ordinary prompt phases', () => {
    const s = new NavigationSession(viaRoute);
    const approach = s.update(pointAtAlong(viaAlong - 150), 0).prompts;
    expect(approach).toHaveLength(1);
    expect(approach[0]!.text).toBe('In 150 meters, You will arrive at your via point');
    const now = s.update(pointAtAlong(viaAlong - 10), 0).prompts;
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ kind: 'now', text: 'You have arrived at your via point' });
    // Passing the stop must not end the trip — guidance continues to the end.
    const after = s.update(pointAtAlong(routeCum[12]!), 0).state;
    expect(after.status).toBe('navigating');
    expect(after.upcoming?.instruction.sign).toBe(4);
  });
});

describe('navLineProgress', () => {
  it('preserves fine-grained progress instead of rounding by trip percentage', () => {
    expect(navLineProgress({ displayRouteProgress: 0.123_456 })).toBe(0.123_456);
  });

  it('defaults and clamps defensively', () => {
    expect(navLineProgress(null)).toBe(0);
    expect(navLineProgress({ displayRouteProgress: -0.2 })).toBe(0);
    expect(navLineProgress({ displayRouteProgress: 1.2 })).toBe(1);
    expect(navLineProgress({ displayRouteProgress: Number.NaN })).toBe(0);
  });
});

describe('renderedLineProgress', () => {
  it('uses MapLibre mercator length so grey ends at the puck on a northbound route', () => {
    const points: LatLng[] = [
      { lat: 0, lng: 10 },
      { lat: 60, lng: 10 },
      { lat: 80, lng: 10 },
    ];
    const distanceCum = cumulativeDistances(points);
    const lineMetricCum = cumulativeLineMetrics(points);
    const halfwayM = distanceCum.at(-1)! / 2;

    // Real metres put the puck halfway through the trip. Mercator stretches
    // the northern remainder, so that same coordinate is earlier on the line
    // MapLibre actually renders. Feeding MapLibre 0.5 would grey ahead of it.
    expect(halfwayM / distanceCum.at(-1)!).toBe(0.5);
    expect(renderedLineProgress(points, distanceCum, lineMetricCum, halfwayM)).toBeLessThan(0.4);

    const path: RoutePath = {
      points,
      distanceM: distanceCum.at(-1)!,
      timeMs: 60_000,
      ascentM: 0,
      descentM: 0,
      instructions: [],
    };
    const state = new NavigationSession(path, { startDeparted: true }).update(
      pointAtDistance(points, distanceCum, halfwayM),
      0,
    ).state;
    expect(state.routeProgress).toBeCloseTo(0.5, 8);
    expect(state.displayRouteProgress).toBeCloseTo(
      renderedLineProgress(points, distanceCum, lineMetricCum, halfwayM),
      8,
    );
  });

  it('keeps the endpoints exact and rejects unusable geometry', () => {
    const points: LatLng[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ];
    expect(renderedLineProgress(points, [0, 10], [0, 20], -1)).toBe(0);
    expect(renderedLineProgress(points, [0, 10], [0, 20], 11)).toBe(1);
    expect(renderedLineProgress(points.slice(0, 1), [0], [0], 0)).toBe(0);
    expect(renderedLineProgress(points, [0, 10], [0], 5)).toBe(0);
  });
});

describe('NavigationSession snapped state', () => {
  it('hugs the road for a near fix, keeping the raw fix as-is', () => {
    const s = new NavigationSession(route());
    // ~5 m north of the line: within even the pre-departure display bound.
    const fix = { lat: 60.000045, lng: 10.005 };
    const state = s.update(fix, 0).state;
    expect(state.raw).toEqual(fix);
    expect(state.snapped.lat).toBeCloseTo(60, 5);
    expect(state.offRouteM).toBeGreaterThan(3);
    expect(state.offRouteM).toBeLessThan(8);
  });

  it('shows the raw fix when a near fix is too coarse to trust the snap', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    // Same ~5 m offset that hugs the road above, but a coarse fix: its error
    // circle reaching the line is not proof the traveller is on it, so it must
    // sit at its own position rather than snap (the "snapped from the garden" bug).
    const fix = { lat: 60.000045, lng: 10.005, accuracyM: 50 };
    const state = s.update(fix, 0).state;
    expect(state.snapped).toEqual({ lat: fix.lat, lng: fix.lng });
    expect(state.status).toBe('navigating');
  });

  it('shows the raw fix before departure when standing off the road', () => {
    const s = new NavigationSession(route());
    // ~11 m off: driving display would snap this, but the trip has not begun.
    const fix = { lat: 60.0001, lng: 10.005 };
    const state = s.update(fix, 0).state;
    expect(state.departed).toBe(false);
    expect(state.snapped).toEqual(fix);
  });

  it('departs on driving speed and then snaps the same offset fix', () => {
    const s = new NavigationSession(route());
    const rolling = s.update({ ...pointAtAlong(100), speedMps: 8 }, 0).state;
    expect(rolling.departed).toBe(true);
    // 40 s later: the second fix is ~290 m further along, which at 8 m/s the
    // matcher's travel bound only allows this much time to cover.
    const state = s.update({ lat: 60.0001, lng: 10.007, speedMps: 1 }, 40_000).state;
    expect(state.departed).toBe(true);
    expect(state.snapped.lat).toBeCloseTo(60, 5);
  });

  it('departs on along-route progress even without speed data', () => {
    const s = new NavigationSession(route());
    expect(s.update(pointAtAlong(10), 0).state.departed).toBe(false);
    expect(s.update(pointAtAlong(50), 1000).state.departed).toBe(true);
  });

  it('shows the raw fix when well off the road even while departed', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    // ~33 m off: beyond snapDisplayMaxM but under the 40 m off-route bound.
    const fix = { lat: 60.0003, lng: 10.005 };
    const state = s.update(fix, 0).state;
    expect(state.departed).toBe(true);
    expect(state.snapped).toEqual(fix);
    expect(state.status).toBe('navigating');
  });

  it('shrinks display snapping to the receiver accuracy while preserving its cap', () => {
    const offset = { lat: 60.000135, lng: 10.005, speedMps: 8 };

    const precise = new NavigationSession(route(), { startDeparted: true }).update(
      { ...offset, accuracyM: 4 },
      0,
    );
    expect(precise.match?.snapCorridorM).toBe(12);
    expect(precise.state.snapped).toEqual({ lat: offset.lat, lng: offset.lng });

    const ordinary = new NavigationSession(route(), { startDeparted: true }).update(
      { ...offset, accuracyM: 10 },
      0,
    );
    expect(ordinary.match?.snapCorridorM).toBe(25);
    expect(ordinary.state.snapped.lat).toBeCloseTo(60, 5);
  });

  it('pins the travelled-line boundary to a raw puck rather than the biased match', () => {
    // The route returns west 11 m north of its eastbound leg. After matching
    // the return, continuity keeps guidance there even when the raw fix is
    // geometrically closer to the outbound leg.
    const points: LatLng[] = [
      { lat: 60, lng: 10 },
      { lat: 60, lng: 10.01 },
      { lat: 60.0001, lng: 10.01 },
      { lat: 60.0001, lng: 10 },
    ];
    const path: RoutePath = {
      points,
      distanceM: 0,
      timeMs: 60_000,
      ascentM: 0,
      descentM: 0,
      instructions: [],
    };
    const cum = cumulativeDistances(points);
    const s = new NavigationSession(path, { startDeparted: true });
    s.update({ lat: 60.0001, lng: 10.002, speedMps: 2, headingDeg: 270 }, 0);
    const raw = { lat: 60.00004, lng: 10.002, accuracyM: 50 };
    const state = s.update(raw, 1000).state;
    const nearest = snapToPolyline(raw, points, cum);

    expect(state.snapped).toEqual({ lat: raw.lat, lng: raw.lng });
    expect(state.routeProgress).toBeGreaterThan(0.5);
    expect(state.displayRouteProgress).toBeCloseTo(
      renderedLineProgress(points, cum, cumulativeLineMetrics(points), nearest.alongM),
      8,
    );
    expect(state.displayRouteProgress).toBeLessThan(0.5);
    expect(state.trailM).toBeCloseTo(nearest.alongM, 3);
    expect(state.trailM).toBeLessThan(state.traveledM);
  });

  it('projects the shown position ahead at speed, leaving guidance math honest', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    const state = s.update({ ...pointAtAlong(200), speedMps: 20 }, 0).state;
    // The shared 800 ms follow-camera ease is the only compensated latency,
    // so 20 m/s puts the display target 16 m ahead of the fresh fix.
    expect(DEFAULT_NAV_OPTIONS.predictAheadMs).toBe(FOLLOW_CAMERA_EASE_MS);
    const displayAlongM = 200 + 20 * (FOLLOW_CAMERA_EASE_MS / 1000);
    const expected = pointAtAlong(displayAlongM);
    expect(state.snapped.lng).toBeCloseTo(expected.lng, 5);
    expect(state.traveledM).toBeCloseTo(200, 0);
    expect(state.trailM).toBeCloseTo(200, 0);
    expect(state.trailM).toBeLessThan(displayAlongM);
    expect(state.routeProgress).toBeCloseTo(200 / routeTotal, 5);
    expect(state.displayRouteProgress).toBeCloseTo(displayAlongM / routeTotal, 5);
    const still = new NavigationSession(route(), { startDeparted: true });
    const noSpeed = still.update(pointAtAlong(200), 0).state;
    expect(noSpeed.snapped.lng).toBeCloseTo(pointAtAlong(200).lng, 5);
    expect(noSpeed.displayRouteProgress).toBeCloseTo(noSpeed.routeProgress, 10);
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

  it('ramps monotonically toward the intersection zoom as the turn nears', () => {
    const far = followZoom(25, 60, 290);
    const mid = followZoom(25, 60, 200);
    const near = followZoom(25, 60, 100);
    expect(far).toBeGreaterThanOrEqual(zoomForSpeed(25, 60));
    expect(mid).toBeGreaterThanOrEqual(far);
    expect(near).toBeGreaterThanOrEqual(mid);
    // Full intersection zoom only once the turn fits on-screen (last ~60 m) —
    // leaning in harder would scroll the turn itself off the top.
    expect(near).toBeLessThan(17.5);
    expect(followZoom(25, 60, 40)).toBe(17.5);
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

describe('NavigationSession GPS accuracy', () => {
  const offPoint = { lat: 60.001, lng: 10.01 }; // ~110 m off the line

  it('never counts poor-accuracy fixes toward off-route', () => {
    const s = new NavigationSession(route());
    // Urban-canyon fixes: far off the line but with a large error radius.
    for (let i = 0; i < 6; i++) {
      expect(s.update({ ...offPoint, accuracyM: 80 }, i * 1000).state.status).toBe('navigating');
    }
    // Accurate off-route fixes still trip detection at the usual grace count.
    s.update({ ...offPoint, accuracyM: 10 }, 7000);
    s.update({ ...offPoint, accuracyM: 10 }, 8000);
    expect(s.update({ ...offPoint, accuracyM: 10 }, 9000).state.status).toBe('off-route');
  });

  it('shrinks the off-route corridor for a precise fix but never grows its cap', () => {
    const precise = new NavigationSession(route(), { startDeparted: true });
    // ~18 m from the line: outside 4 × 4 m, but well inside the old 40 m cap.
    const offset = { lat: 60.00016, lng: 10.01, accuracyM: 4, speedMps: 10 };
    expect(precise.update(offset, 0).match?.corridorM).toBe(16);
    precise.update(offset, 1000);
    expect(precise.update(offset, 2000).state.status).toBe('off-route');

    const coarse = new NavigationSession(route(), { startDeparted: true });
    const samePlace = { ...offset, accuracyM: 20 };
    for (let t = 0; t < 5; t++) {
      const update = coarse.update(samePlace, t * 1000);
      expect(update.match?.corridorM).toBe(40);
      expect(update.state.status).toBe('navigating');
    }
  });

  it('keeps a diverging accurate exit outside the scaled corridor as it curves back', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    const offsetsM = [8.8, 25, 49.6, 30.6];
    const states = offsetsM.map((northM, i) =>
      s.update(
        {
          ...pointAtAlong(200 + i * 20),
          lat: 60 + northM / 111_320,
          accuracyM: 4,
          speedMps: 20,
          headingDeg: 90,
        },
        i * 1000,
      ),
    );
    expect(states.map((update) => update.match?.corridorM)).toEqual([16, 16, 16, 16]);
    // The final 30.6 m sample used to reset a 40 m threshold after the 49.6 m
    // peak. At receiver-scale it is still plainly a different road.
    expect(states.at(-1)!.state.status).toBe('off-route');
  });

  it('ignores hopeless fixes entirely, holding the last state', () => {
    const s = new NavigationSession(route());
    const good = s.update({ ...pointAtAlong(500), accuracyM: 10 }, 0).state;
    // A 500 m error radius fix far away must not teleport the puck.
    const junk = s.update({ lat: 60.01, lng: 10, accuracyM: 500 }, 1000).state;
    expect(junk.snapped).toEqual(good.snapped);
    expect(junk.traveledM).toBeCloseTo(good.traveledM, 5);
  });

  it('recovers on a coarse fix once the signal is lost, rather than staying greyed', () => {
    const s = new NavigationSession(route());
    // Drive, lose signal (no speed to reckon with), go `lost`.
    s.update({ ...pointAtAlong(100), speedMps: 0, accuracyM: 10 }, 0);
    expect(s.tick(6000)!.state.fix).toBe('lost');
    // Emerging from the tunnel the phone re-locks but its first fix is coarse
    // (> discardAccuracyM). It must un-grey the puck instead of being ignored
    // until a sub-100 m fix finally lands seconds later.
    const back = s.update({ ...pointAtAlong(140), accuracyM: 150 }, 7000).state;
    expect(back.fix).toBe('live');
    expect(back.traveledM).toBeCloseTo(140, 0);
  });

  it('still holds the last state for a coarse fix while the signal is good', () => {
    const s = new NavigationSession(route());
    const good = s.update({ ...pointAtAlong(500), accuracyM: 10 }, 0).state;
    // Not lost — a lone coarse fix is still noise to coast through, not recover on.
    const held = s.update({ ...pointAtAlong(900), accuracyM: 150 }, 1000).state;
    expect(held.fix).toBe('live');
    expect(held.traveledM).toBeCloseTo(good.traveledM, 5);
  });

  it('does not anchor guidance to a garbage cold-start fix', () => {
    const s = new NavigationSession(route());
    // A hopeless first fix must not become the origin of guidance; show a
    // provisional greyed puck at the raw point instead.
    const first = s.update({ ...pointAtAlong(100), accuracyM: 500 }, 0).state;
    expect(first.fix).toBe('lost');
    expect(first.traveledM).toBe(0);
    // The next usable fix is still treated as the first, initializing normally.
    const good = s.update({ ...pointAtAlong(100), accuracyM: 10 }, 1000).state;
    expect(good.fix).toBe('live');
    expect(good.traveledM).toBeCloseTo(100, 0);
  });
});

describe('NavigationSession arrival gating', () => {
  it('will not declare arrival from a poor fix', () => {
    const s = new NavigationSession(route());
    // Drifted into the arrival radius but with a 60 m error radius — too
    // uncertain to tear the trip down.
    const poor = s.update({ ...pointAtAlong(routeTotal), accuracyM: 60 }, 0).state;
    expect(poor.status).toBe('navigating');
    // An accurate fix in the radius does arrive.
    const good = s.update({ ...pointAtAlong(routeTotal), accuracyM: 10 }, 1000).state;
    expect(good.status).toBe('arrived');
  });

  // The gate above is right but had no escape hatch, and the destination is
  // exactly where fixes go bad — car parks, courtyards, urban canyons.
  it('arrives on stopping near the destination even with a fix that never gets accurate', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    // 50 m out: inside the loiter radius, far outside `arrivalRadiusM`, and
    // every fix too poor for the primary rule.
    const parked = { ...pointAtAlong(routeTotal - 50), speedMps: 0, accuracyM: 70 };
    expect(s.update(parked, 0).state.status).toBe('navigating');
    expect(s.update(parked, 10_000).state.status).toBe('navigating');
    expect(s.update(parked, 19_000).state.status).toBe('navigating');
    expect(s.update(parked, 20_000).state.status).toBe('arrived');
  });

  it('a drifting fix cannot fake it — still moving restarts the clock', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    const drifting = { ...pointAtAlong(routeTotal - 50), speedMps: 5, accuracyM: 70 };
    for (let t = 0; t <= 60_000; t += 5000) {
      expect(s.update(drifting, t).state.status).toBe('navigating');
    }
  });

  it('does not loiter-arrive while stopped short of the destination', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    // A red light 300 m out — well outside the loose radius.
    const light = { ...pointAtAlong(routeTotal - 300), speedMps: 0, accuracyM: 10 };
    for (let t = 0; t <= 60_000; t += 5000) {
      expect(s.update(light, t).state.status).toBe('navigating');
    }
  });

  it('lets the traveller declare arrival by hand', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    s.update({ ...pointAtAlong(routeTotal - 200), speedMps: 0, accuracyM: 80 }, 0);
    const state = s.declareArrived();
    expect(state?.status).toBe('arrived');
    expect(state?.routeProgress).toBe(1);
    expect(state?.upcoming).toBeNull();
    // It sticks: the next fix does not resurrect the trip.
    const next = s.update({ ...pointAtAlong(routeTotal - 200), speedMps: 0, accuracyM: 10 }, 1000);
    expect(next.state.status).toBe('arrived');
    expect(next.prompts).toEqual([]);
  });
});

describe('NavigationSession wrong-way detection', () => {
  const legMps = routeCum[10]! / 60;

  it('trips off-route when the heading opposes the route while moving', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    // On the eastbound line but driving west (heading 270°): cross-track ≈ 0.
    const back = { ...pointAtAlong(routeCum[10]!), speedMps: legMps, headingDeg: 270 };
    expect(s.update(back, 0).state.status).toBe('navigating'); // 1 of 3
    expect(s.update(back, 1000).state.status).toBe('navigating'); // 2 of 3
    expect(s.update(back, 2000).state.status).toBe('off-route');
  });

  it('stays navigating when the heading follows the route', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    const fwd = { ...pointAtAlong(routeCum[10]!), speedMps: legMps, headingDeg: 90 };
    for (let t = 0; t < 5; t++) expect(s.update(fwd, t * 1000).state.status).toBe('navigating');
  });

  it('ignores an opposing heading from a poor-accuracy fix', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    const back = {
      ...pointAtAlong(routeCum[10]!),
      speedMps: legMps,
      headingDeg: 270,
      accuracyM: 80,
    };
    for (let t = 0; t < 5; t++) expect(s.update(back, t * 1000).state.status).toBe('navigating');
  });

  it('ignores an opposing car-park heading below driving speed', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    const manoeuvring = {
      ...pointAtAlong(routeCum[10]!),
      speedMps: 2.3,
      headingDeg: 270,
      accuracyM: 4,
    };
    for (let t = 0; t < 8; t++) {
      const update = s.update(manoeuvring, t * 1000);
      expect(update.match?.wrongWayCount).toBe(0);
      expect(update.state.status).toBe('navigating');
    }
  });

  it('requires departure before an opposing heading can count', () => {
    const s = new NavigationSession(route(), {
      departMinSpeedMps: 10,
      departProgressM: 100,
      wrongWayMinSpeedMps: 5,
    });
    const notDeparted = {
      ...pointAtAlong(20),
      speedMps: 6,
      headingDeg: 270,
      accuracyM: 4,
    };
    for (let t = 0; t < 5; t++) {
      const update = s.update(notDeparted, t * 1000);
      expect(update.state.departed).toBe(false);
      expect(update.match?.wrongWayCount).toBe(0);
    }
  });
});

describe('NavigationSession route-progress stall', () => {
  const atMetres = (eastM: number, northM: number): LatLng => ({
    lat: 60 + northM / 111_320,
    lng: 10 + eastM / (111_320 * Math.cos(Math.PI / 3)),
  });
  // The planned line goes east, makes a tight U-turn 12 m north, then comes
  // west. Once continuity pins matching to the first leg, a car genuinely on
  // the return aisle can cover ground while matched progress cannot catch up.
  const doubledPoints = [atMetres(0, 0), atMetres(200, 0), atMetres(200, 12), atMetres(0, 12)];
  const doubled: RoutePath = {
    points: doubledPoints,
    distanceM: 412,
    timeMs: 60_000,
    ascentM: 0,
    descentM: 0,
    instructions: [],
  };

  it('declares off-route when measured motion outruns matched progress for four seconds', () => {
    const s = new NavigationSession(doubled, { startDeparted: true, wrongWayDeg: Infinity });
    // Establish the outbound leg without starting moving evidence.
    s.update({ ...atMetres(100, 0), accuracyM: 4, speedMps: 0 }, 0);

    const updates = Array.from({ length: 5 }, (_, i) =>
      s.update(
        {
          ...atMetres(100 - i * 6, 12),
          accuracyM: 4,
          speedMps: 8,
          headingDeg: 270,
        },
        (i + 1) * 1000,
      ),
    );
    const final = updates.at(-1)!;
    expect(updates.slice(0, -1).map((update) => update.state.status)).not.toContain('off-route');
    expect(final.match).toMatchObject({
      progressStalled: true,
      stallDurationMs: 4000,
    });
    expect(final.match!.stallGroundM).toBeGreaterThanOrEqual(19.9);
    expect(final.match!.stallProgressM).toBeLessThan(8);
    expect(final.match!.crossTrackM).toBeLessThan(final.match!.corridorM);
    expect(final.state.status).toBe('off-route');
  });

  it('does not call ordinary forward movement a stall', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    for (let t = 0; t <= 5; t++) {
      const update = s.update(
        { ...pointAtAlong(100 + t * 10), accuracyM: 4, speedMps: 10, headingDeg: 90 },
        t * 1000,
      );
      expect(update.match?.progressStalled).toBe(false);
      expect(update.state.status).toBe('navigating');
    }
  });

  it('does not bridge a receiver gap into a false sustained stall', () => {
    const s = new NavigationSession(doubled, { startDeparted: true, wrongWayDeg: Infinity });
    s.update({ ...atMetres(100, 0), accuracyM: 4, speedMps: 0 }, 0);
    s.update({ ...atMetres(100, 12), accuracyM: 4, speedMps: 8, headingDeg: 270 }, 1000);
    const afterGap = s.update(
      { ...atMetres(70, 12), accuracyM: 4, speedMps: 8, headingDeg: 270 },
      6000,
    );
    expect(afterGap.match).toMatchObject({ progressStalled: false, stallDurationMs: 0 });
    expect(afterGap.state.status).toBe('navigating');
  });
});

// A mini-roundabout: 100 m approach east → a full ring of radius `RA_R` taken
// counter-clockwise → 100 m exit. The tightest geometry a route course has to
// survive: the ring is barely longer than `courseAt`'s window, so a window
// that reached forward instead of sitting centred would cut across the island
// and read as driving into the traffic.
const RA_R = 5;
const RA_APPROACH_M = 100;
const RA_ARC = 2 * Math.PI;
const RA_RING_M = RA_R * RA_ARC;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((60 * Math.PI) / 180);

function raPoint(x: number, y: number): LatLng {
  return { lat: 60 + y / M_PER_DEG_LAT, lng: 10 + x / M_PER_DEG_LNG };
}

/** Position and true kerb heading `s` metres into the roundabout route. */
function raAt(s: number): { pos: LatLng; headingDeg: number } {
  if (s <= RA_APPROACH_M) {
    return { pos: raPoint(-RA_R - (RA_APPROACH_M - s), 0), headingDeg: 90 };
  }
  const ring = Math.min(s - RA_APPROACH_M, RA_RING_M);
  const a = Math.PI + ring / RA_R;
  // CCW tangent of (cos a, sin a) is (−sin a, cos a); bearing measures from north.
  const heading = ((Math.atan2(-Math.sin(a), Math.cos(a)) * 180) / Math.PI + 360) % 360;
  if (s - RA_APPROACH_M <= RA_RING_M) {
    return { pos: raPoint(RA_R * Math.cos(a), RA_R * Math.sin(a)), headingDeg: heading };
  }
  const past = s - RA_APPROACH_M - RA_RING_M;
  const tx = -Math.sin(a);
  const ty = Math.cos(a);
  return {
    pos: raPoint(RA_R * Math.cos(a) + tx * past, RA_R * Math.sin(a) + ty * past),
    headingDeg: heading,
  };
}

/** The roundabout route, with the ring leg optionally signed as a roundabout. */
function roundaboutRoute(ringSign: number): RoutePath {
  const pts: LatLng[] = [];
  for (let d = 0; d < RA_APPROACH_M; d += 5) pts.push(raAt(d).pos);
  const ringFirst = pts.length;
  for (let s = 0; s <= RA_RING_M; s += 1) pts.push(raAt(RA_APPROACH_M + s).pos);
  const exitFirst = pts.length;
  for (let d = 1; d <= 100; d += 5) pts.push(raAt(RA_APPROACH_M + RA_RING_M + d).pos);
  return {
    points: pts,
    distanceM: 0,
    timeMs: 60_000,
    ascentM: 0,
    descentM: 0,
    instructions: [
      {
        text: 'Head east',
        distanceM: RA_APPROACH_M,
        timeMs: 20_000,
        sign: 0,
        interval: [0, ringFirst],
      },
      {
        text: 'Take the third exit',
        distanceM: RA_RING_M,
        timeMs: 20_000,
        sign: ringSign,
        interval: [ringFirst, exitFirst],
      },
      {
        text: 'Continue',
        distanceM: 100,
        timeMs: 20_000,
        sign: 0,
        interval: [exitFirst, pts.length - 1],
      },
    ],
  };
}

describe('NavigationSession wrong-way in a roundabout', () => {
  /** Drive from `fromM` to `toM` at `speed`, returning every status seen. */
  function drive(path: RoutePath, fromM: number, toM: number, speed: number, backwards = false) {
    const s = new NavigationSession(path, { startDeparted: true });
    const seen: string[] = [];
    for (let t = 0; ; t++) {
      const along = fromM + speed * t;
      if (along > toM) break;
      const { pos, headingDeg } = raAt(along);
      seen.push(
        s.update(
          {
            ...pos,
            speedMps: speed,
            headingDeg: backwards ? (headingDeg + 180) % 360 : headingDeg,
            accuracyM: 5,
          },
          t * 1000,
        ).state.status,
      );
    }
    return seen;
  }

  it('does not reroute a driver going correctly round a mini-roundabout', () => {
    const seen = drive(roundaboutRoute(6), RA_APPROACH_M, RA_APPROACH_M + RA_RING_M, 4);
    expect(seen).not.toContain('off-route');
  });

  it('holds even unsigned, because the course window no longer cuts the island', () => {
    // Belt and braces: the roundabout sign suppresses the wrong-way check, but
    // a centred course window means the ring reads correctly without it too.
    const seen = drive(roundaboutRoute(0), RA_APPROACH_M, RA_APPROACH_M + RA_RING_M, 4);
    expect(seen).not.toContain('off-route');
  });

  it('reports the kerb heading, not a chord across the ring', () => {
    const s = new NavigationSession(roundaboutRoute(6), { startDeparted: true });
    // A quarter of the way round, heading is the tangent there — a forward
    // chord would have been most of a lap out.
    const at = raAt(RA_APPROACH_M + RA_RING_M / 4);
    const course = s.update({ ...at.pos, speedMps: 4, accuracyM: 5 }, 0).state.courseDeg;
    expect(Math.abs(((course! - at.headingDeg + 540) % 360) - 180)).toBeLessThan(20);
  });

  it('still catches a genuine wrong-way drive on the road after the ring', () => {
    const path = roundaboutRoute(6);
    const exitM = RA_APPROACH_M + RA_RING_M;
    const seen = drive(path, exitM + 20, exitM + 90, 8, true);
    expect(seen).toContain('off-route');
  });
});

describe('NavigationSession tick: dead reckoning and signal loss', () => {
  it('returns null while fixes are flowing', () => {
    const s = new NavigationSession(route());
    expect(s.tick(0)).toBeNull(); // before the first fix
    s.update({ ...pointAtAlong(200), speedMps: 20 }, 0);
    expect(s.tick(1000)).toBeNull(); // within the gap tolerance
  });

  it('extrapolates along-route through a gap, anchored at the last fix', () => {
    const s = new NavigationSession(route());
    // Driving at the leg's own expected speed, so the speed blend is identity.
    const legMps = routeCum[10]! / 60;
    s.update({ ...pointAtAlong(200), speedMps: legMps }, 0);
    const est = s.tick(5000);
    expect(est).not.toBeNull();
    expect(est!.state.fix).toBe('estimated');
    expect(est!.state.status).toBe('navigating');
    expect(est!.state.traveledM).toBeCloseTo(200 + legMps * 5, 0);
    // Anchored at the fix, not compounding: 10 s of gap = 10 s of travel.
    expect(s.tick(10_000)!.state.traveledM).toBeCloseTo(200 + legMps * 10, 0);
  });

  it('eases the extrapolation speed toward the leg expected pace', () => {
    const s = new NavigationSession(route());
    s.setEnrichment({ segments: [{ startM: 0, endM: routeTotal, tunnel: true }] });
    const legMps = routeCum[10]! / 60; // ≈9.3 m/s expected on leg 1
    s.update({ ...pointAtAlong(200), speedMps: 20 }, 0);
    // 20 s in, the reckoned distance sits between pure last-speed (which would
    // overshoot after a limit drop) and pure leg-pace extrapolation.
    const est = s.tick(20_000)!;
    expect(est.state.traveledM).toBeGreaterThan(200 + legMps * 20);
    expect(est.state.traveledM).toBeLessThan(200 + 20 * 20);
  });

  it('keeps firing voice prompts from extrapolated positions', () => {
    const s = new NavigationSession(route());
    s.setEnrichment({ segments: [{ startM: 0, endM: routeTotal, tunnel: true }] });
    const maneuverAlong = routeCum[10]!;
    expect(s.update({ ...pointAtAlong(maneuverAlong - 513), speedMps: 8 }, 0).prompts).toEqual([]);
    // 15 s later the estimated position is inside the 400 m alert band.
    const est = s.tick(15_000)!;
    expect(est.prompts).toHaveLength(1);
    expect(est.prompts[0]).toMatchObject({ kind: 'approach', thresholdM: 400 });
  });

  it('never declares arrival from extrapolation alone', () => {
    const s = new NavigationSession(route());
    s.update({ ...pointAtAlong(routeTotal - 300), speedMps: 30 }, 0);
    const est = s.tick(60_000)!; // would be 1.8 km past the destination
    expect(est.state.status).toBe('navigating');
    expect(est.state.distanceRemainingM).toBeGreaterThan(0);
  });

  it('reports signal-lost when stationary fixes stop', () => {
    const s = new NavigationSession(route());
    s.update({ ...pointAtAlong(100), speedMps: 0 }, 0);
    expect(s.tick(4000)).toBeNull(); // gapped but not yet lost
    const lost = s.tick(6000);
    expect(lost).not.toBeNull();
    expect(lost!.state.fix).toBe('lost');
    expect(lost!.state.traveledM).toBeCloseTo(100, 0);
  });

  it('keeps reckoning through coarse stationary fixes inside a mapped tunnel', () => {
    const s = new NavigationSession(route());
    s.setEnrichment({ segments: [{ startM: 0, endM: routeTotal, tunnel: true }] });
    const legMps = routeCum[10]! / 60;
    s.update({ ...pointAtAlong(200), speedMps: legMps, accuracyM: 5 }, 0);
    // Into the tunnel: the fused provider keeps emitting "parked here, ±60 m"
    // once a second. Accepting one used to re-anchor the session and freeze the
    // puck; now they are refused and the extrapolation carries on.
    let last = s.update({ ...pointAtAlong(200), speedMps: 0, accuracyM: 60 }, 5000);
    expect(last.state.fix).toBe('estimated');
    expect(last.state.traveledM).toBeCloseTo(200 + legMps * 5, 0);
    last = s.update({ ...pointAtAlong(200), speedMps: 0, accuracyM: 60 }, 60_000);
    expect(last.state.fix).toBe('estimated');
    expect(last.state.traveledM).toBeCloseTo(200 + legMps * 60, 0);
    // Out the far end: an accurate fix re-anchors immediately.
    const out = s.update({ ...pointAtAlong(900), speedMps: legMps, accuracyM: 6 }, 70_000);
    expect(out.state.fix).toBe('live');
    expect(out.state.traveledM).toBeCloseTo(900, 0);
  });

  it('honours an accurate stop — a queue is not a tunnel', () => {
    const s = new NavigationSession(route());
    s.update({ ...pointAtAlong(200), speedMps: 20, accuracyM: 5 }, 0);
    const stopped = s.update({ ...pointAtAlong(210), speedMps: 0, accuracyM: 8 }, 5000);
    expect(stopped.state.fix).toBe('live');
    expect(stopped.state.traveledM).toBeCloseTo(210, 0);
  });

  it('lets a coarse fix re-anchor once the signal is genuinely lost', () => {
    const s = new NavigationSession(route());
    s.update({ ...pointAtAlong(100), speedMps: 20, accuracyM: 5 }, 0);
    expect(s.tick(1_250_000)!.state.fix).toBe('lost'); // past the time backstop
    const back = s.update({ ...pointAtAlong(400), speedMps: 0, accuracyM: 60 }, 1_251_000);
    expect(back.state.fix).toBe('live');
    expect(back.state.traveledM).toBeCloseTo(400, 0);
  });

  it('gives up dead reckoning after the time backstop', () => {
    const s = new NavigationSession(route());
    s.update({ ...pointAtAlong(100), speedMps: 20 }, 0);
    expect(s.tick(1_250_000)!.state.fix).toBe('lost');
  });

  it('does not treat an unmapped receiver failure as a Lærdal-length tunnel', () => {
    // A ~33 km straight route (Lærdal-scale) driven at its expected speed, but
    // with no tunnel evidence attached to it.
    const points: LatLng[] = Array.from({ length: 21 }, (_, i) => ({
      lat: 60,
      lng: 10 + i * 0.03,
    }));
    const totalM = cumulativeDistances(points).at(-1)!;
    const s = new NavigationSession({
      points,
      distanceM: totalM,
      timeMs: (totalM / 30) * 1000,
      ascentM: 0,
      descentM: 0,
    });
    s.update({ ...points[0]!, speedMps: 30 }, 0);
    expect(s.tick(5_000)!.state.fix).toBe('estimated');
    const lost = s.tick(11_000)!;
    expect(lost.state.fix).toBe('lost');
    expect(lost.state.traveledM).toBeCloseTo(0, 0);
    expect(lost.state.raw).toEqual(points[0]);
  });

  it('never projects from an off-route fix and preserves its evidence when signal is lost', () => {
    const s = new NavigationSession(route(), { offRouteGraceUpdates: 1 });
    const raw = { ...pointAtAlong(200), lat: pointAtAlong(200).lat + 0.002, speedMps: 20 };
    const off = s.update(raw, 0).state;
    expect(off.status).toBe('off-route');
    expect(off.offRouteM).toBeGreaterThan(100);

    const lost = s.tick(6_000)!.state;
    expect(lost.fix).toBe('lost');
    expect(lost.status).toBe('off-route');
    expect(lost.raw).toEqual({ lat: raw.lat, lng: raw.lng });
    expect(lost.snapped).toEqual({ lat: raw.lat, lng: raw.lng });
    expect(lost.offRouteM).toBe(off.offRouteM);
    expect(lost.traveledM).toBe(off.traveledM);
  });
});

describe('NavigationSession wrong-branch detection (gyro)', () => {
  const legMps = routeCum[10]! / 60;

  function tunnelSession(): NavigationSession {
    const session = new NavigationSession(route());
    session.setEnrichment({ segments: [{ startM: 0, endM: routeTotal, tunnel: true }] });
    return session;
  }

  it('raises wrongBranch with one alert when the vehicle turns off a straight reckoned route', () => {
    const s = tunnelSession();
    s.update({ ...pointAtAlong(200), speedMps: legMps }, 0);
    expect(s.tick(5000)!.state.wrongBranch).toBe(false);
    // The gyro reports a 90° turn while the assumed route runs dead straight.
    for (let i = 0; i < 10; i++) s.reportHeadingDelta(9);
    // A bend transient must not trigger — the divergence has to persist.
    expect(s.tick(6000)!.state.wrongBranch).toBe(false);
    for (let t = 7; t <= 9; t++) expect(s.tick(t * 1000)!.state.wrongBranch).toBe(false);
    const est = s.tick(10_000)!; // 5th consecutive divergent tick
    expect(est.state.wrongBranch).toBe(true);
    expect(est.prompts.some((p) => p.kind === 'alert')).toBe(true);
    // The alert speaks once, but the flag holds for the rest of the gap.
    const later = s.tick(11_000)!;
    expect(later.state.wrongBranch).toBe(true);
    expect(later.prompts.filter((p) => p.kind === 'alert')).toHaveLength(0);
  });

  it('ignores heading reports while live fixes are flowing', () => {
    const s = tunnelSession();
    s.update({ ...pointAtAlong(200), speedMps: legMps }, 0);
    for (let i = 0; i < 10; i++) s.reportHeadingDelta(9); // dropped: fix is live
    expect(s.tick(5000)!.state.wrongBranch).toBe(false);
  });

  it('clears the flag and starts over on the next live fix', () => {
    const s = tunnelSession();
    s.update({ ...pointAtAlong(200), speedMps: legMps }, 0);
    s.tick(5000);
    for (let i = 0; i < 10; i++) s.reportHeadingDelta(9);
    for (let t = 6; t <= 10; t++) s.tick(t * 1000);
    expect(s.tick(11_000)!.state.wrongBranch).toBe(true);
    const live = s.update({ ...pointAtAlong(300), speedMps: legMps }, 12_000);
    expect(live.state.wrongBranch).toBe(false);
    // A fresh gap needs fresh divergence — the old 90° is forgotten.
    for (let t = 17; t <= 23; t++) expect(s.tick(t * 1000)!.state.wrongBranch).toBe(false);
  });

  it('stays quiet when the gyro matches the route bends', () => {
    // An L-shaped route: ~560 m east, then a 90° left turn heading north.
    const points: LatLng[] = [
      ...Array.from({ length: 11 }, (_, i) => ({ lat: 60, lng: 10 + i * 0.001 })),
      ...Array.from({ length: 10 }, (_, i) => ({ lat: 60.001 + i * 0.001, lng: 10.01 })),
    ];
    const totalM = cumulativeDistances(points).at(-1)!;
    const s = new NavigationSession({
      points,
      distanceM: totalM,
      timeMs: (totalM / 15) * 1000,
      ascentM: 0,
      descentM: 0,
    });
    s.update({ ...points[0]!, speedMps: 15 }, 0);
    // A perfect gyro reports exactly the course change the route imposes.
    let prevCourse: number | null = null;
    for (let t = 4; t <= 60; t++) {
      const est = s.tick(t * 1000);
      expect(est!.state.wrongBranch).toBe(false);
      const course = est!.state.courseDeg;
      if (prevCourse !== null && course !== null) {
        const d = ((course - prevCourse + 540) % 360) - 180;
        s.reportHeadingDelta(d);
      }
      prevCourse = course;
    }
  });
});

describe('headingRateDegPerSec', () => {
  // DeviceMotion reports gravity pointing down: screen up and flat is -z.
  it('projects yaw about the vertical for a flat-mounted device', () => {
    // Screen up, rotating counterclockwise seen from above → bearing falls.
    expect(headingRateDegPerSec({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -9.81 })).toBeCloseTo(-10);
    // ...and clockwise → bearing grows.
    expect(headingRateDegPerSec({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: -9.81 })).toBeCloseTo(10);
  });

  it('is mount-agnostic: one right turn reads the same portrait or landscape', () => {
    // Upright portrait in a cradle: the top edge (+y) points at the sky, so
    // the world vertical is device -y and a right turn is -y rotation.
    expect(headingRateDegPerSec({ x: 0, y: -10, z: 0 }, { x: 0, y: -9.81, z: 0 })).toBeCloseTo(10);
    // Rotation about the other axes (pitch/roll in this mount) is not a turn.
    expect(headingRateDegPerSec({ x: 15, y: 0, z: 0 }, { x: 0, y: -9.81, z: 0 })).toBeCloseTo(0);
    // Same cradle turned to landscape (+x now points at the ground): the same
    // physical right turn, and the same reading — nothing rotates the raw
    // sensor frame with the screen, and the projection needs no orientation.
    expect(headingRateDegPerSec({ x: 10, y: 0, z: 0 }, { x: 9.81, y: 0, z: 0 })).toBeCloseTo(10);
    expect(headingRateDegPerSec({ x: 0, y: 15, z: 0 }, { x: 9.81, y: 0, z: 0 })).toBeCloseTo(0);
    // Tilted back 45° in the cradle — still the same turn.
    const s = 9.81 / Math.SQRT2;
    expect(headingRateDegPerSec({ x: 0, y: -7.07, z: 7.07 }, { x: 0, y: -s, z: s })).toBeCloseTo(
      10,
    );
  });

  it('returns null when the accelerometer is far from 1 g', () => {
    expect(headingRateDegPerSec({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -0.5 })).toBeNull();
    expect(headingRateDegPerSec({ x: 0, y: 0, z: 10 }, { x: -9, y: -9, z: -9 })).toBeNull();
  });
});

describe('NavigationSession stable ETA', () => {
  it('keeps the arrival estimate steady while progress matches the route plan', () => {
    const s = new NavigationSession(route());
    const start = s.update(pointAtAlong(0), 1_000_000).state;
    const halfwayThroughFirstLeg = s.update(pointAtAlong(routeCum[5]!), 1_030_000).state;

    expect(halfwayThroughFirstLeg.timeRemainingMs).toBeCloseTo(90_000, -2);
    expect(halfwayThroughFirstLeg.etaEpochMs).toBeCloseTo(start.etaEpochMs, -2);
  });

  it('adds only the delay incurred at a traffic light', () => {
    const halfHourRoute: RoutePath = {
      ...longRoute,
      timeMs: 1_800_000,
      instructions: [
        {
          ...longRoute.instructions![0]!,
          timeMs: 1_500_000,
        },
        {
          ...longRoute.instructions![1]!,
          timeMs: 300_000,
        },
        longRoute.instructions![2]!,
      ],
    };
    const s = new NavigationSession(halfHourRoute);
    const atLight = {
      ...pointAtDistance(longRoutePoints, longRouteCum, longRouteCum[2]!),
      speedMps: 0,
    };
    const before = s.update(atLight, 1_000_000).state;
    let after = before;
    for (let t = 10_000; t <= 60_000; t += 10_000) {
      after = s.update(atLight, 1_000_000 + t).state;
    }

    // No progress means the route itself still needs the same driving time.
    // Only the arrival clock moves by the minute actually spent waiting.
    expect(after.timeRemainingMs).toBeCloseTo(before.timeRemainingMs, -2);
    expect(after.etaEpochMs - before.etaEpochMs).toBeCloseTo(60_000, -2);
    expect(after.timeRemainingMs).toBeLessThan(before.timeRemainingMs * 1.01);
  });
});

describe('NavigationSession setSchedule (re-pricing a running trip)', () => {
  /** The same route, with a 3-minute jam charged to the second leg. */
  const jammed: RoutePath = {
    ...route(),
    timeMs: 300_000,
    trafficDelayMs: 180_000,
    instructions: [
      instructions[0]!,
      { ...instructions[1]!, timeMs: 240_000, trafficDelayMs: 180_000 },
      instructions[2]!,
    ],
  };

  it('moves the ETA without restarting the trip', () => {
    const s = new NavigationSession(route());
    const before = s.update(pointAtAlong(0), 1_000_000).state;
    expect(before.timeRemainingMs).toBeCloseTo(120_000, -3);
    expect(before.trafficDelayMs).toBe(0);

    const after = s.setSchedule(jammed, 1_000_000)!;
    expect(after.timeRemainingMs).toBeCloseTo(300_000, -3);
    expect(after.etaEpochMs).toBeCloseTo(1_300_000, -3);
    expect(after.trafficDelayMs).toBeCloseTo(180_000, -3);
    // Everything else about the trip is untouched — same position, same turn.
    expect(after.traveledM).toBe(before.traveledM);
    expect(after.upcoming?.instruction.text).toBe(before.upcoming?.instruction.text);
  });

  it('sheds the delay as the jammed stretch is driven through', () => {
    const s = new NavigationSession(route());
    s.update(pointAtAlong(0), 0);
    s.setSchedule(jammed, 0);

    // Start of the jammed leg: all of it still ahead. Past its end: none.
    const entering = s.update(pointAtAlong(routeCum[10]!), 60_000).state;
    const through = s.update(pointAtAlong(routeCum[20]!), 300_000).state;
    expect(entering.trafficDelayMs).toBeCloseTo(180_000, -3);
    expect(through.trafficDelayMs).toBe(0);
  });

  it('keeps prompts, camera state and the matcher across the change', () => {
    const s = new NavigationSession(route());
    s.update(pointAtAlong(0), 0);
    // Fire the first leg's approach cue, then re-price.
    const spoken = s.update(pointAtAlong(routeCum[10]! - 60), 20_000).prompts;
    expect(spoken.length).toBeGreaterThan(0);
    s.setSchedule(jammed, 20_000);
    // The same cue must not be spoken again just because the schedule changed.
    expect(s.update(pointAtAlong(routeCum[10]! - 50), 24_000).prompts).toEqual([]);
  });

  it('refuses a schedule that does not describe this route', () => {
    const s = new NavigationSession(route());
    s.update(pointAtAlong(0), 0);
    const before = s.update(pointAtAlong(100), 5_000).state.timeRemainingMs;

    // A different line, and the same line with the maneuvers moved.
    expect(s.setSchedule({ ...longRoute, timeMs: 60_000 }, 5_000)).toBeNull();
    expect(
      s.setSchedule(
        {
          ...route(),
          timeMs: 60_000,
          instructions: [
            { ...instructions[0]!, interval: [0, 12] as [number, number] },
            instructions[1]!,
            instructions[2]!,
          ],
        },
        5_000,
      ),
    ).toBeNull();
    expect(s.update(pointAtAlong(100), 6_000).state.timeRemainingMs).toBeCloseTo(before, -2);
  });

  it('leaves an arrived trip alone', () => {
    const s = new NavigationSession(route());
    s.update(pointAtAlong(0), 0);
    const arrived = s.update(pointAtAlong(routeTotal), 60_000).state;
    expect(arrived.status).toBe('arrived');
    const after = s.setSchedule(jammed, 60_000)!;
    expect(after.status).toBe('arrived');
    expect(after.trafficDelayMs).toBe(0);
    expect(after.etaEpochMs).toBe(arrived.etaEpochMs);
  });
});

describe('NavigationSession plannedRemainingMs', () => {
  it('is null before any fix has anchored a position', () => {
    expect(new NavigationSession(route()).plannedRemainingMs()).toBeNull();
  });

  it('reports the engine estimate for the remaining route', () => {
    const s = new NavigationSession(route());
    // Halfway through the first 60 s leg: 30 s of it left plus the 60 s leg after.
    s.update(pointAtAlong(routeCum[10]! / 2), 0);
    expect(s.plannedRemainingMs()!).toBeCloseTo(90_000, -3);
  });

  it('matches the displayed route-progress estimate at a standstill', () => {
    const s = new NavigationSession(route());
    const still = { ...pointAtAlong(300), speedMps: 0 };
    const planned = (s.update(still, 0), s.plannedRemainingMs()!);
    // Waiting does not change how long the untraveled route itself takes.
    let displayed = 0;
    for (let t = 10_000; t <= 300_000; t += 10_000) {
      displayed = s.update(still, t).state.timeRemainingMs;
    }
    expect(s.plannedRemainingMs()!).toBeCloseTo(planned, -1);
    expect(displayed).toBeCloseTo(planned, -1);
  });
});

describe('NavigationSession voice extras', () => {
  // Two maneuvers ~222 m apart: close enough to chain into one prompt.
  const chained: RouteInstruction[] = [
    { text: 'Head east.', distanceM: routeCum[10]!, timeMs: 60_000, sign: 0, interval: [0, 10] },
    {
      text: 'Turn right onto Elm Street.',
      distanceM: routeCum[12]! - routeCum[10]!,
      timeMs: 20_000,
      sign: 2,
      interval: [10, 12],
    },
    {
      text: 'Keep left at the fork.',
      distanceM: routeTotal - routeCum[12]!,
      timeMs: 40_000,
      sign: -7,
      interval: [12, 20],
    },
    {
      text: 'You have arrived. It is on the right.',
      distanceM: 0,
      timeMs: 0,
      sign: 4,
      interval: [20, 20],
    },
  ];

  it('offers the first instruction as a departure prompt', () => {
    const depart = new NavigationSession(route()).departurePrompt();
    expect(depart).toMatchObject({ kind: 'depart', text: 'Head east' });
    expect(new NavigationSession(route(false)).departurePrompt()).toBeNull();
  });

  it('chains a close following maneuver into approach and now prompts', () => {
    const s = new NavigationSession({ ...route(), instructions: chained });
    const approach = s.update(pointAtAlong(routeCum[10]! - 350), 0).prompts;
    expect(approach[0]!.text).toBe(
      'In 350 meters, Turn right onto Elm Street, then keep left at the fork.',
    );
    const now = s.update(pointAtAlong(routeCum[10]! - 20), 0).prompts;
    expect(now[0]!.text).toBe('Turn right onto Elm Street, then keep left at the fork.');
  });

  it('does not chain maneuvers that are far apart', () => {
    const s = new NavigationSession(route());
    const prompts = s.update(pointAtAlong(routeCum[10]! - 350), 0).prompts;
    expect(prompts[0]!.text).toBe('In 350 meters, Turn right onto Elm Street');
  });

  it('speaks the destination side on arrival when the route carries it', () => {
    const withSide = new NavigationSession({ ...route(), instructions: chained });
    expect(withSide.arrivalText()).toBe('You have arrived. It is on the right.');
    expect(new NavigationSession(route(false)).arrivalText()).toBe('You have arrived');
  });

  it('uses Valhalla wording for alert, pre-turn, immediate, post-turn, and arrival cues', () => {
    const verbal: RouteInstruction[] = [
      {
        ...instructions[0]!,
        verbal: { pre: 'Drive east on Main Street.', post: 'Continue for 600 meters.' },
      },
      {
        ...instructions[1]!,
        kind: 'exit',
        exitSign: { numbers: ['43'], toward: ['Oslo'] },
        verbal: {
          alert: 'Take exit 43 toward Oslo.',
          pre: 'Take exit 43 toward Oslo on E6.',
          succinct: 'Take exit 43.',
          post: 'Continue on E6 for 600 meters.',
        },
      },
      {
        ...instructions[2]!,
        verbal: { pre: 'Your destination is on the right.' },
      },
    ];
    const s = new NavigationSession({ ...route(), instructions: verbal });

    expect(s.departurePrompt()?.text).toBe('Drive east on Main Street.');
    expect(s.update(pointAtAlong(routeCum[10]! - 350), 0).prompts[0]!.text).toBe(
      'In 350 meters, Take exit 43 toward Oslo.',
    );
    expect(s.update(pointAtAlong(routeCum[10]! - 150), 1000).prompts[0]!.text).toBe(
      'In 150 meters, Take exit 43 toward Oslo on E6.',
    );
    expect(s.update(pointAtAlong(routeCum[10]! - 20), 2000).prompts[0]).toMatchObject({
      kind: 'now',
      text: 'Take exit 43.',
    });
    expect(s.update(pointAtAlong(routeCum[10]! + 10), 3000).prompts[0]).toMatchObject({
      kind: 'post',
      text: 'Continue on E6 for 600 meters.',
    });
    expect(s.arrivalText()).toBe('Your destination is on the right.');
  });

  it('trusts Valhalla multi-cues instead of appending the next turn again', () => {
    const verbal = chained.map((instruction, index) =>
      index === 1
        ? {
            ...instruction,
            verbal: {
              pre: 'Turn right onto Elm Street. Then keep left at the fork.',
              multiCue: true,
            },
          }
        : instruction,
    );
    const s = new NavigationSession({ ...route(), instructions: verbal });
    expect(s.update(pointAtAlong(routeCum[10]! - 150), 0).prompts[0]!.text).toBe(
      'In 150 meters, Turn right onto Elm Street. Then keep left at the fork.',
    );
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

  it('shows lane guidance only inside the time-scaled approach band', () => {
    const laneRoute = route();
    laneRoute.instructions = instructions.map((instruction, index) =>
      index === 1
        ? {
            ...instruction,
            lanes: [
              { directions: ['straight'], state: 'invalid' },
              {
                directions: ['straight', 'right'],
                state: 'active',
                recommendedDirection: 'right',
              },
            ],
          }
        : instruction,
    );
    const s = new NavigationSession(laneRoute);
    expect(s.update(pointAtAlong(0), 0).state.laneGuidance).toBeNull();
    expect(s.update(pointAtAlong(routeCum[10]! - 350), 1000).state.laneGuidance).toEqual(
      laneRoute.instructions[1]!.lanes,
    );
    expect(s.update(pointAtAlong(routeCum[10]! + 5), 2000).state.laneGuidance).toBeNull();
  });

  it('attaches a late NVDB lane row to the state already on screen', () => {
    const s = new NavigationSession(route());
    const before = s.update(pointAtAlong(routeCum[10]! - 200), 1000).state;
    expect(before.laneGuidance).toBeNull();
    const refreshed = s.setLanes([
      {
        instructionIndex: 1,
        lanes: [
          { directions: ['straight'], state: 'invalid' },
          { directions: ['right'], state: 'active', recommendedDirection: 'right' },
        ],
      },
    ]);
    expect(refreshed?.laneGuidance).toEqual([
      { directions: ['straight'], state: 'invalid' },
      { directions: ['right'], state: 'active', recommendedDirection: 'right' },
    ]);
    expect(refreshed?.upcoming?.instruction.lanes).toEqual(refreshed?.laneGuidance);
  });

  it('sustains a named long road until the time-based far approach band', () => {
    const s = new NavigationSession(longRoute);
    const early = s.update({ ...longRoutePoints[0]!, speedMps: 30 }, 0).state;
    expect(early.sustain).toMatchObject({ road: 'E18' });
    expect(early.sustain!.distanceRemainingM).toBeCloseTo(longTurnAlong, 0);
    expect(early.upcoming?.instruction.text).toBe('Take exit 43 toward Oslo');

    const approaching = s.update(
      {
        ...pointAtDistance(longRoutePoints, longRouteCum, longTurnAlong - 2900),
        speedMps: 30,
      },
      1000,
    ).state;
    expect(approaching.sustain).toBeNull();
  });

  it('does not use the driving sustain layout for walking or cycling', () => {
    for (const profile of ['bike', 'foot', 'hike'] as const) {
      const s = new NavigationSession(longRoute, navOptionsForProfile(profile));
      expect(s.update({ ...longRoutePoints[0]!, speedMps: 2 }, 0).state.sustain).toBeNull();
    }
  });

  it('keeps motorway-style post-turn confirmations out of non-driving profiles', () => {
    const verbalRoute: RoutePath = {
      ...route(false),
      instructions: instructions.map((instruction, index) =>
        index === 1
          ? {
              ...instruction,
              verbal: { post: 'Continue for 3 kilometers.' },
            }
          : instruction,
      ),
    };

    for (const profile of ['bike', 'foot', 'hike'] as const) {
      const s = new NavigationSession(verbalRoute, navOptionsForProfile(profile));
      s.update({ ...routePoints[0]!, speedMps: 2 }, 0);
      expect(s.update({ ...routePoints[11]!, speedMps: 2 }, 1000).prompts).not.toContainEqual(
        expect.objectContaining({ kind: 'post' }),
      );
    }
  });
});

describe('lane glyphs', () => {
  it('uses one shared vector path per marked direction and highlights the carrying branch', () => {
    const lane = {
      directions: ['straight', 'right'] as const,
      state: 'active' as const,
      recommendedDirection: 'right' as const,
    };
    const glyphs = laneGlyphs(lane);
    expect(glyphs.map((glyph) => glyph.direction)).toEqual(['straight', 'right']);
    expect(glyphs.every((glyph) => glyph.path.length > 0)).toBe(true);
    expect(glyphs.map((glyph) => glyph.recommended)).toEqual([false, true]);
    expect(laneLabel(lane)).toBe('straight or right, use this lane');
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

  it('marks straight-ahead decision points (ramp/keep/merge kinds)', () => {
    const straightKeep: RouteInstruction = {
      text: 'Keep straight to stay on E6',
      distanceM: 0,
      timeMs: 0,
      sign: 0,
      kind: 'keep',
      interval: [10, 20],
    };
    const fc = maneuverArrowsGeoJSON({
      points: routePoints,
      instructions: [instructions[0]!, straightKeep, instructions[2]!],
    });
    expect(fc.features.filter((f) => f.properties.kind === 'body')).toHaveLength(1);
  });
});

describe('remainingRouteBounds', () => {
  it('bounds the route from the traveled position to the destination', () => {
    const b = remainingRouteBounds(routePoints, routeCum[10]!)!;
    expect(b.sw.lng).toBeCloseTo(10.01, 5);
    expect(b.ne.lng).toBeCloseTo(10.02, 5);
    expect(b.sw.lat).toBeCloseTo(60, 5);
  });

  it('is null for degenerate input or a finished route', () => {
    expect(remainingRouteBounds([{ lat: 60, lng: 10 }], 0)).toBeNull();
    expect(remainingRouteBounds(routePoints, routeTotal)).toBeNull();
  });
});

describe('NavigationSession speed limits', () => {
  it('reports the limit for the stretch being driven, and none where data lacks it', () => {
    const session = new NavigationSession(route());
    session.setEnrichment({
      segments: [
        { startM: 0, endM: 500, speedLimitKph: 50 },
        // A gap in the data, not a gap in the road: 500–800 m has no limit.
        { startM: 500, endM: 800 },
        { startM: 800, endM: routeTotal, speedLimitKph: 90 },
      ],
    });

    const at = (alongM: number) =>
      session.update({ ...pointAtAlong(alongM), speedMps: 15, accuracyM: 5 }, 1000 + alongM).state
        .speedLimitKph;

    expect(at(100)).toBe(50);
    expect(at(600)).toBeNull();
    expect(at(1000)).toBe(90);
  });

  it('reads null until enrichment arrives — guidance runs without it', () => {
    const session = new NavigationSession(route());
    const before = session.update({ ...pointAtAlong(100), speedMps: 15, accuracyM: 5 }, 1000);
    expect(before.state.speedLimitKph).toBeNull();
    expect(before.state.upcoming).not.toBeNull();

    session.setEnrichment({ segments: [{ startM: 0, endM: routeTotal, speedLimitKph: 60 }] });
    const after = session.update({ ...pointAtAlong(150), speedMps: 15, accuracyM: 5 }, 2000);
    expect(after.state.speedLimitKph).toBe(60);
  });

  it('refreshes the state on screen instead of waiting for the next fix', () => {
    const session = new NavigationSession(route());
    const shown = session.update({ ...pointAtAlong(100), speedMps: 15, accuracyM: 5 }, 1000).state;
    expect(shown.speedLimitKph).toBeNull();

    // Attributes land between fixes — stopped at a light, or in a tunnel, the
    // next fix can be minutes away, so the returned state carries the limit.
    const refreshed = session.setEnrichment({
      segments: [{ startM: 0, endM: routeTotal, speedLimitKph: 70 }],
    });
    expect(refreshed?.speedLimitKph).toBe(70);
    expect(refreshed?.traveledM).toBeCloseTo(shown.traveledM, 6);
  });

  it('has no state to refresh before the first fix', () => {
    const session = new NavigationSession(route());
    expect(session.setEnrichment({ segments: [] })).toBeNull();
  });
});

describe('NavigationSession tunnel awareness from route data', () => {
  /** A ~33 km straight route driven at 30 m/s, with a mapped tunnel in it. */
  function longRoute() {
    const points: LatLng[] = Array.from({ length: 21 }, (_, i) => ({
      lat: 60,
      lng: 10 + i * 0.03,
    }));
    const totalM = cumulativeDistances(points).at(-1)!;
    return {
      path: { points, distanceM: totalM, timeMs: (totalM / 30) * 1000, ascentM: 0, descentM: 0 },
      totalM,
    };
  }

  it('reports the tunnel being driven, counting down to the exit portal', () => {
    const session = new NavigationSession(route());
    session.setEnrichment({
      segments: [
        { startM: 0, endM: 300 },
        { startM: 300, endM: 900, tunnel: true, name: 'Brynstunnelen' },
        { startM: 900, endM: routeTotal },
      ],
    });
    const at = (alongM: number) =>
      session.update({ ...pointAtAlong(alongM), speedMps: 15, accuracyM: 5 }, 1000 + alongM).state
        .tunnel;

    expect(at(100)).toBeNull();
    expect(at(400)?.name).toBe('Brynstunnelen');
    expect(at(400)?.remainingM).toBeCloseTo(500, 0);
    expect(at(800)?.remainingM).toBeCloseTo(100, 0);
    expect(at(1000)).toBeNull();
  });

  it('bounds dead reckoning by the far portal instead of the 25 km cap', () => {
    const { path } = longRoute();
    const session = new NavigationSession(path);
    // A 6 km tunnel starting 1 km in — well inside the generic distance cap,
    // so only the route data can stop the extrapolation at the right place.
    session.setEnrichment({
      segments: [{ startM: 1000, endM: 7000, tunnel: true, name: 'Oslofjordtunnelen' }],
    });
    // The last fix lands at the portal, which is where GPS actually dies.
    session.update({ ...pointAtAlongOf(path.points, 1000), speedMps: 30 }, 0);

    // 150 s on: 4.5 km further, inside the bore and still guiding — and the
    // state names the tunnel it is guiding through.
    const inside = session.tick(150_000)!;
    expect(inside.state.fix).toBe('estimated');
    expect(inside.state.tunnel?.name).toBe('Oslofjordtunnelen');

    // 250 s = 7.5 km on, past the far portal (7.0 km) plus its margin. Without
    // this bound the puck would have kept gliding down the motorway for
    // another 17 km on the generic cap; a still-missing fix past the portal
    // means something other than a tunnel, so say so.
    expect(session.tick(250_000)!.state.fix).toBe('lost');
  });

  it('uses only the short generic bridge where the tiles map no tunnel', () => {
    const { path } = longRoute();
    const session = new NavigationSession(path);
    session.update({ ...path.points[0]!, speedMps: 30 }, 0);
    expect(session.tick(5_000)!.state.fix).toBe('estimated');
    const lost = session.tick(11_000)!.state;
    expect(lost.fix).toBe('lost');
    expect(lost.raw).toEqual(path.points[0]);
    expect(lost.traveledM).toBeCloseTo(0, 0);
  });

  it('arms at a portal the last fix stopped just short of', () => {
    const { path } = longRoute();
    const session = new NavigationSession(path);
    // The last usable fix lands 80 m *before* the entrance, which is the
    // normal case — GPS fades on the approach, not exactly at the portal.
    // Inside `tunnelArmM`, so the tunnel still bounds the reckoning.
    session.setEnrichment({ segments: [{ startM: 3080, endM: 5000, tunnel: true }] });
    session.update({ ...pointAtAlongOf(path.points, 3000), speedMps: 30 }, 0);

    // 60 s = 1.8 km on, short of the far portal (5.0 km) plus its margin.
    expect(session.tick(60_000)!.state.fix).toBe('estimated');
    // 100 s = 3 km on, past 5.2 km — out the other side, so stop pretending.
    expect(session.tick(100_000)!.state.fix).toBe('lost');
  });
});

/** A LatLng exactly `target` metres along an arbitrary polyline. */
function pointAtAlongOf(points: LatLng[], target: number): LatLng {
  const cum = cumulativeDistances(points);
  return pointAtDistance(points, cum, target);
}

describe('navOptionsForProfile', () => {
  it('leaves driving on the defaults — car is the empty row', () => {
    expect(navOptionsForProfile('car')).toEqual({});
  });

  it('lets a caller override a mode value (a mid-trip reroute keeps departed)', () => {
    const opts = navOptionsForProfile('foot', { startDeparted: true });
    expect(opts.startDeparted).toBe(true);
    expect(opts.predictAheadMs).toBe(0); // the rest of the row survives
  });

  it('draws pedestrian profiles at the precise GPS position', () => {
    for (const profile of ['foot', 'hike', 'run'] as const) {
      const s = new NavigationSession(
        route(),
        navOptionsForProfile(profile, { startDeparted: true }),
      );
      const fix = { lat: 60.000045, lng: 10.005, accuracyM: 5 };
      const state = s.update(fix, 0).state;
      expect(state.snapped, profile).toEqual({ lat: fix.lat, lng: fix.lng });
      expect(state.routeProgress, profile).toBeGreaterThan(0);
    }
  });

  it('keeps road snapping for vehicle profiles', () => {
    for (const profile of ['car', 'bike'] as const) {
      const s = new NavigationSession(
        route(),
        navOptionsForProfile(profile, { startDeparted: true }),
      );
      const state = s.update({ lat: 60.000045, lng: 10.005, accuracyM: 5 }, 0).state;
      expect(state.snapped.lat, profile).toBeCloseTo(60, 5);
    }
  });

  it('never reports wrong-way on foot — walking a path backwards is legal', () => {
    const s = new NavigationSession(route(), navOptionsForProfile('foot', { startDeparted: true }));
    // Same fix that trips a driver: on the eastbound line, heading west.
    const back = { ...pointAtAlong(routeCum[10]!), speedMps: 1.4, headingDeg: 270 };
    for (let t = 0; t < 6; t++) expect(s.update(back, t * 1000).state.status).toBe('navigating');
  });

  it('does not loiter-arrive a walker who is still walking', () => {
    const s = new NavigationSession(route(), navOptionsForProfile('foot', { startDeparted: true }));
    // 20 m out at 1.4 m/s — under the *car's* "stopped" threshold, so on the
    // driving row this walker would arrive without having stopped at all.
    const walking = { ...pointAtAlong(routeTotal - 20), speedMps: 1.4, accuracyM: 40 };
    for (let t = 0; t <= 40_000; t += 5000) {
      expect(s.update(walking, t).state.status).toBe('navigating');
    }
    // Actually stopping there does finish the trip.
    const stopped = { ...pointAtAlong(routeTotal - 20), speedMps: 0, accuracyM: 40 };
    s.update(stopped, 45_000);
    expect(s.update(stopped, 66_000).state.status).toBe('arrived');
  });

  it('still catches a cyclist riding the route backwards', () => {
    const s = new NavigationSession(route(), navOptionsForProfile('bike', { startDeparted: true }));
    const back = { ...pointAtAlong(routeCum[10]!), speedMps: 5, headingDeg: 270 };
    s.update(back, 0);
    s.update(back, 1000);
    expect(s.update(back, 2000).state.status).toBe('off-route');
  });

  it('warns a walker at walking distances, not motorway ones', () => {
    const at = pointAtAlong(routeCum[10]! - 90); // 90 m short of the turn
    const drive = new NavigationSession(route(), { startDeparted: true });
    expect(drive.update({ ...at, speedMps: 14 }, 0).prompts[0]).toMatchObject({ thresholdM: 210 });

    const walk = new NavigationSession(
      route(),
      navOptionsForProfile('foot', { startDeparted: true }),
    );
    expect(walk.update({ ...at, speedMps: 1.4 }, 0).prompts[0]).toMatchObject({ thresholdM: 100 });
  });

  it('never arms the far-out motorway prompt on foot, however fast the fix claims', () => {
    const s = new NavigationSession(route(), navOptionsForProfile('foot', { startDeparted: true }));
    // 500 m out at a speed that would arm the driver's 800 m prompt.
    const { prompts } = s.update({ ...pointAtAlong(routeCum[10]! - 500), speedMps: 25 }, 0);
    expect(prompts).toHaveLength(0);
  });

  it('does not dead-reckon a walker through a GPS gap', () => {
    const s = new NavigationSession(route(), navOptionsForProfile('foot'));
    s.update({ ...pointAtAlong(200), speedMps: 1.4 }, 0);
    // A driver would be extrapolated forward here; a stopped walker under a
    // bridge must not be marched down the route on no evidence.
    const est = s.tick(6000)!;
    expect(est.state.fix).toBe('lost');
    expect(est.state.traveledM).toBeCloseTo(200, 0);
  });

  it('leaves off-route on foot as an offer, with a tighter corridor and longer grace', () => {
    // Off-route on foot no longer *performs* anything (autoReroute is off —
    // the controller shows "Off route · Reroute?"), which is what lets the
    // corridor sit at 35 m instead of the old 45 m without rerouting a
    // pedestrian for walking round a puddle.
    expect(navOptionsForProfile('foot').autoReroute).toBe(false);
    expect(navOptionsForProfile('hike').autoReroute).toBe(false);
    expect(navOptionsForProfile('car').autoReroute).toBeUndefined(); // default: true

    // ~32 m off the line — a detour round a building — stays on-route.
    const beside = { ...pointAtAlong(300), speedMps: 1.4 };
    beside.lat += 0.00029;
    const walk = new NavigationSession(
      route(),
      navOptionsForProfile('foot', { startDeparted: true }),
    );
    for (let t = 0; t < 8; t++)
      expect(walk.update(beside, t * 1000).state.status).toBe('navigating');

    // ~42 m off: both trip it, but the walker gets an extra grace fix.
    const far = { ...pointAtAlong(300), speedMps: 1.4 };
    far.lat += 0.00038;
    const stray = new NavigationSession(
      route(),
      navOptionsForProfile('foot', { startDeparted: true }),
    );
    for (let t = 0; t < 3; t++) expect(stray.update(far, t * 1000).state.status).toBe('navigating');
    expect(stray.update(far, 3000).state.status).toBe('off-route');

    const drive = new NavigationSession(route(), { startDeparted: true });
    for (let t = 0; t < 2; t++) drive.update(far, t * 1000);
    expect(drive.update(far, 2000).state.status).toBe('off-route');
  });
});

// ---------------------------------------------------------------------------
// Roundabouts: the ring stays on screen while the vehicle is inside it.
// ---------------------------------------------------------------------------

/** The straight route, re-signed as approach → ring → exit → arrive. */
function ringRoute(): RoutePath {
  return {
    points: routePoints,
    distanceM: routeTotal,
    timeMs: 120_000,
    ascentM: 0,
    descentM: 0,
    instructions: [
      {
        text: 'Head east',
        distanceM: routeCum[8]!,
        timeMs: 60_000,
        sign: 0,
        streetName: 'Main Street',
        interval: [0, 8],
      },
      {
        text: 'Enter the roundabout and take the 3rd exit onto Elm Street',
        distanceM: routeCum[10]! - routeCum[8]!,
        timeMs: 5_000,
        sign: 6,
        exitNumber: 3,
        exitAngleDeg: -80,
        interval: [8, 10],
      },
      {
        text: 'Exit the roundabout onto Elm Street',
        distanceM: routeCum[12]! - routeCum[10]!,
        timeMs: 5_000,
        sign: 6,
        exitAngleDeg: -80,
        streetName: 'Elm Street',
        verbal: { pre: 'Exit the roundabout onto Elm Street', succinct: 'Exit the roundabout' },
        interval: [10, 12],
      },
      { text: 'Arrive at destination', distanceM: 0, timeMs: 0, sign: 4, interval: [20, 20] },
    ],
  };
}

describe('NavigationSession roundabout display', () => {
  const enterM = routeCum[8]!;
  const leaveM = routeCum[10]!;

  it('keeps the exit to count on screen until the route leaves the ring', () => {
    const s = new NavigationSession(ringRoute(), { startDeparted: true });

    const approaching = s.update({ ...pointAtAlong(400), speedMps: 5 }, 0).state;
    expect(approaching.upcoming?.instruction.exitNumber).toBe(3);
    expect(approaching.upcoming!.distanceToM).toBeCloseTo(enterM - 400, 0);
    // Not the ring's own exit half: a second, numberless roundabout icon in
    // the "then" row says nothing the row above hasn't already said.
    expect(approaching.then?.instruction.text).toBe('Arrive at destination');

    // Inside the ring the maneuver list has moved on to "exit the roundabout",
    // which knows nothing about *which* exit — the banner must not.
    const inside = s.update({ ...pointAtAlong(500), speedMps: 5 }, 25_000).state;
    expect(inside.upcoming?.instruction.exitNumber).toBe(3);
    expect(inside.upcoming?.instruction.sign).toBe(6);
    // …and it now counts down to where the route actually leaves the ring.
    expect(inside.upcoming!.distanceToM).toBeCloseTo(leaveM - 500, 0);
    expect(inside.then?.instruction.text).toBe('Arrive at destination');

    const after = s.update({ ...pointAtAlong(620), speedMps: 5 }, 50_000).state;
    expect(after.upcoming?.instruction.text).toBe('Arrive at destination');
    expect(after.then).toBeNull();
  });

  it('still speaks the exit cue while the ring is being shown', () => {
    const s = new NavigationSession(ringRoute(), { startDeparted: true });
    s.update({ ...pointAtAlong(400), speedMps: 5 }, 0);
    const { prompts } = s.update({ ...pointAtAlong(500), speedMps: 5 }, 25_000);
    // Voice follows the real maneuver list: "exit the roundabout onto Elm
    // Street" is the right thing to say inside the ring, even though the
    // numberless ring icon is the wrong thing to draw.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain('Exit the roundabout onto Elm Street');
  });
});

// ---------------------------------------------------------------------------
// Junction behaviour: not committing to the next road before turning onto it.
// ---------------------------------------------------------------------------

// 111 m east, then 111 m north — one right-angle junction at (60, 10.002).
const cornerPoints: LatLng[] = [
  { lat: 60, lng: 10 },
  { lat: 60, lng: 10.002 },
  { lat: 60.001, lng: 10.002 },
];
const cornerCum = cumulativeDistances(cornerPoints);
const cornerM = cornerCum[1]!;

function cornerRoute(): RoutePath {
  return {
    points: cornerPoints,
    distanceM: cornerCum[2]!,
    timeMs: 20_000,
    ascentM: 0,
    descentM: 0,
    instructions: [
      {
        text: 'Head east',
        distanceM: cornerM,
        timeMs: 10_000,
        sign: 0,
        streetName: 'Main Street',
        interval: [0, 1],
      },
      {
        text: 'Turn left onto Elm Street',
        distanceM: cornerCum[2]! - cornerM,
        timeMs: 10_000,
        sign: -2,
        streetName: 'Elm Street',
        interval: [1, 2],
      },
      { text: 'Arrive at destination', distanceM: 0, timeMs: 0, sign: 4, interval: [2, 2] },
    ],
  };
}

describe('map matching at a junction', () => {
  it('will not put a car on the crossing road it is still driving towards', () => {
    // 2 m short of the corner and 20 m north of the road being driven: nearer
    // the crossing road by a long way, but travelling east, which no vehicle
    // on a northbound road can be doing.
    const noisy = { lat: 60 + 20 / 111_320, lng: 10.002 - 2 / 55_660 };
    const snap = snapToRoute(noisy, cornerPoints, cornerCum, {
      prevAlongM: cornerM - 10,
      headingDeg: 90,
      maxAdvanceM: 40,
    });
    expect(snap.alongM).toBeLessThan(cornerM);
  });

  it('never projects the displayed position around the corner ahead of the car', () => {
    const s = new NavigationSession(cornerRoute(), { startDeparted: true });
    // 10 m short of the turn at 15 m/s: a full second of look-ahead would put
    // the puck 5 m up the northbound road — on a road the car has not turned
    // onto, with the course-up camera swinging to match.
    const before = pointAtDistance(cornerPoints, cornerCum, cornerM - 10);
    const state = s.update({ ...before, speedMps: 15, headingDeg: 90 }, 0).state;
    expect(state.traveledM).toBeCloseTo(cornerM - 10, 0);
    expect(state.snapped.lat).toBeCloseTo(60, 6);
    expect(state.snapped.lng).toBeLessThanOrEqual(10.002 + 1e-9);
  });
});

describe('walking voice prompts', () => {
  /** Every prompt fired while walking the last 130 m to the turn. */
  function walkToTurn(options: Parameters<typeof navOptionsForProfile>[1]): string[] {
    const s = new NavigationSession(
      route(),
      navOptionsForProfile('foot', { startDeparted: true, ...options }),
    );
    const turnM = routeCum[10]!;
    const spoken: string[] = [];
    for (let d = 130; d >= 2; d -= 5) {
      const { prompts } = s.update(
        { ...pointAtAlong(turnM - d), speedMps: 1.4, accuracyM: 5 },
        ((130 - d) / 1.4) * 1000,
      );
      spoken.push(...prompts.map((p) => p.kind));
    }
    return spoken;
  }

  it('announces a turn twice on foot, not three times', () => {
    // 100/30/10 m is barely a minute of walking; three announcements inside it
    // is nagging. The cue nearest the turn always survives, plus the one far
    // enough away to still be worth hearing.
    expect(walkToTurn({})).toEqual(['approach', 'now']);
  });

  it('keeps all three phases where they are genuinely far apart', () => {
    expect(walkToTurn({ minPromptSpacingM: 0 })).toEqual(['approach', 'approach', 'now']);
  });
});

/**
 * Four defects found in the navigation diagnostic uploaded after a drive
 * through Bragernestunnelen in Drammen on 2026-09-05 — a 3 km tunnel run with
 * a roundabout in the middle of it. The driver's report was that the map
 * "jumped to another position" and that the expected position was never shown.
 * Each test below replays the shape of one measured failure.
 */
describe('NavigationSession Bragernestunnelen regressions', () => {
  /** ~33 km straight route with a 3 km tunnel 1 km in, as the route data saw it. */
  function tunnelRoute() {
    const points: LatLng[] = Array.from({ length: 41 }, (_, i) => ({
      lat: 60,
      lng: 10 + i * 0.015,
    }));
    const totalM = cumulativeDistances(points).at(-1)!;
    const path = {
      points,
      distanceM: totalM,
      timeMs: (totalM / 20) * 1000,
      ascentM: 0,
      descentM: 0,
    };
    const session = new NavigationSession(path);
    session.setEnrichment({
      segments: [
        { startM: 0, endM: 1000 },
        { startM: 1000, endM: 4000, tunnel: true, name: 'Bragernestunnelen' },
        { startM: 4000, endM: totalM },
      ],
    });
    return { session, path, totalM };
  }

  const at = (path: { points: LatLng[] }, alongM: number) => pointAtAlongOf(path.points, alongM);

  it('does not rewind reckoned progress when a fix arrives stamped in the past', () => {
    // Underground the fused provider keeps delivering samples, but stamps them
    // with the moment they were *measured*: ~90 ms of lag in the open, and
    // 2.3-5.1 s inside the tunnel. Those samples are too coarse to accept, and
    // rejecting one ticks the session — with the stale timestamp, which used to
    // shrink the gap being extrapolated and march the puck backwards. Measured:
    // 35 rewinds, up to 122 m, in one three-minute transit.
    const { session, path } = tunnelRoute();
    session.update({ ...at(path, 1000), speedMps: 20, accuracyM: 5 }, 100_000);

    const ahead = session.tick(130_000)!.state.traveledM;
    // A 5 s-stale coarse sample, delivered at 131 s but stamped 126 s.
    const stale = session.update({ ...at(path, 1500), accuracyM: 300, speedMps: 0 }, 126_000).state;
    expect(stale.traveledM).toBeGreaterThanOrEqual(ahead);
    // And the tick that follows it still moves forward, not back to the stamp.
    expect(session.tick(132_000)!.state.traveledM).toBeGreaterThanOrEqual(stale.traveledM);
  });

  it('keeps reckoning armed when the portal degrades a fix without discarding it', () => {
    // The failure that froze guidance for 2 min 28 s. Approaching the portal the
    // provider's accuracy ramps smoothly (3 -> 98 m) while cross-track stays
    // small, so every fix is still accepted; arming reckoning off the 30 m
    // display gate meant the last fix before the blackout disarmed it, and the
    // banner sat on "take the 2nd exit, 46 m" through the entire roundabout.
    const { session, path } = tunnelRoute();
    session.update({ ...at(path, 800), speedMps: 20, accuracyM: 5 }, 0);
    // The ramp: on route, moving, but no longer inside the display corridor's
    // accuracy bound. Still well under discardAccuracyM, so it is accepted.
    session.update({ ...at(path, 980), speedMps: 20, accuracyM: 98 }, 9000);

    const inside = session.tick(60_000)!;
    expect(inside.state.fix).toBe('estimated');
    expect(inside.state.tunnel?.name).toBe('Bragernestunnelen');
    expect(inside.state.traveledM).toBeGreaterThan(1500);
  });

  it('does not let a portal-degraded fix invent a deceleration to reckon at', () => {
    // The same ramp also reported the car slowing 79 -> 12 km/h, which was the
    // provider giving up rather than the driver braking. Anchoring on it made
    // the extrapolation crawl through a tunnel being crossed at speed.
    const { session, path } = tunnelRoute();
    session.update({ ...at(path, 800), speedMps: 20, accuracyM: 5 }, 0);
    session.update({ ...at(path, 980), speedMps: 3.3, accuracyM: 98 }, 9000);

    // 30 s of reckoning should cover something like 20 m/s of road, not 3.3.
    const inside = session.tick(39_000)!.state;
    expect(inside.fix).toBe('estimated');
    expect(inside.traveledM).toBeGreaterThan(1400);
  });

  it('holds the reckoned position when a mapped tunnel outlives its reckoning bound', () => {
    // Reckoning stops at the far portal plus its margin. Rewinding to the last
    // measured fix at that moment threw progress 3.28 km backwards and put the
    // already-driven roundabout back on the banner as "2.6 km ahead".
    const { session, path } = tunnelRoute();
    session.update({ ...at(path, 1000), speedMps: 20, accuracyM: 5 }, 0);
    const coasted = session.tick(160_000)!.state;
    expect(coasted.fix).toBe('estimated');

    const lost = session.tick(400_000)!.state;
    expect(lost.fix).toBe('lost');
    expect(lost.traveledM).toBeCloseTo(coasted.traveledM, 0);
    // And still says it is in the tunnel, so the chip and the map dimming do
    // not drop out for the last stretch of a bore longer than the bound.
    expect(lost.tunnel?.name).toBe('Bragernestunnelen');
    // Still held one tick later, when `fix: 'estimated'` is no longer behind it.
    expect(session.tick(401_000)!.state.traveledM).toBeCloseTo(coasted.traveledM, 0);
  });

  it('ignores coarse in-tunnel fixes rather than re-anchoring on each one', () => {
    // 100-300 m samples that put the car in the hillside standing still. Taken
    // as re-locks they re-anchored guidance somewhere new and dropped back to
    // `lost` a second later — the puck flashing and jumping up and down the
    // route. The tunnel is the better evidence until daylight.
    const { session, path } = tunnelRoute();
    session.update({ ...at(path, 1000), speedMps: 20, accuracyM: 5 }, 0);
    expect(session.tick(160_000)!.state.fix).toBe('estimated');
    const held = session.tick(400_000)!.state;
    expect(held.fix).toBe('lost');

    for (const [t, alongM] of [
      [401_000, 2400],
      [403_000, 3600],
      [405_000, 2900],
    ] as const) {
      const junk = session.update({ ...at(path, alongM), accuracyM: 300, speedMps: 0 }, t).state;
      expect(junk.fix).toBe('lost');
      expect(junk.traveledM).toBeCloseTo(held.traveledM, 0);
    }

    // Daylight: a fix good enough not to need the recovery escape re-anchors
    // normally, in one correction rather than a dozen.
    const daylight = session.update(
      { ...at(path, 4100), speedMps: 20, accuracyM: 5 },
      407_000,
    ).state;
    expect(daylight.fix).toBe('live');
    expect(daylight.traveledM).toBeCloseTo(4100, -1);
  });
});
