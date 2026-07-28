/**
 * The measure / radius tool's model: what a measurement *is*, what it draws and
 * what it says — with no map library and no UI framework in sight.
 *
 * It lives here rather than in either app because the tool is the same tool on
 * both: a click-to-add distance ruler and drop-a-circle range rings, for hunt
 * line-of-sight and general planning. The geometry it builds on
 * (`circleFeature`/`destinationPoint`/`pathLengthM`) was already shared; this
 * module is what turns that geometry into the one feature collection both map
 * scenes draw and the one set of words both panels show.
 */

import { fmtKm } from './format.js';
import { circleFeature, destinationPoint, haversineM, pathLengthM, type LatLng } from './geo.js';

/** Distance ruler, or range rings around dropped centres. */
export type MeasureMode = 'distance' | 'radius';

/**
 * Ring radii offered as presets, metres. Multi-select — a stand often wants two
 * rings at once (the shot you would take and the one you would not).
 */
export const MEASURE_RADII_M: readonly number[] = [50, 100, 200, 300, 500];

/** Radii a fresh measurement starts with. */
export const MEASURE_DEFAULT_RADII_M: readonly number[] = [100, 200];

/**
 * The hints, deliberately verb-free. "Click" is wrong on a phone and "tap" is
 * wrong on a desktop mouse, and the two clients used to be free to pick
 * differently — which is exactly the drift §7 exists to stop.
 */
export const MEASURE_DISTANCE_HINT = 'Add points along a line to measure it.';
export const MEASURE_RADIUS_HINT = 'Drop a circle to see range rings around it.';

/** A ring radius as a label: metres below a kilometre, whole km above. */
export function fmtRadius(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

/** Everything a measurement consists of; the clients hold exactly this. */
export interface MeasureState {
  readonly mode: MeasureMode;
  /** Vertices of the ruler line, in the order they were added. */
  readonly points: readonly LatLng[];
  /** Centres of the dropped range-ring stacks. */
  readonly centers: readonly LatLng[];
  /** Which preset radii are currently drawn around every centre. */
  readonly radii: readonly number[];
}

/** What the panel says about the current measurement. */
export interface MeasureReadout {
  /** The total, when there is one to state. */
  readonly headline: string | null;
  /** A secondary line: the straight-line distance, or the circle count. */
  readonly detail: string | null;
  /** What to do, shown only while the measurement is empty. */
  readonly hint: string | null;
}

/** The numbers a distance measurement carries, before they become words. */
export function measureTotals(points: readonly LatLng[]): { totalM: number; straightM: number } {
  const path = [...points];
  return {
    totalM: pathLengthM(path),
    straightM: path.length >= 2 ? haversineM(path[0]!, path[path.length - 1]!) : 0,
  };
}

/** Whether the measurement has anything to undo or clear in its current mode. */
export function measureHasWork(state: MeasureState): boolean {
  return state.mode === 'distance' ? state.points.length > 0 : state.centers.length > 0;
}

/** The one readout both panels render, so neither can word it its own way. */
export function measureReadout(state: MeasureState): MeasureReadout {
  if (state.mode === 'distance') {
    if (state.points.length < 2) {
      return { headline: null, detail: null, hint: MEASURE_DISTANCE_HINT };
    }
    const { totalM, straightM } = measureTotals(state.points);
    return {
      headline: fmtKm(totalM),
      // Only worth saying when the line actually bends — on a two-point
      // measurement it would restate the headline.
      detail: straightM > 0 && straightM !== totalM ? `straight line ${fmtKm(straightM)}` : null,
      hint: null,
    };
  }
  if (state.centers.length === 0) {
    return { headline: null, detail: null, hint: MEASURE_RADIUS_HINT };
  }
  return {
    headline: null,
    detail: `${state.centers.length} ${state.centers.length === 1 ? 'circle' : 'circles'}`,
    hint: null,
  };
}

/**
 * The measurement as map data: the ruler line with a running total at every
 * vertex, or each centre with its rings labelled due north of it.
 *
 * `kind` (`path` / `point` / `ring` / `label`) is what both scenes filter their
 * layers on, so the two draw the same thing from the same properties.
 */
export function measureFeatures(state: MeasureState): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (state.mode === 'distance') {
    const points = [...state.points];
    if (points.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { kind: 'path' },
        geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
      });
    }
    points.forEach((p, i) => {
      features.push({
        type: 'Feature',
        properties: { kind: 'point' },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      });
      // Running total sits at each vertex from the second one on.
      if (i > 0) {
        features.push({
          type: 'Feature',
          properties: { kind: 'label', text: fmtKm(pathLengthM(points.slice(0, i + 1))) },
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        });
      }
    });
    return { type: 'FeatureCollection', features };
  }
  for (const c of state.centers) {
    features.push({
      type: 'Feature',
      properties: { kind: 'point' },
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
    });
    for (const r of state.radii) {
      features.push(circleFeature(c, r, { kind: 'ring' }));
      // Label each ring at its top (due north of the centre).
      const top = destinationPoint(c, 0, r);
      features.push({
        type: 'Feature',
        properties: { kind: 'label', text: fmtRadius(r) },
        geometry: { type: 'Point', coordinates: [top.lng, top.lat] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
