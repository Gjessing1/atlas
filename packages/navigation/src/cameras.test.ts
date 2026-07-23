import type { LatLng } from '@atlas/core';
import type { RouteCameras, RouteEnrichment, RoutePath } from '@atlas/routing';
import { describe, expect, it } from 'vitest';

import { cumulativeDistances, pointAtDistance } from './geometry.js';
import type { NavState, VoicePrompt } from './model.js';
import { NavigationSession } from './session.js';

// A straight eastward route at lat 60, ~55.6 m per step, ~5.5 km total.
const points: LatLng[] = Array.from({ length: 100 }, (_, i) => ({
  lat: 60,
  lng: 10 + i * 0.001,
}));
const cum = cumulativeDistances(points);
const totalM = cum[cum.length - 1]!;

const path: RoutePath = {
  points,
  distanceM: totalM,
  timeMs: 300_000,
  ascentM: 0,
  descentM: 0,
};

const T0 = 1_700_000_000_000;

/**
 * Feed 1 Hz fixes from `fromM` to `toM` at `speedMps`, collecting every state
 * and prompt. Time advances 1 s per fix, anchored so the fix at `fromM`
 * happens at `t0`.
 */
function drive(
  session: NavigationSession,
  fromM: number,
  toM: number,
  speedMps = 20,
  t0 = T0,
): { states: NavState[]; prompts: VoicePrompt[]; tEnd: number } {
  const states: NavState[] = [];
  const prompts: VoicePrompt[] = [];
  let t = t0;
  for (let m = fromM; m <= toM; m += speedMps) {
    const p = pointAtDistance(points, cum, m);
    const update = session.update(
      { lat: p.lat, lng: p.lng, speedMps, headingDeg: 90, accuracyM: 5 },
      t,
    );
    states.push(update.state);
    prompts.push(...update.prompts);
    t += 1000;
  }
  return { states, prompts, tEnd: t - 1000 };
}

const pointCamera = (atM: number, name = 'ATK'): RouteCameras => ({
  points: [{ atM, name }],
  sections: [],
});

const section = (startM: number, endM: number, name = 'S-ATK'): RouteCameras => ({
  points: [],
  sections: [{ startM, endM, name }],
});

describe('point camera guidance', () => {
  it('surfaces the camera in the chip window and counts it down', () => {
    const session = new NavigationSession(path);
    session.setCameras(pointCamera(3000), T0);
    const { states } = drive(session, 0, 900);
    // Still 2.1 km out at the end of this stretch: no chip yet.
    expect(states[states.length - 1]!.speedCamera).toBeNull();
    const { states: closer } = drive(session, 920, 2500, 20, T0 + 46_000);
    const shown = closer.filter((s) => s.speedCamera !== null);
    expect(shown.length).toBeGreaterThan(0);
    const last = shown[shown.length - 1]!.speedCamera!;
    expect(last.name).toBe('ATK');
    expect(last.distanceM).toBeGreaterThan(400);
    expect(last.distanceM).toBeLessThan(600);
  });

  it('speaks one alert on approach and drops the chip once passed', () => {
    const session = new NavigationSession(path);
    session.setCameras(pointCamera(3000), T0);
    const { states, prompts } = drive(session, 2000, 3500);
    const alerts = prompts.filter((p) => p.text.startsWith('Speed camera'));
    expect(alerts).toHaveLength(1);
    // At 20 m/s the lead is max(500 m, 20 s × 20 m/s) = 500 m.
    expect(alerts[0]!.text).toMatch(/^Speed camera in \d+ meters$/);
    // Chip gone shortly after the camera goes by.
    expect(states[states.length - 1]!.speedCamera).toBeNull();
  });

  it('never announces a camera that is already behind when data arrives', () => {
    const session = new NavigationSession(path);
    drive(session, 0, 1000);
    session.setCameras(pointCamera(800), T0 + 51_000);
    const { prompts } = drive(session, 1020, 1500, 20, T0 + 51_000);
    expect(prompts.filter((p) => p.text.startsWith('Speed camera'))).toHaveLength(0);
  });
});

describe('average-speed section guidance', () => {
  it('announces the section ahead with its length, once', () => {
    const session = new NavigationSession(path);
    session.setCameras(section(2000, 4000), T0);
    const { prompts } = drive(session, 1000, 2500);
    const alerts = prompts.filter((p) => p.text.includes('Average speed check ahead'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toBe('Average speed check ahead, for the next 2 kilometers');
  });

  it('tracks the running average from its own fixes while inside', () => {
    const session = new NavigationSession(path);
    session.setCameras(section(2000, 4000), T0);
    const { states, tEnd } = drive(session, 1000, 3500);
    const inside = states.filter((s) => s.sectionControl !== null);
    expect(inside.length).toBeGreaterThan(0);
    const last = inside[inside.length - 1]!.sectionControl!;
    expect(last.name).toBe('S-ATK');
    expect(last.remainingM).toBeGreaterThan(400);
    expect(last.remainingM).toBeLessThan(600);
    // Constant 20 m/s = 72 km/h, measured over the driven stretch.
    expect(last.avgKph).toBe(72);
    // Leaving the section ends the state and confirms completion.
    const { states: after, prompts: exitPrompts } = drive(session, 3520, 4300, 20, tEnd + 1000);
    expect(after[after.length - 1]!.sectionControl).toBeNull();
    expect(exitPrompts.filter((p) => p.text === 'Average speed check complete')).toHaveLength(1);
  });

  it('withholds the average when the entry crossing was not observed', () => {
    const session = new NavigationSession(path);
    // Guidance is already mid-section when the camera data lands.
    drive(session, 0, 3000);
    session.setCameras(section(2000, 4000), T0 + 151_000);
    const { states, prompts } = drive(session, 3020, 3600, 20, T0 + 151_000);
    const inside = states.filter((s) => s.sectionControl !== null);
    expect(inside.length).toBeGreaterThan(0);
    // Honest: remaining distance yes, an average we did not measure no.
    expect(inside[inside.length - 1]!.sectionControl!.avgKph).toBeNull();
    const entered = prompts.filter((p) => p.text.startsWith('Average speed check for the next'));
    expect(entered).toHaveLength(1);
  });

  it('reads the section limit from the route enrichment', () => {
    const session = new NavigationSession(path);
    const enrichment: RouteEnrichment = {
      segments: [{ startM: 1500, endM: 4500, speedLimitKph: 80 }],
    };
    session.setEnrichment(enrichment);
    session.setCameras(section(2000, 4000), T0);
    const { states } = drive(session, 1900, 2600);
    const inside = states.find((s) => s.sectionControl !== null)!;
    expect(inside.sectionControl!.limitKph).toBe(80);
  });
});
