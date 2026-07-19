import type { LatLng } from '@atlas/core';
import type { RouteInstruction, RoutePath } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import { followZoom, remainingRouteBounds, zoomForSpeed } from './camera.js';
import {
  bearingDeg,
  cumulativeDistances,
  pointAtDistance,
  snapToPolyline,
  snapToRoute,
  subPolyline,
} from './geometry.js';
import { maneuverArrowsGeoJSON } from './overlays.js';
import { headingRateDegPerSec } from './sensors.js';
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
    const state = s.update({ lat: 60.0001, lng: 10.007, speedMps: 1 }, 1000).state;
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

  it('projects the shown position ahead at speed, leaving guidance math honest', () => {
    const s = new NavigationSession(route(), { startDeparted: true });
    const state = s.update({ ...pointAtAlong(200), speedMps: 20 }, 0).state;
    // predictAheadMs = 1000 → shown ~20 m ahead of the true position.
    const expected = pointAtAlong(220);
    expect(state.snapped.lng).toBeCloseTo(expected.lng, 5);
    expect(state.traveledM).toBeCloseTo(200, 0);
    const still = new NavigationSession(route(), { startDeparted: true });
    const noSpeed = still.update(pointAtAlong(200), 0).state;
    expect(noSpeed.snapped.lng).toBeCloseTo(pointAtAlong(200).lng, 5);
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

  it('ignores hopeless fixes entirely, holding the last state', () => {
    const s = new NavigationSession(route());
    const good = s.update({ ...pointAtAlong(500), accuracyM: 10 }, 0).state;
    // A 500 m error radius fix far away must not teleport the puck.
    const junk = s.update({ lat: 60.01, lng: 10, accuracyM: 500 }, 1000).state;
    expect(junk.snapped).toEqual(good.snapped);
    expect(junk.traveledM).toBeCloseTo(good.traveledM, 5);
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
    const maneuverAlong = routeCum[10]!;
    s.update({ ...pointAtAlong(maneuverAlong - 513), speedMps: 20 }, 0);
    // 10 s later the estimated position is ~324 m out: the 400 m prompt fires.
    const est = s.tick(10_000)!;
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

  it('gives up dead reckoning after the time backstop', () => {
    const s = new NavigationSession(route());
    s.update({ ...pointAtAlong(100), speedMps: 20 }, 0);
    expect(s.tick(1_250_000)!.state.fix).toBe('lost');
  });

  it('bridges a long tunnel but gives up past the distance cap', () => {
    // A ~33 km straight route (Lærdal-scale) driven at its expected speed.
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
    // 10 min without GPS: 18 km in and still guiding (the old 3 min cap
    // froze the puck a fraction into tunnels like this).
    const inTunnel = s.tick(600_000)!;
    expect(inTunnel.state.fix).toBe('estimated');
    expect(inTunnel.state.traveledM).toBeCloseTo(18_000, -2);
    // 15 min would put it 27 km in — past the 25 km cap the extrapolation
    // is fiction, not a tunnel.
    expect(s.tick(900_000)!.state.fix).toBe('lost');
  });
});

describe('NavigationSession wrong-branch detection (gyro)', () => {
  const legMps = routeCum[10]! / 60;

  it('raises wrongBranch with one alert when the vehicle turns off a straight reckoned route', () => {
    const s = new NavigationSession(route());
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
    const s = new NavigationSession(route());
    s.update({ ...pointAtAlong(200), speedMps: legMps }, 0);
    for (let i = 0; i < 10; i++) s.reportHeadingDelta(9); // dropped: fix is live
    expect(s.tick(5000)!.state.wrongBranch).toBe(false);
  });

  it('clears the flag and starts over on the next live fix', () => {
    const s = new NavigationSession(route());
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
  it('projects yaw about the vertical for a flat-mounted device', () => {
    // Screen up, rotating counterclockwise seen from above → bearing falls.
    expect(headingRateDegPerSec({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 9.81 })).toBeCloseTo(-10);
  });

  it('is mount-agnostic: portrait in a windshield cradle reads the same turn', () => {
    // Upright portrait: gravity reaction along +y, world yaw is device y.
    expect(headingRateDegPerSec({ x: 0, y: 10, z: 0 }, { x: 0, y: 9.81, z: 0 })).toBeCloseTo(-10);
    // Rotation about the other axes (pitch/roll in this mount) is not a turn.
    expect(headingRateDegPerSec({ x: 15, y: 0, z: 0 }, { x: 0, y: 9.81, z: 0 })).toBeCloseTo(0);
  });

  it('returns null when the accelerometer is far from 1 g', () => {
    expect(headingRateDegPerSec({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0.5 })).toBeNull();
    expect(headingRateDegPerSec({ x: 0, y: 0, z: 10 }, { x: 9, y: 9, z: 9 })).toBeNull();
  });
});

describe('NavigationSession adaptive ETA', () => {
  it('stretches the ETA when actual pace falls behind the route estimate', () => {
    const s = new NavigationSession(route());
    const still = { ...pointAtAlong(300), speedMps: 0 };
    const base = s.update(still, 0).state.timeRemainingMs;
    // Stuck for five minutes: the pace factor sinks to its clamp.
    let remaining = base;
    for (let t = 10_000; t <= 300_000; t += 10_000) {
      remaining = s.update(still, t).state.timeRemainingMs;
    }
    expect(remaining).toBeGreaterThan(base * 2);
    expect(remaining).toBeLessThanOrEqual(base * 2.6); // clamped, never runaway
  });

  it('shrinks the ETA when running ahead of the route estimate', () => {
    const s = new NavigationSession(route());
    // ~30 m/s over legs the route budgeted ~9 m/s for.
    let along = 100;
    let state = s.update({ ...pointAtAlong(along), speedMps: 30 }, 0).state;
    for (let t = 5000; t <= 25_000; t += 5000) {
      along += 150;
      state = s.update({ ...pointAtAlong(along), speedMps: 30 }, t).state;
    }
    const unadapted = new NavigationSession(route()).update(pointAtAlong(along), 0).state;
    expect(state.timeRemainingMs).toBeLessThan(unadapted.timeRemainingMs * 0.9);
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
      'In 400 meters, Turn right onto Elm Street, then keep left at the fork.',
    );
    const now = s.update(pointAtAlong(routeCum[10]! - 20), 0).prompts;
    expect(now[0]!.text).toBe('Turn right onto Elm Street, then keep left at the fork.');
  });

  it('does not chain maneuvers that are far apart', () => {
    const s = new NavigationSession(route());
    const prompts = s.update(pointAtAlong(routeCum[10]! - 350), 0).prompts;
    expect(prompts[0]!.text).toBe('In 400 meters, Turn right onto Elm Street');
  });

  it('speaks the destination side on arrival when the route carries it', () => {
    const withSide = new NavigationSession({ ...route(), instructions: chained });
    expect(withSide.arrivalText()).toBe('You have arrived. It is on the right.');
    expect(new NavigationSession(route(false)).arrivalText()).toBe('You have arrived');
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
