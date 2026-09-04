import type { LatLng } from '@atlas/core';
import type { RoutePath } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import {
  NAV_LIFECYCLE_INITIAL,
  navActivity,
  navDestination,
  navLifecycleReducer as step,
  navMayReroute,
  navPath,
  navPhase,
  navPlan,
  navTripProgress,
  type NavEvent,
  type NavLifecycle,
} from './lifecycle.js';

const dest: LatLng = { lat: 60, lng: 10.02 };
const via: LatLng = { lat: 60, lng: 10.01 };

function path(timeMs = 600_000): RoutePath {
  return {
    points: [
      { lat: 60, lng: 10 },
      { lat: 60, lng: 10.02 },
    ],
    distanceM: 1113,
    timeMs,
    ascentM: 0,
    descentM: 0,
    instructions: [],
  };
}

const origin = { fix: { lat: 60, lng: 10, accuracyM: 5 }, atMs: 1_000 };

/** Replay a script from idle — the machine's only entry point. */
function run(...events: NavEvent[]): NavLifecycle {
  return events.reduce(step, NAV_LIFECYCLE_INITIAL);
}

const started: NavEvent[] = [
  { type: 'start', plan: { destination: dest, vias: [via] }, profile: 'car' },
  { type: 'origin-fixed', origin },
];
const previewing: NavEvent[] = [
  ...started,
  { type: 'choices-loaded', choices: [path(), path(900_000)] },
];
const guiding: NavEvent[] = [...previewing, { type: 'guidance-began', path: path(), atMs: 10_000 }];

describe('nav lifecycle — what each stage may hold', () => {
  it('gives an idle machine no trip to remember', () => {
    const idle = run(...guiding, { type: 'end' });
    expect(navPhase(idle)).toBe('idle');
    expect(navDestination(idle)).toBeNull();
    expect(navPlan(idle)).toBeNull();
    expect(navPath(idle)).toBeNull();
    expect(navActivity(idle)).toBeNull();
    expect(navTripProgress(idle, 20_000, 100)).toBeNull();
  });

  it('keeps the mode across a finished trip, because the planner is still in it', () => {
    const idle = run(
      { type: 'start', plan: { destination: dest, vias: [] }, profile: 'bike' },
      { type: 'end' },
    );
    expect(idle.profile).toBe('bike');
  });

  it('drops the preview the moment a plan becomes a trip', () => {
    const trip = run(...guiding);
    expect(navPhase(trip)).toBe('navigating');
    expect(trip.stage.kind).toBe('guiding');
    expect(navPath(trip)).toEqual(path());
  });

  it('keeps the destination but not the route once arrived', () => {
    const arrived = run(...guiding, { type: 'arrived', atMs: 20_000, traveledM: 900 });
    expect(navPhase(arrived)).toBe('arrived');
    expect(navDestination(arrived)).toEqual(dest);
    expect(navPath(arrived)).toBeNull();
    expect(navPlan(arrived)).toBeNull();
  });

  it('remembers which kind of live-location session failed', () => {
    const failed = run({ type: 'explore', profile: 'foot' }, { type: 'failed', message: 'denied' });
    expect(navPhase(failed)).toBe('error');
    expect(navActivity(failed)).toBe('explorer');
    const other = run(...started, { type: 'failed', message: 'no fix' });
    expect(navActivity(other)).toBe('guidance');
  });
});

