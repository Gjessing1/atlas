import type { RouteInstruction, RoutePath } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import {
  compactMatchTrace,
  compactNavState,
  FIX_GAP_MS,
  NavRouteLedger,
  NavTripStats,
  navTripSample,
  navTripSampleFromLog,
  routeDigest,
} from './diagnostics.js';
import { analyzeNavLog, formatNavLogReport } from './navlog.js';
import type { NavMatchTrace, NavState } from './model.js';

function instruction(text: string, interval: [number, number]): RouteInstruction {
  return {
    text,
    distanceM: 400,
    timeMs: 30_000,
    sign: 2,
    interval,
    // The four verbal strings are exactly the bytes the compaction exists to
    // stop repeating once a second for a whole drive.
    verbalTransitionAlertInstruction: `${text} — alert`,
    verbalPreTransitionInstruction: `${text} — pre`,
    verbalPostTransitionInstruction: `${text} — post`,
    verbalSuccinctTransitionInstruction: `${text} — succinct`,
  } as RouteInstruction;
}

function path(points: { lat: number; lng: number }[]): RoutePath {
  return {
    points,
    distanceM: 1200,
    timeMs: 90_000,
    instructions: [instruction('Turn right onto Storgata', [0, 1])],
  } as RoutePath;
}

function state(overrides: Partial<NavState> = {}): NavState {
  return {
    status: 'navigating',
    snapped: { lat: 59.9127301234567, lng: 10.7524509876543 },
    raw: { lat: 59.9127311234567, lng: 10.7524519876543 },
    offRouteM: 3.14159,
    traveledM: 1234.5678,
    trailM: 1234.5678,
    routeProgress: 0.5,
    displayRouteProgress: 0.5,
    distanceRemainingM: 4321.8765,
    timeRemainingMs: 300_000,
    etaEpochMs: 1_700_000_000_000,
    upcoming: {
      instruction: instruction('Turn right onto Storgata', [0, 1]),
      index: 4,
      distanceToM: 212.345,
    },
    then: null,
    sustain: null,
    laneGuidance: null,
    currentRoad: 'E18',
    speedLimitKph: 80,
    tunnel: null,
    speedCamera: null,
    sectionControl: null,
    departed: true,
    viasPassed: 0,
    fix: 'live',
    wrongBranch: false,
    courseDeg: 187.654321,
    ...overrides,
  };
}

const match: NavMatchTrace = {
  alongM: 1234.5678,
  segmentIndex: 12,
  crossTrackM: 3.14159,
  accuracyM: 4.2,
  accurate: true,
  headingDeg: 187.4,
  tangentDeg: 12.1,
  headingDivergenceDeg: 175.3,
  offRouteCount: 0,
  wrongWayCount: 3,
  graceUpdates: 4,
  progressStalled: false,
  stallDurationMs: 4000,
  stallGroundM: 79,
  stallProgressM: 21,
  corridorM: 40,
  wrongWayDeg: 120,
  snapCorridorM: 25,
  snapped: true,
  reckonArmed: true,
  inRoundabout: false,
};

describe('compactNavState', () => {
  it('references the maneuver by index instead of repeating its text', () => {
    const compact = compactNavState(state());
    expect(compact.upcoming).toEqual([4, 212.3]);
    // 57 % of the old log was this record carrying the full instruction and
    // all four verbal strings, once a second.
    expect(JSON.stringify(compact)).not.toContain('Storgata');
    expect(JSON.stringify(compact)).not.toContain('succinct');
  });

  it('rounds every number to the precision it actually has', () => {
    const compact = compactNavState(state());
    expect(compact.snapped).toEqual([59.91273, 10.752451]);
    expect(compact.offRouteM).toBe(3.1);
    expect(compact.traveledM).toBe(1234.6);
    expect(compact.courseDeg).toBe(187.7);
    expect(JSON.stringify(compact).length).toBeLessThan(400);
  });

  it("keeps the matcher's own reasoning, thresholds included", () => {
    const compact = compactMatchTrace(match);
    expect(compact).toMatchObject({
      seg: 12,
      crossM: 3.1,
      wrongWayCount: 3,
      grace: 4,
      progressStalled: false,
      stallMs: 4000,
      stallGroundM: 79,
      stallProgressM: 21,
      corridorM: 40,
      wrongWayDeg: 120,
      snapped: true,
    });
  });
});

