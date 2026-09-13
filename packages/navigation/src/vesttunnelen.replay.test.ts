import type { LatLng } from '@atlas/core';
import type { Position, RoutePath } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import fixture from './__fixtures__/vesttunnelen-2026-09-10.json' with { type: 'json' };
import { cumulativeDistances } from './geometry.js';
import type { NavState } from './model.js';
import { NavigationSession } from './session.js';

interface ReplayState {
  event: (typeof fixture.events)[number];
  state: NavState;
}

/**
 * The retained 2026-09-10 field log contains an entire private drive. This
 * fixture deliberately keeps only the Vesttunnelen crossing: the route shape
 * immediately around the bore, relative timing, the portal fixes, the two
 * coarse stationary fallbacks emitted under rock, and the first precise fix
 * back in daylight. There is no trip origin, destination, or absolute time.
 */
function replayVesttunnelen(): ReplayState[] {
  const points: LatLng[] = fixture.routePoints;
  const cumulative = cumulativeDistances(points);
  const distanceM = cumulative.at(-1)!;
  const route: RoutePath = {
    points,
    distanceM,
    timeMs: (distanceM / fixture.expectedSpeedMps) * 1000,
    ascentM: 0,
    descentM: 0,
  };
  const session = new NavigationSession(route, { startDeparted: true });
  session.setEnrichment({
    segments: [
      {
        startM: 0,
        endM: cumulative[fixture.tunnelEndPointIndex]!,
        tunnel: true,
        name: 'Vesttunnelen',
      },
    ],
  });

  return fixture.events.map((event) => {
    const update =
      event.kind === 'fix'
        ? session.update(event.position as Position, event.atMs)
        : session.tick(event.atMs);
    expect(update, `no state for ${event.kind} at ${event.atMs} ms`).not.toBeNull();
    return { event, state: update!.state };
  });
}

describe('NavigationSession Vesttunnelen field replay', () => {
  it('carries the real receiver blackout and hands back to the portal fix', () => {
    const replay = replayVesttunnelen();
    const lastLiveBeforeGap = replay.findLast(
      ({ event }) => event.kind === 'fix' && event.atMs === 5000,
    )!;
    const blackout = replay.filter(({ event }) => event.atMs > 5000 && event.atMs < 24001);
    const estimatedTicks = blackout.filter(({ event }) => event.kind === 'tick');
    const coarseFixes = blackout.filter(
      ({ event }) => event.kind === 'fix' && event.position.accuracyM >= 200,
    );
    const recovery = replay.at(-1)!;

    expect(lastLiveBeforeGap.state).toMatchObject({
      status: 'navigating',
      fix: 'live',
      tunnel: { name: 'Vesttunnelen' },
    });
    expect(blackout).not.toHaveLength(0);
    expect(blackout.every(({ state }) => state.status === 'navigating')).toBe(true);
    expect(blackout.every(({ state }) => state.fix === 'estimated')).toBe(true);
    expect(estimatedTicks.map(({ state }) => state.traveledM)).toEqual(
      estimatedTicks.map(({ state }) => state.traveledM).toSorted((a, b) => a - b),
    );

    // Android delivered two stationary 200+ m fallback fixes after newer
    // heartbeat ticks. They must neither claim a live fix nor rewind progress.
    expect(coarseFixes).toHaveLength(2);
    for (const { state } of coarseFixes) {
      expect(state.raw).toEqual(lastLiveBeforeGap.state.raw);
      expect(state.fix).toBe('estimated');
    }

    const lastEstimate = estimatedTicks.at(-1)!.state;
    expect(lastEstimate.traveledM - lastLiveBeforeGap.state.traveledM).toBeCloseTo(171.61, 1);
    expect(lastEstimate.tunnel?.remainingM).toBeCloseTo(26.6, 0);
    expect(recovery.state.fix).toBe('live');
    expect(recovery.state.status).toBe('navigating');
    expect(recovery.state.offRouteM).toBeCloseTo(0.48, 1);
    expect(recovery.state.traveledM - lastEstimate.traveledM).toBeGreaterThan(0);
    expect(recovery.state.traveledM - lastEstimate.traveledM).toBeLessThan(20);
    expect(recovery.state.tunnel?.remainingM).toBeCloseTo(12.6, 0);
  });
});