describe('nav lifecycle — identity', () => {
  it('lets a superseded request be recognised rather than applied', () => {
    const first = run(...started);
    const second = step(first, {
      type: 'start',
      plan: { destination: via, vias: [] },
      profile: 'car',
    });
    expect(second.op).not.toBe(first.op);
    expect(second.trip).not.toBe(first.trip);
    // The abandoned request's own result, replayed onto the machine it left
    // behind, would describe the second trip's destination — which is why the
    // controller compares `op` before dispatching it at all.
    expect(navDestination(second)).toEqual(via);
  });

  it('never lets a superseded command release a newer one’s guard', () => {
    const first = run({ type: 'start', plan: { destination: dest, vias: [] }, profile: 'car' });
    const stale = first.pending!;
    const second = step(first, {
      type: 'start',
      plan: { destination: via, vias: [] },
      profile: 'car',
    });
    // The first Start settling late must not unlatch the second one.
    const after = step(second, { type: 'setup-settled', op: stale });
    expect(after.pending).toBe(second.pending);
    expect(step(after, { type: 'setup-settled', op: second.pending! }).pending).toBeNull();
  });

  it('claims a new trip when guidance begins, and again when it ends', () => {
    const preview = run(...previewing);
    const trip = step(preview, { type: 'guidance-began', path: path(), atMs: 10_000 });
    expect(trip.trip).toBe(preview.trip + 1);
    expect(step(trip, { type: 'end' }).trip).toBe(trip.trip + 1);
    expect(step(trip, { type: 'pause', atMs: 20_000, traveledM: 10 }).trip).toBe(trip.trip + 1);
  });
});

describe('nav lifecycle — preview', () => {
  it('ignores a choice that is not on offer', () => {
    const preview = run(...previewing);
    expect(step(preview, { type: 'preview-selected', index: 1 }).stage).toMatchObject({ index: 1 });
    for (const index of [-1, 2, 1.5, Number.NaN]) {
      expect(step(preview, { type: 'preview-selected', index }).stage).toMatchObject({ index: 0 });
    }
  });

  it('keeps the old choices when a profile switch finds no route', () => {
    const preview = run(...previewing, { type: 'profile-requested' });
    expect(preview.stage).toMatchObject({ loading: true });
    const failed = step(preview, { type: 'profile-failed', message: 'no route found' });
    expect(failed.profile).toBe('car');
    expect(failed.stage).toMatchObject({ loading: false, error: 'no route found' });
    expect(failed.stage.kind === 'preview' && failed.stage.choices).toHaveLength(2);
  });

  it('drops planner preferences with the profile they were chosen for', () => {
    const preview = run(
      {
        type: 'start',
        plan: { destination: dest, vias: [via], preferences: { avoidTolls: true } },
        profile: 'car',
      },
      { type: 'origin-fixed', origin },
      { type: 'choices-loaded', choices: [path()] },
      { type: 'profile-requested' },
      { type: 'profile-loaded', profile: 'bike', choices: [path(1_800_000)] },
    );
    expect(preview.profile).toBe('bike');
    expect(navPlan(preview)?.preferences).toBeUndefined();
    // The stops are the plan, not the costing: they survive the switch.
    expect(navPlan(preview)?.vias).toEqual([via]);
  });

  it('lets a Start settle its own spinner and no one else’s', () => {
    const going = run(...previewing, { type: 'go' });
    expect(going.stage).toMatchObject({ loading: true });
    expect(step(going, { type: 'go-settled', op: going.op - 1 }).stage).toMatchObject({
      loading: true,
    });
    expect(step(going, { type: 'go-settled', op: going.op }).stage).toMatchObject({
      loading: false,
    });
  });
});