describe('NavRouteLedger', () => {
  it('stores a route geometry once and fingerprints every later mention', () => {
    const ledger = new NavRouteLedger();
    const line = [
      { lat: 59.91, lng: 10.75 },
      { lat: 59.92, lng: 10.76 },
    ];
    const first = ledger.note(path(line));
    const again = ledger.note(path(line.map((p) => ({ ...p }))));
    expect(first.geometry).not.toBeNull();
    expect(again.geometry).toBeNull();
    expect(again.fingerprint.digest).toBe(first.fingerprint.digest);
  });

  it('separates two different lines, and a prefix of one from the whole', () => {
    const long = [
      { lat: 59.91, lng: 10.75 },
      { lat: 59.92, lng: 10.76 },
      { lat: 59.93, lng: 10.77 },
    ];
    expect(routeDigest(long)).not.toBe(routeDigest(long.slice(0, 2)));
    expect(routeDigest(long)).not.toBe(
      routeDigest([...long.slice(0, 2), { lat: 59.94, lng: 10.78 }]),
    );
  });
});

describe('NavTripStats', () => {
  it('measures what a report opens with, from the states guidance produced', () => {
    const stats = new NavTripStats();
    let atMs = 1_700_000_000_000;
    // Ten seconds on route, five off it, ten with no live fix.
    for (let i = 0; i < 10; i++) {
      stats.sample(navTripSample(state({ traveledM: i * 20 }), 5), (atMs += 1000));
    }
    for (let i = 0; i < 5; i++) {
      stats.sample(
        navTripSample(state({ status: 'off-route', traveledM: 200, offRouteM: 61 }), 90),
        (atMs += 1000),
      );
    }
    stats.routeAdopted(200);
    for (let i = 0; i < 10; i++) {
      stats.sample(
        navTripSample(
          state({
            fix: 'estimated',
            traveledM: i * 20,
            // A reckoned position is drawn on the line, so it counts as snapped.
            raw: { lat: 0, lng: 0 },
          }),
          null,
        ),
        (atMs += 1000),
      );
    }
    stats.promptEmitted();
    stats.markerAdded();
    const report = stats.report();

    expect(report.samples).toBe(25);
    expect(report.durationMs).toBe(24_000);
    // The banked 200 m from the replaced route plus the new session's own.
    expect(report.distanceM).toBe(380);
    expect(report.offRouteMs).toBe(5000);
    expect(report.reckonedMs).toBe(9000);
    expect(report.noLiveFixMs).toBe(9000);
    expect(report.snappedShare).toBe(1);
    expect(report.maxOffRouteM).toBe(61);
    expect(report.worstAccuracyM).toBe(90);
    // The route departed on is not a change; the reroute is.
    expect(report.routeChanges).toBe(0);
    expect(report.prompts).toBe(1);
    expect(report.markers).toBe(1);
  });

  it('can subtract a shared prefix when a departure route is selected mid-trip', () => {
    const stats = new NavTripStats();
    stats.sample(navTripSample(state({ traveledM: 200 }), 5), 1000);
    stats.routeAdopted(-50);
    stats.sample(navTripSample(state({ traveledM: 250 }), 5), 2000);

    expect(stats.report().distanceM).toBe(200);
  });

  it('counts a break between states as a gap, not as elapsed navigation', () => {
    const stats = new NavTripStats();
    const atMs = 1_700_000_000_000;
    stats.sample(navTripSample(state()), atMs);
    stats.sample(navTripSample(state()), atMs + FIX_GAP_MS + 5400);
    const report = stats.report();
    expect(report.fixGaps).toBe(1);
    expect(report.maxFixGapMs).toBe(FIX_GAP_MS + 5400);
  });

  it('rebuilds the same sample from a logged record as from the live state', () => {
    const live = navTripSample(state(), 4.2);
    const logged = navTripSampleFromLog(compactNavState(state()), 4.2);
    expect(logged.status).toBe(live.status);
    expect(logged.fix).toBe(live.fix);
    expect(logged.snapped).toBe(live.snapped);
    expect(logged.offRouteM).toBeCloseTo(live.offRouteM, 0);
  });

  it('records the rendered trail boundary separately from matched progress', () => {
    const logged = compactNavState(state({ traveledM: 125.6, trailM: 98.4 }));
    expect(logged.traveledM).toBe(125.6);
    expect(logged.trailM).toBe(98.4);
  });
});

