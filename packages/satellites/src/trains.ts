/** Freshly launched batches still flying as a chain. */

import type { SatelliteOmm } from './elements.js';
import { groundAngleDeg, meanAltitudeKm, subpointAt, EARTH_RADIUS_KM } from './propagate.js';

/**
 * Below the operational shells. Starlink inserts a batch at roughly 320 km and
 * raises it to 450-550 over the following weeks, so altitude alone separates
 * "launched days ago" from the 8969-of-11086 objects sitting in the 450-500 km
 * band — without needing a launch date, which OMM does not carry.
 */
export const TRAIN_MAX_ALTITUDE_KM = 400;

/**
 * How close consecutive objects must still be to read as one chain.
 *
 * This is the measure of a train that matches what a person sees: not how much
 * of the orbit the batch occupies, but the gap between neighbours, because that
 * gap is the pause between one bead and the next crossing the same sky. 400 km
 * is a touch under a minute at orbital speed. A batch that has finished
 * dispersing sits at 600-1300.
 */
export const TRAIN_MAX_SPACING_KM = 400;

/**
 * A launch, not a coincidence. Starlink flies 20-30 per launch; anything
 * smaller sharing a designator is a rideshare's leftovers.
 */
export const TRAIN_MIN_MEMBERS = 8;

export interface SatelliteTrain {
  /** The international designator the batch shares, e.g. `2026-197`. */
  launchId: string;
  /** Members, ascending. NORAD numbers within one launch are contiguous. */
  noradIds: number[];
  /** Median altitude of the batch, km. */
  altitudeKm: number;
  /** Median gap between neighbours, km. */
  spacingKm: number;
  /** What that gap costs a watcher: seconds between one object and the next. */
  spacingSeconds: number;
}

export interface TrainOptions {
  at?: Date;
  maxAltitudeKm?: number;
  maxSpacingKm?: number;
  minMembers?: number;
}

/**
 * The launch half of an international designator — `2026-197A` → `2026-197`.
 *
 * Every object from one launch shares it, which is what makes a batch
 * identifiable without any external catalog. Returns null for the handful of
 * records whose designator is missing or malformed rather than inventing a
 * group for them.
 */
export function launchIdOf(omm: Pick<SatelliteOmm, 'OBJECT_ID'>): string | null {
  const match = /^(\d{4}-\d{3})/.exec(omm.OBJECT_ID ?? '');
  return match ? match[1]! : null;
}

/** Lower-middle element — no interpolation, so the value is always a real one. */
function median(sorted: readonly number[]): number {
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

/**
 * Batches still flying as a train: launched together, still low, still nose to
 * tail.
 *
 * Deliberately measured from *propagated positions* rather than from the
 * elements' own angles. Elements within one batch are published up to 40 hours
 * apart, and phase advances a full revolution every 91 minutes, so comparing
 * `MEAN_ANOMALY` across a batch compares positions up to 26 revolutions out of
 * step — a number that looks like a bunching measure and is noise. Propagating
 * to one instant is the only way the question has an answer, and SGP4 absorbs
 * the differing epochs, nodal precession and drag on the way.
 *
 * Three tests, in increasing cost, so the expensive one only ever sees a few
 * dozen candidates out of eleven thousand objects:
 *
 * 1. a shared launch designator with enough members,
 * 2. a median altitude below the operational shells — from mean motion, which
 *    is epoch-independent arithmetic rather than propagation,
 * 3. neighbours still within `maxSpacingKm` of each other on the ground.
 *
 * The third test is what makes the flag expire on its own: as a batch raises
 * and spreads, the spacing grows past the threshold and the train stops being
 * called one, with no launch date and no maintained list anywhere.
 */
export function freshTrains(
  elements: readonly SatelliteOmm[],
  options: TrainOptions = {},
): SatelliteTrain[] {
  const at = options.at ?? new Date();
  const maxAltitudeKm = options.maxAltitudeKm ?? TRAIN_MAX_ALTITUDE_KM;
  const maxSpacingKm = options.maxSpacingKm ?? TRAIN_MAX_SPACING_KM;
  const minMembers = options.minMembers ?? TRAIN_MIN_MEMBERS;

  const byLaunch = new Map<string, SatelliteOmm[]>();
  for (const omm of elements) {
    const launchId = launchIdOf(omm);
    if (!launchId) continue;
    const members = byLaunch.get(launchId);
    if (members) members.push(omm);
    else byLaunch.set(launchId, [omm]);
  }

  const trains: SatelliteTrain[] = [];
  for (const [launchId, members] of byLaunch) {
    if (members.length < minMembers) continue;
    const meanAltitudes = members.map(meanAltitudeKm).sort((a, b) => a - b);
    if (median(meanAltitudes) >= maxAltitudeKm) continue;

    // Only now, for a few dozen objects, is propagation worth its cost.
    const fixes = members.map((omm) => subpointAt(omm, at)).filter((fix) => fix !== null);
    if (fixes.length < minMembers) continue;

    const gaps = fixes
      .map((fix, index) => {
        let nearest = Infinity;
        for (let other = 0; other < fixes.length; other++) {
          if (other === index) continue;
          const km = (groundAngleDeg(fix, fixes[other]!) * Math.PI * EARTH_RADIUS_KM) / 180;
          if (km < nearest) nearest = km;
        }
        return nearest;
      })
      .sort((a, b) => a - b);
    const spacingKm = median(gaps);
    if (!Number.isFinite(spacingKm) || spacingKm >= maxSpacingKm) continue;

    const altitudes = fixes.map((fix) => fix.altitudeKm).sort((a, b) => a - b);
    const altitudeKm = median(altitudes);
    // Ground speed, not orbital speed: the chain crosses the sky at the rate
    // its shadow crosses the ground, which is slower by the altitude ratio.
    const speeds = fixes
      .map((fix) => (fix.speedKmS * EARTH_RADIUS_KM) / (EARTH_RADIUS_KM + fix.altitudeKm))
      .sort((a, b) => a - b);
    const groundSpeedKmS = median(speeds);

    trains.push({
      launchId,
      noradIds: fixes.map((fix) => fix.noradId).sort((a, b) => a - b),
      altitudeKm,
      spacingKm,
      spacingSeconds: groundSpeedKmS > 0 ? spacingKm / groundSpeedKmS : 0,
    });
  }
  // Tightest first: the one most worth going outside for leads.
  return trains.sort((a, b) => a.spacingKm - b.spacingKm);
}

/**
 * Whether two readings of the trains say the same thing.
 *
 * Both clients recompute on a slow cadence and hand the result to React, where
 * an equal-but-new array would re-render a card's whole pass list for nothing —
 * and the answer here is the same for days at a time.
 */
export function sameTrains(a: readonly SatelliteTrain[], b: readonly SatelliteTrain[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (train, index) =>
        train.launchId === b[index]!.launchId &&
        train.noradIds.length === b[index]!.noradIds.length,
    )
  );
}

/** Every object currently flying in a train, for a per-object lookup. */
export function trainMembers(trains: readonly SatelliteTrain[]): Set<number> {
  const members = new Set<number>();
  for (const train of trains) for (const noradId of train.noradIds) members.add(noradId);
  return members;
}

/** The train a selected object belongs to, if any. */
export function trainOf(
  trains: readonly SatelliteTrain[],
  noradId: number | null,
): SatelliteTrain | null {
  if (noradId === null) return null;
  return trains.find((train) => train.noradIds.includes(noradId)) ?? null;
}
