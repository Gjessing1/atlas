import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { LatLng } from '@atlas/core';
import type { NvdbCameraPoint, NvdbCameraSection, NvdbSpeedSegment } from '@atlas/routing';

/**
 * Read side of the NVDB dataset: the SQLite the import pipeline
 * (infrastructure/nvdb/build-nvdb.mjs) writes to `<dataDir>/nvdb/nvdb.sqlite` —
 * speed limits (type 105) plus the ATK speed cameras (162 points, 823
 * average-speed sections).
 *
 * Static, read-only, and entirely optional — without the file the backend
 * simply reports no dataset and every route keeps its OSM/tile limits, exactly
 * as before NVDB existed. The Android app carries the same table inside a
 * region pack and reads it the same way; only the file's location differs.
 *
 * Schema (mirror of build-nvdb.mjs):
 *   speed_segment(id, limit_kph, geom)   -- geom = JSON "[[lat,lng],…]"
 *   speed_rtree(id, min_lng, max_lng, min_lat, max_lat)  -- bbox index
 *   camera_point(id, name, bearing_deg, lat, lng)        + camera_point_rtree
 *   camera_section(id, name, geom)                       + camera_section_rtree
 *
 * The camera tables arrived after the speed tables, so a dataset built by an
 * older pipeline may not have them — that is a valid file with no cameras,
 * not a corrupt one.
 */
export class NvdbStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly hasCameras: boolean,
  ) {}

  /** Open the dataset under `dataDir`, or null when it isn't present. */
  static open(dataDir: string): NvdbStore | null {
    const file = path.join(dataDir, 'nvdb', 'nvdb.sqlite');
    if (!existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    // Fail closed if the file exists but isn't the shape we expect (a stale or
    // half-written build): treat it as "no dataset" rather than crashing routes.
    try {
      db.prepare('SELECT id, limit_kph, geom FROM speed_segment LIMIT 0').all();
      db.prepare('SELECT id FROM speed_rtree LIMIT 0').all();
    } catch {
      db.close();
      return null;
    }
    let hasCameras = true;
    try {
      db.prepare('SELECT id, name, bearing_deg, lat, lng FROM camera_point LIMIT 0').all();
      db.prepare('SELECT id, name, geom FROM camera_section LIMIT 0').all();
      db.prepare('SELECT id FROM camera_point_rtree LIMIT 0').all();
      db.prepare('SELECT id FROM camera_section_rtree LIMIT 0').all();
    } catch {
      hasCameras = false;
    }
    return new NvdbStore(db, hasCameras);
  }

  /** Whether this dataset build carries the ATK camera tables at all. */
  get hasCameraData(): boolean {
    return this.hasCameras;
  }

  /**
   * Speed stretches whose bounding box intersects `[sw, ne]` padded by
   * `padDeg`. The pad matters: a stretch just outside the route's own bbox can
   * still pass within the match tolerance of a border vertex, and dropping it
   * would leave a limit gap exactly at the region edge.
   */
  querySpeedSegments(sw: LatLng, ne: LatLng, padDeg = 0.001): NvdbSpeedSegment[] {
    const minLng = sw.lng - padDeg;
    const maxLng = ne.lng + padDeg;
    const minLat = sw.lat - padDeg;
    const maxLat = ne.lat + padDeg;
    const rows = this.db
      .prepare(
        `SELECT s.limit_kph AS limitKph, s.geom AS geom
           FROM speed_rtree r JOIN speed_segment s ON s.id = r.id
          WHERE r.min_lng <= ? AND r.max_lng >= ? AND r.min_lat <= ? AND r.max_lat >= ?`,
      )
      .all(maxLng, minLng, maxLat, minLat) as { limitKph: number; geom: string }[];

    const out: NvdbSpeedSegment[] = [];
    for (const row of rows) {
      let coords: unknown;
      try {
        coords = JSON.parse(row.geom);
      } catch {
        continue;
      }
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const points: LatLng[] = [];
      for (const c of coords) {
        if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
          points.push({ lat: c[0], lng: c[1] });
        }
      }
      if (points.length >= 2 && typeof row.limitKph === 'number' && row.limitKph > 0) {
        out.push({ limitKph: row.limitKph, points });
      }
    }
    return out;
  }

  /** ATK point cameras whose position falls inside `[sw, ne]` padded by `padDeg`. */
  queryCameraPoints(sw: LatLng, ne: LatLng, padDeg = 0.001): NvdbCameraPoint[] {
    if (!this.hasCameras) return [];
    const rows = this.db
      .prepare(
        `SELECT c.name AS name, c.bearing_deg AS bearingDeg, c.lat AS lat, c.lng AS lng
           FROM camera_point_rtree r JOIN camera_point c ON c.id = r.id
          WHERE r.min_lng <= ? AND r.max_lng >= ? AND r.min_lat <= ? AND r.max_lat >= ?`,
      )
      .all(ne.lng + padDeg, sw.lng - padDeg, ne.lat + padDeg, sw.lat - padDeg) as {
      name: string | null;
      bearingDeg: number | null;
      lat: number;
      lng: number;
    }[];
    return rows
      .filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number')
      .map((r) => ({
        lat: r.lat,
        lng: r.lng,
        bearingDeg: typeof r.bearingDeg === 'number' ? r.bearingDeg : null,
        name: typeof r.name === 'string' && r.name.length > 0 ? r.name : null,
      }));
  }

  /**
   * ATK average-speed sections whose bounding box intersects `[sw, ne]`. The
   * geometry comes back in the controlled travel direction — the pipeline
   * already flipped it, so the conflation only has to check traversal order.
   */
  queryCameraSections(sw: LatLng, ne: LatLng, padDeg = 0.001): NvdbCameraSection[] {
    if (!this.hasCameras) return [];
    const rows = this.db
      .prepare(
        `SELECT c.name AS name, c.geom AS geom
           FROM camera_section_rtree r JOIN camera_section c ON c.id = r.id
          WHERE r.min_lng <= ? AND r.max_lng >= ? AND r.min_lat <= ? AND r.max_lat >= ?`,
      )
      .all(ne.lng + padDeg, sw.lng - padDeg, ne.lat + padDeg, sw.lat - padDeg) as {
      name: string | null;
      geom: string;
    }[];

    const out: NvdbCameraSection[] = [];
    for (const row of rows) {
      let coords: unknown;
      try {
        coords = JSON.parse(row.geom);
      } catch {
        continue;
      }
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const points: LatLng[] = [];
      for (const c of coords) {
        if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
          points.push({ lat: c[0], lng: c[1] });
        }
      }
      if (points.length >= 2) {
        out.push({
          name: typeof row.name === 'string' && row.name.length > 0 ? row.name : null,
          points,
        });
      }
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