/** One line of a log, the way the app writes it. */
function line(atMs: number, record: Record<string, unknown>): string {
  return JSON.stringify({ at: new Date(atMs).toISOString(), appVersion: '0.203.0', ...record });
}

describe('analyzeNavLog', () => {
  const startMs = Date.parse('2026-09-10T14:43:03.000Z');

  function log(): string {
    const lines = [
      line(startMs, {
        event: 'trip-start',
        trip: 'abc',
        profile: 'car',
        activity: 'guidance',
        destination: [59.91, 10.75],
      }),
      line(startMs + 1000, { event: 'route-request', trip: 'abc', reason: 'preview' }),
      line(startMs + 2200, {
        event: 'route-result',
        trip: 'abc',
        reason: 'preview',
        choices: 3,
        route: { digest: 'aaaa1111', distanceM: 34200, timeMs: 1_800_000, maneuvers: 42 },
      }),
      line(startMs + 3000, {
        event: 'route-adopted',
        trip: 'abc',
        reason: 'departure',
        bankedM: 0,
        route: { digest: 'aaaa1111', distanceM: 34200, timeMs: 1_800_000, maneuvers: 42 },
      }),
      line(startMs + 3500, {
        event: 'map-route-layers',
        trip: 'abc',
        activeDigest: 'aaaa1111',
        lineDigest: 'aaaa1111',
        alternatives: [{ digest: 'bbbb2222', start: { lat: 59.9, lng: 10.7 } }],
      }),
    ];
    for (let i = 0; i < 5; i++) {
      lines.push(
        line(startMs + 4000 + i * 1000, {
          event: 'navigation-state',
          trip: 'abc',
          state: compactNavState(state({ traveledM: i * 20 })),
          match: compactMatchTrace(match),
        }),
      );
    }
    lines.push(
      line(startMs + 9000, {
        event: 'navigation-state',
        trip: 'abc',
        state: compactNavState(state({ status: 'off-route', offRouteM: 61, traveledM: 100 })),
        match: compactMatchTrace({ ...match, crossTrackM: 61, offRouteCount: 4 }),
      }),
      line(startMs + 9500, {
        event: 'voice-prompt',
        trip: 'abc',
        kind: 'approach',
        maneuverIndex: 4,
        thresholdM: 200,
        text: 'In 200 meters, turn right',
        spoken: true,
      }),
      line(startMs + 10_000, { event: 'user-marker', trip: 'abc', note: 'wrong roundabout exit' }),
      line(startMs + 11_000, {
        event: 'faster-probe',
        trip: 'abc',
        verdict: 'rejected',
        plannedMs: 900_000,
        candidateMs: 890_000,
        savesMs: 10_000,
      }),
      line(startMs + 20_000, {
        event: 'navigation-state',
        trip: 'abc',
        state: compactNavState(state({ fix: 'lost' })),
        match: compactMatchTrace(match),
      }),
      line(startMs + 21_000, {
        event: 'trip-end',
        trip: 'abc',
        outcome: 'ended-early',
        report: {
          samples: 7,
          durationMs: 16_000,
          distanceM: 380,
          offRouteMs: 500,
          noLiveFixMs: 0,
          reckonedMs: 0,
          lostMs: 0,
          snappedShare: 1,
          routeChanges: 0,
          routeFailures: 0,
          prompts: 1,
          markers: 1,
          fixGaps: 1,
          maxFixGapMs: 9000,
          worstAccuracyM: 4,
          maxOffRouteM: 61,
        },
      }),
      'not json at all',
    );
    return lines.join('\n');
  }

  it('splits a file into trips and keeps what each one was', () => {
    const analysis = analyzeNavLog(log());
    expect(analysis.trips).toHaveLength(1);
    expect(analysis.unreadableLines).toBe(1);
    const [trip] = analysis.trips;
    expect(trip?.id).toBe('abc');
    expect(trip?.profile).toBe('car');
    expect(trip?.outcome).toBe('ended-early');
    expect(trip?.appVersion).toBe('0.203.0');
    expect(trip?.destination).toEqual([59.91, 10.75]);
  });

  it('names the incidents a report has to hunt for by hand today', () => {
    const [trip] = analyzeNavLog(log()).trips;
    const kinds = (trip?.incidents ?? []).map((incident) => incident.kind);
    expect(kinds).toContain('route');
    expect(kinds).toContain('route-adopted');
    expect(kinds).toContain('map-route-layers');
    expect(kinds).toContain('off-route');
    expect(kinds).toContain('corridor');
    expect(kinds).toContain('marker');
    expect(kinds).toContain('faster-probe');
    expect(kinds).toContain('fix-gap');
    expect(kinds).toContain('prompt');

    const offRoute = trip?.incidents.find((incident) => incident.kind === 'off-route');
    // The counter and the threshold it crossed, so nobody re-derives them from
    // raw headings and route geometry.
    expect(offRoute?.detail).toContain('offRouteCount 4/4');
    const marker = trip?.incidents.find((incident) => incident.kind === 'marker');
    expect(marker?.detail).toBe('wrong roundabout exit');
    expect(marker?.offsetMs).toBe(10_000);
    expect(trip?.incidents.find((incident) => incident.kind === 'map-route-layers')?.detail).toBe(
      'active aaaa1111 · drawn aaaa1111 · grey bbbb2222',
    );
  });

  it('rebuilds the summary from the records, beside the one the app wrote', () => {
    const [trip] = analyzeNavLog(log()).trips;
    expect(trip?.measured.samples).toBe(7);
    expect(trip?.measured.markers).toBe(1);
    expect(trip?.measured.prompts).toBe(1);
    expect(trip?.measured.maxOffRouteM).toBe(61);
    expect(trip?.reported?.distanceM).toBe(380);
    expect(trip?.routes.find((route) => route.digest === 'aaaa1111')?.adopted).toBe(1);
  });

  it('rebuilds a summary for a trip that never wrote a trip-end', () => {
    const truncated = log().split('\n').slice(0, 10).join('\n');
    const [trip] = analyzeNavLog(truncated).trips;
    expect(trip?.outcome).toBeNull();
    expect(trip?.reported).toBeNull();
    expect(trip?.measured.samples).toBeGreaterThan(0);
  });

  it('prints a report with the summary above the timeline', () => {
    const text = formatNavLogReport(analyzeNavLog(log()));
    expect(text).toContain('Trip abc · car');
    expect(text).toContain('ended-early');
    expect(text).toContain('Timeline');
    // Prompts are hidden unless asked for; a drive emits a hundred of them.
    expect(text).not.toContain('In 200 meters, turn right');
    expect(formatNavLogReport(analyzeNavLog(log()), { include: ['prompt'] })).toContain(
      'In 200 meters, turn right',
    );
  });
});
