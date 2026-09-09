/**
 * Region coverage for tile archives — "does this archive actually cover this
 * tile?", which is not the same question as "does this archive contain bytes
 * for this tile?".
 *
 * Planetiler builds an archive over the *bounding box* of its OSM extract and
 * fills every tile in that box from its global sources (the water-polygons
 * shapefile, Natural Earth). Norway's box is -11.4,57.6 -> 35.5,81.1, so
 * norway.pmtiles held tiles over Stockholm, Helsinki and the Baltic containing
 * nothing but the `water` layer. Serving those as if they were coverage put a
 * grey hole over every coastal area the box overhangs (backend/src/tiles-api.ts
 * used to treat any returned bytes as coverage, so the world upstream was never
 * consulted).
 *
 * The authority on what a region *is* is the same Geofabrik `.poly` the extract
 * is cut from, so that is what this module reads. Areas without a published
 * polygon simply have no coverage file, and callers fall back to their previous
 * behaviour rather than losing the archive.
 */

import type { BBox, LatLng } from './geo.js';

/**
 * One ring of a coverage polygon. `hole` rings are the `!`-prefixed sections of
 * the .poly format — Geofabrik uses them for enclaves cut out of a region.
 */
export interface CoverageRing {
  hole: boolean;
  points: LatLng[];
  bbox: BBox;
}

/** A parsed Osmosis/Geofabrik `.poly` file. */
export interface CoveragePolygon {
  name: string;
  rings: CoverageRing[];
  /** Union of the non-hole ring boxes — the cheap first rejection. */
  bbox: BBox;
}

function ringBBox(points: LatLng[]): BBox {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { sw: { lat: minLat, lng: minLng }, ne: { lat: maxLat, lng: maxLng } };
}

/**
 * Parses the Osmosis `.poly` format: a name line, then one section per ring
 * (`!` prefix = hole) holding `lon lat` pairs and terminated by `END`, then a
 * final `END`.
 *
 * Returns null for anything that yields no usable ring, because the caller's
 * choice is "clip by this polygon" vs "keep the old behaviour" — a half-parsed
 * polygon would silently shrink coverage instead, which is the failure this
 * module exists to prevent.
 */
export function parsePolyFile(text: string): CoveragePolygon | null {
  const lines = text.split('\n');
  const name = (lines[0] ?? '').trim();
  const rings: CoverageRing[] = [];

  let current: LatLng[] | null = null;
  let hole = false;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;

    if (current === null) {
      if (line.toUpperCase() === 'END') break; // end of file
      hole = line.startsWith('!');
      current = [];
      continue;
    }

    if (line.toUpperCase() === 'END') {
      // A ring needs three points to enclose anything; anything shorter is a
      // malformed section, not an empty region.
      if (current.length >= 3) rings.push({ hole, points: current, bbox: ringBBox(current) });
      current = null;
      continue;
    }

    const parts = line.split(/\s+/);
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    current.push({ lat, lng });
  }

  const outer = rings.filter((r) => !r.hole);
  if (outer.length === 0) return null;

  const bbox = outer.reduce<BBox>(
    (acc, r) => ({
      sw: { lat: Math.min(acc.sw.lat, r.bbox.sw.lat), lng: Math.min(acc.sw.lng, r.bbox.sw.lng) },
      ne: { lat: Math.max(acc.ne.lat, r.bbox.ne.lat), lng: Math.max(acc.ne.lng, r.bbox.ne.lng) },
    }),
    {
      sw: { lat: Infinity, lng: Infinity },
      ne: { lat: -Infinity, lng: -Infinity },
    },
  );

  return { name, rings, bbox };
}

/** Geographic bounds of a Web Mercator XYZ tile. */
export function tileBBox(z: number, x: number, y: number): BBox {
  const n = 2 ** z;
  const lng = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => {
    const t = Math.PI - (2 * Math.PI * j) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
  };
  return {
    sw: { lat: lat(y + 1), lng: lng(x) },
    ne: { lat: lat(y), lng: lng(x + 1) },
  };
}

function boxesOverlap(a: BBox, b: BBox): boolean {
  return (
    a.sw.lat <= b.ne.lat && a.ne.lat >= b.sw.lat && a.sw.lng <= b.ne.lng && a.ne.lng >= b.sw.lng
  );
}

/** Ray casting; points exactly on an edge may fall either way, which is fine here. */
function pointInRing(ring: CoverageRing, p: LatLng): boolean {
  const pts = ring.points;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (
      a.lat > p.lat !== b.lat > p.lat &&
      p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsCross(p1: LatLng, p2: LatLng, p3: LatLng, p4: LatLng): boolean {
  const d = (a: LatLng, b: LatLng, c: LatLng) =>
    (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return (d1 > 0 !== d2 > 0 || d1 === 0 || d2 === 0) && (d3 > 0 !== d4 > 0 || d3 === 0 || d4 === 0);
}

function corners(box: BBox): LatLng[] {
  return [
    { lat: box.sw.lat, lng: box.sw.lng },
    { lat: box.sw.lat, lng: box.ne.lng },
    { lat: box.ne.lat, lng: box.ne.lng },
    { lat: box.ne.lat, lng: box.sw.lng },
  ];
}

function ringCrossesBox(ring: CoverageRing, box: BBox): boolean {
  const c = corners(box);
  const pts = ring.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    for (let k = 0; k < 4; k++) {
      if (segmentsCross(pts[j]!, pts[i]!, c[k]!, c[(k + 1) % 4]!)) return true;
    }
  }
  return false;
}

function ringIntersectsBox(ring: CoverageRing, box: BBox): boolean {
  if (!boxesOverlap(ring.bbox, box)) return false;
  // Ring poking into the box, box corner inside the ring, or edges crossing —
  // together these cover every way a simple polygon and a rectangle can meet.
  for (const p of ring.points) {
    if (p.lat >= box.sw.lat && p.lat <= box.ne.lat && p.lng >= box.sw.lng && p.lng <= box.ne.lng) {
      return true;
    }
  }
  for (const c of corners(box)) if (pointInRing(ring, c)) return true;
  return ringCrossesBox(ring, box);
}

/**
 * Whether the archive built for `coverage` has any business answering for this
 * tile. False means the caller should treat the local archive as a miss even if
 * it holds bytes — those bytes are global-source filler, not the region.
 *
 * Deliberately generous at the edges: a tile that merely touches the region
 * counts as covered, because a border tile genuinely holds the region's data
 * and half of a neighbour's, and serving ours there is the intent.
 */
export function coverageIntersectsTile(
  coverage: CoveragePolygon,
  z: number,
  x: number,
  y: number,
): boolean {
  const box = tileBBox(z, x, y);
  if (!boxesOverlap(coverage.bbox, box)) return false;

  let covered = false;
  for (const ring of coverage.rings) {
    if (ring.hole) continue;
    if (ringIntersectsBox(ring, box)) {
      covered = true;
      break;
    }
  }
  if (!covered) return false;

  // Only a tile swallowed whole by an enclave is uncovered; one straddling a
  // hole's edge still carries real region data.
  for (const ring of coverage.rings) {
    if (!ring.hole) continue;
    if (!boxesOverlap(ring.bbox, box)) continue;
    const allIn = corners(box).every((c) => pointInRing(ring, c));
    if (allIn && !ringCrossesBox(ring, box)) return false;
  }
  return true;
}