describe('nav lifecycle — rerouting', () => {
  it('backs off further after each failure, capped at a minute', () => {
    let trip = run(...guiding);
    const backoffs: number[] = [];
    for (let i = 0; i < 6; i++) {
      trip = step(trip, { type: 'reroute-started' });
      expect(navPhase(trip)).toBe('rerouting');
      trip = step(trip, { type: 'reroute-failed', atMs: 0 });
      expect(navPhase(trip)).toBe('navigating');
      if (trip.stage.kind === 'guiding') backoffs.push(trip.stage.reroute.backoffUntilMs);
    }
    expect(backoffs).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it('refuses a reroute in flight or still inside its backoff', () => {
    const trip = run(...guiding);
    expect(navMayReroute(trip, 0)).toBe(true);
    expect(navMayReroute(step(trip, { type: 'reroute-started' }), 0)).toBe(false);
    const failed = run(
      ...guiding,
      { type: 'reroute-started' },
      { type: 'reroute-failed', atMs: 0 },
    );
    expect(navMayReroute(failed, 4_999)).toBe(false);
    expect(navMayReroute(failed, 5_000)).toBe(true);
    // An explicit tap is consent, and consent outranks a backoff.
    expect(navMayReroute(step(failed, { type: 'reroute-forced' }), 0)).toBe(true);
  });

  it('clears the “can’t reroute” notice back on the line without forgiving the backoff', () => {
    const failed = run(
      ...guiding,
      { type: 'reroute-started' },
      { type: 'reroute-failed', atMs: 0 },
    );
    const back = step(failed, { type: 'reroute-recovered' });
    expect(back.stage).toMatchObject({ reroute: { failed: false, backoffUntilMs: 5_000 } });
    // Nothing to clear twice: an unchanged machine must not cost a render.
    expect(step(back, { type: 'reroute-recovered' })).toBe(back);
  });

  it('banks the dying session’s distance and trims the stops it visited', () => {
    const replaced = run(
      ...guiding,
      { type: 'reroute-started' },
      { type: 'route-replaced', path: path(700_000), vias: [], bankedM: 420 },
    );
    expect(navPhase(replaced)).toBe('navigating');
    expect(navPlan(replaced)?.vias).toEqual([]);
    expect(navTripProgress(replaced, 10_000, 80)?.distanceM).toBe(500);
  });

  it('withdraws an offer measured against the route that just died', () => {
    const offered = run(...guiding, {
      type: 'faster-offered',
      offer: { path: path(300_000), vias: [], savesMs: 300_000, atMs: 5_000 },
    });
    expect(offered.stage).toMatchObject({ offer: { savesMs: 300_000 } });
    const replaced = step(offered, {
      type: 'route-replaced',
      path: path(700_000),
      vias: [],
      bankedM: 0,
    });
    expect(replaced.stage).toMatchObject({ offer: null });
  });

  it('remembers a dismissal as the bar the next offer must clear', () => {
    const dismissed = run(
      ...guiding,
      { type: 'faster-offered', offer: { path: path(), vias: [], savesMs: 180_000, atMs: 5_000 } },
      { type: 'faster-dismissed' },
    );
    expect(dismissed.stage).toMatchObject({ offer: null, dismissedSavingMs: 180_000 });
  });
});

describe('nav lifecycle — pause, resume and arrival', () => {
  it('stops the trip clock while paused and starts it again on Continue', () => {
    const trip = run(...guiding);
    expect(navTripProgress(trip, 70_000, 500)).toMatchObject({
      elapsedMs: 60_000,
      distanceM: 500,
      originalEstimateMs: 600_000,
    });
    const paused = step(trip, { type: 'pause', atMs: 70_000, traveledM: 500 });
    expect(navPhase(paused)).toBe('paused');
    // Time passes; a paused trip's elapsed does not.
    expect(navTripProgress(paused, 200_000, 500)?.elapsedMs).toBe(60_000);
    const resumed = step(paused, { type: 'continue-began', atMs: 200_000 });
    expect(navPhase(resumed)).toBe('navigating');
    expect(navTripProgress(resumed, 210_000, 500)?.elapsedMs).toBe(70_000);
  });

  it('does not count movement made while Atlas was paused as travel', () => {
    const resumed = run(
      ...guiding,
      { type: 'pause', atMs: 70_000, traveledM: 500 },
      { type: 'continue-began', atMs: 200_000 },
    );
    expect(resumed.stage).toMatchObject({ resumeAnchor: { fromTraveledM: 500 } });
    // The first fix back finds the traveller 300 m further along the line.
    const anchored = step(resumed, { type: 'resume-anchored', traveledM: 800 });
    expect(navTripProgress(anchored, 200_000, 800)?.distanceM).toBe(500);
    expect(anchored.stage).toMatchObject({ resumeAnchor: null });
    // Only the first fix re-anchors; progress counts normally from there.
    expect(step(anchored, { type: 'resume-anchored', traveledM: 900 })).toBe(anchored);
    expect(navTripProgress(anchored, 200_000, 900)?.distanceM).toBe(600);
  });

  it('keeps a failed Continue on the paused trip rather than losing it', () => {
    const failed = run(
      ...guiding,
      { type: 'pause', atMs: 70_000, traveledM: 500 },
      { type: 'continue-requested' },
      { type: 'continue-failed', message: 'Location request timed out' },
    );
    expect(navPhase(failed)).toBe('paused');
    expect(failed.pending).toBeNull();
    expect(navPath(failed)).toEqual(path());
    expect(failed.stage).toMatchObject({ error: 'Location request timed out' });
  });

  it('summarises the whole trip, reroutes and pauses included', () => {
    const arrived = run(
      ...guiding,
      { type: 'reroute-started' },
      { type: 'route-replaced', path: path(700_000), vias: [], bankedM: 400 },
      { type: 'pause', atMs: 70_000, traveledM: 300 },
      { type: 'continue-began', atMs: 200_000 },
      { type: 'resume-anchored', traveledM: 300 },
      { type: 'arrived', atMs: 260_000, traveledM: 900 },
    );
    expect(arrived.stage).toMatchObject({
      summary: {
        distanceM: 1300,
        durationMs: 120_000,
        // The engine's estimate at departure, unmoved by the reroute.
        originalEstimateMs: 600_000,
      },
    });
  });

  it('lets the traveller declare arrival on a paused trip', () => {
    const arrived = run(
      ...guiding,
      { type: 'pause', atMs: 70_000, traveledM: 500 },
      { type: 'arrived', atMs: 90_000, traveledM: 500 },
    );
    expect(navPhase(arrived)).toBe('arrived');
    // The paused interval is not billed to the trip.
    expect(arrived.stage).toMatchObject({ summary: { durationMs: 60_000, distanceM: 500 } });
  });

  it('cannot arrive twice, so the card is never re-announced', () => {
    const arrived = run(...guiding, { type: 'arrived', atMs: 20_000, traveledM: 900 });
    expect(step(arrived, { type: 'arrived', atMs: 21_000, traveledM: 900 })).toBe(arrived);
  });

  it('restores an interrupted trip’s own banks rather than starting from zero', () => {
    const resumed = run(
      { type: 'resume', plan: { destination: dest, vias: [] }, profile: 'car' },
      { type: 'origin-fixed', origin },
      {
        type: 'guidance-began',
        path: path(),
        atMs: 10_000,
        progress: { distanceM: 4_000, elapsedMs: 300_000, originalEstimateMs: 1_200_000 },
      },
    );
    expect(navPhase(resumed)).toBe('navigating');
    expect(navTripProgress(resumed, 20_000, 100)).toEqual({
      distanceM: 4_100,
      elapsedMs: 310_000,
      originalEstimateMs: 1_200_000,
    });
  });
});

describe('nav lifecycle — results that belong to a trip that has moved on', () => {
  it('ignores every trip event once the trip is over', () => {
    const idle = run(...guiding, { type: 'end' });
    const late: NavEvent[] = [
      { type: 'reroute-started' },
      { type: 'route-replaced', path: path(), vias: [], bankedM: 100 },
      { type: 'reroute-failed', atMs: 0 },
      { type: 'faster-offered', offer: { path: path(), vias: [], savesMs: 300_000, atMs: 0 } },
      { type: 'path-repriced', path: path(500_000) },
      { type: 'pause', atMs: 0, traveledM: 0 },
      { type: 'arrived', atMs: 0, traveledM: 0 },
      { type: 'continue-began', atMs: 0 },
      { type: 'resume-anchored', traveledM: 0 },
      { type: 'preview-selected', index: 0 },
      { type: 'profile-loaded', profile: 'bike', choices: [path()] },
    ];
    for (const event of late) expect(step(idle, event)).toBe(idle);
  });

  it('ignores a preview result for a trip that is already being guided', () => {
    const trip = run(...guiding);
    expect(step(trip, { type: 'choices-loaded', choices: [path()] })).toBe(trip);
    expect(step(trip, { type: 'origin-fixed', origin })).toBe(trip);
    expect(step(trip, { type: 'go' })).toBe(trip);
  });
});
