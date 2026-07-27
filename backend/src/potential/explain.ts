import type { LatLng } from '@atlas/core';
import {
  explainPoint,
  type CombineTerm,
  type Grid,
  type PotentialExplanation,
} from '@atlas/potential';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { readSignal, signalsPath, SIGNAL_PIXELS, type CellManifest } from './derive.js';
import type { Cell } from './cells.js';
import type { DeriveModel } from './models.js';

/**
 * Reading a derived cell's persisted signal planes back into an answer.
 *
 * Two routes need exactly this and must not drift apart: `/explain` answers
 * "why is this point good?" for one tapped coordinate, and `/spots` asks the
 * same question of the eight points it is about to recommend. If the shortlist
 * computed its own reasons, a spot's row and the card the user opens by tapping
 * that same spot could give different answers about the same pixel — which is
 * the one thing a surface that exists to be trusted cannot do.
 *
 * Nothing here recomputes the model. The planes on disk *are* the arithmetic
 * that drew the pixels; re-running it would be a second implementation.
 */

/** A cell's signal blob, or null when it has none (or the file is gone). */
export async function loadSignals(
  dataDir: string,
  model: DeriveModel,
  target: string,
  cell: Cell,
  manifest: CellManifest,
): Promise<Buffer | null> {
  if (!manifest.signals) return null;
  return readFile(signalsPath(dataDir, model, target, cell))
    .then((raw) => gunzipSync(raw))
    .catch(() => null);
}

/** Which signal sample covers a coordinate. Values outside 0..pixels are off-cell. */
export function sampleIndexAt(
  manifest: CellManifest,
  at: LatLng,
): { readonly sx: number; readonly sy: number } {
  const [west, south, east, north] = manifest.bounds;
  const pixels = manifest.signals?.pixels ?? SIGNAL_PIXELS;
  return {
    sx: Math.floor(((at.lng - west) / (east - west)) * pixels),
    sy: Math.floor(((north - at.lat) / (north - south)) * pixels),
  };
}

/**
 * The centre of a signal sample, in WGS84.
 *
 * The *centre*, not the corner: a spot marker sits where the map draws the
 * hottest pixel, and half a sample (~19 m) of systematic offset toward the
 * north-west would be visible on a shoreline at z13.
 */
export function sampleCentre(manifest: CellManifest, sx: number, sy: number): LatLng {
  const [west, south, east, north] = manifest.bounds;
  const pixels = manifest.signals?.pixels ?? SIGNAL_PIXELS;
  return {
    lng: west + ((sx + 0.5) / pixels) * (east - west),
    lat: north - ((sy + 0.5) / pixels) * (north - south),
  };
}

/**
 * Explain one signal sample, in the weather card's factor shape.
 *
 * A 1×1 grid per term so `explainPoint` — the same function the golden tests
 * drive — does the weighting, the renormalisation over present factors and the
 * wording. The `describe` closure cannot be persisted, so each term's sentence
 * is re-derived from its key and value; `derivedAt` is passed because a seasonal
 * band shifts, and the card must describe the surface that was *built*.
 */
export function explainSample(
  model: DeriveModel,
  target: string,
  manifest: CellManifest,
  blob: Buffer,
  sx: number,
  sy: number,
): PotentialExplanation {
  const one = (value: number): Grid => ({
    width: 1,
    height: 1,
    cellSizeM: manifest.cellSizeM,
    data: Float32Array.of(value),
  });
  const terms: CombineTerm[] = (manifest.signals?.terms ?? []).map((term, i) => ({
    key: term.key,
    label: term.label,
    weight: term.weight,
    // Plane 0 is the rank, so the terms start at 1.
    grid: one(readSignal(blob, i + 1, sx, sy)),
    describe: (value) =>
      model.describeSignal?.(term.key, value, target, manifest.derivedAt) ??
      `${term.label}: ${Math.round(value * 100)} %`,
  }));
  return explainPoint(terms, 0, 0, {
    rank: one(readSignal(blob, 0, sx, sy)),
    vocabulary: model.vocabulary,
  });
}
