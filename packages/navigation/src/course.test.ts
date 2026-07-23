import { describe, expect, it } from 'vitest';

import { CourseFuser } from './course.js';

/** Shortest angle between two bearings, for tolerance assertions. */
function apart(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

const DRIVING = 15; // m/s

describe('CourseFuser', () => {
  it('takes the first route course whole — no easing in from north', () => {
    const f = new CourseFuser();
    expect(f.bearingDeg).toBeNull();
    expect(f.syncTo(270, DRIVING)).toBe(270);
  });

  it('turns with the gyro between fixes, before the route line does', () => {
    const f = new CourseFuser();
    f.syncTo(0, DRIVING);
    // Half a second into a 30°/s right-hand turn, with no new fix yet.
    for (let i = 0; i < 5; i++) f.applyYaw(3, 0.1, DRIVING);
    expect(f.bearingDeg).toBeCloseTo(15, 5);
  });

  it('pulls back to the route course rather than snapping to it', () => {
    const f = new CourseFuser();
    f.syncTo(0, DRIVING);
    // Gyro drifted 10° that the route never saw.
    for (let i = 0; i < 10; i++) f.applyYaw(1, 0.1, DRIVING);
    const after = f.syncTo(0, DRIVING)!;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(10);
    // …and keeps pulling: the error is gone within a few fixes.
    for (let i = 0; i < 10; i++) f.syncTo(0, DRIVING);
    expect(apart(f.bearingDeg!, 0)).toBeLessThan(0.5);
  });

  it('wraps across north instead of taking the long way round', () => {
    const f = new CourseFuser();
    f.syncTo(350, DRIVING);
    f.syncTo(10, DRIVING);
    // 20° of error closed by the gain, forwards through 0 — not 340° back.
    expect(f.bearingDeg!).toBeGreaterThan(350);
    f.applyYaw(20, 1, DRIVING);
    expect(f.bearingDeg!).toBeLessThan(30);
  });

  it('ignores a phone being picked up, not a car turning', () => {
    const f = new CourseFuser();
    f.syncTo(90, DRIVING);
    f.applyYaw(40, 0.1, DRIVING); // 400°/s — no vehicle does this
    expect(f.bearingDeg).toBe(90);
  });

  it('leaves the gyro out entirely while the vehicle is stopped', () => {
    const f = new CourseFuser();
    f.syncTo(90, 0);
    for (let i = 0; i < 20; i++) f.applyYaw(4, 0.1, 0);
    expect(f.bearingDeg).toBe(90);
    // Stopped, the route course is also taken whole — no lag at the lights.
    expect(f.syncTo(180, 0)).toBe(180);
  });

  it('gives up on a runaway heading and takes the route course', () => {
    const f = new CourseFuser();
    f.syncTo(0, DRIVING);
    // A gyro that quietly integrated a phone reorientation: 60° of nonsense.
    for (let i = 0; i < 60; i++) f.applyYaw(1, 0.1, DRIVING);
    expect(f.syncTo(0, DRIVING)).toBeCloseTo(0, 5);
  });

  it('holds the last heading when there is no route course to sync to', () => {
    const f = new CourseFuser();
    f.syncTo(120, DRIVING);
    expect(f.syncTo(null, DRIVING)).toBe(120);
  });

  it('does not integrate yaw before it knows where it is pointing', () => {
    const f = new CourseFuser();
    f.applyYaw(10, 0.5, DRIVING);
    expect(f.bearingDeg).toBeNull();
  });

  it('tracks a full 90° junction turn and settles on the new road', () => {
    const f = new CourseFuser();
    f.syncTo(0, 8);
    // Three seconds of steady 30°/s yaw, with a fix each second reporting the
    // route course that the turn has reached by then.
    const routeCourseAfterSecond = [30, 60, 90];
    for (const course of routeCourseAfterSecond) {
      for (let i = 0; i < 10; i++) f.applyYaw(3, 0.1, 8);
      f.syncTo(course, 8);
    }
    expect(apart(f.bearingDeg!, 90)).toBeLessThan(2);
  });
});
