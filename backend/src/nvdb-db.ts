import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { LatLng } from '@atlas/core';
import type { NvdbSpeedSegment } from '@atlas/routing';

/**
 * Read side of the NVDB speed-limit dataset: the SQLite the import pipeline
 * (infrastructure/nvdb/build-nvdb.mjs) writes to `<dataDir>/nvdb/nvdb.sqlite`.
 *
 * Static, read-only, and entirely optional — without the file the backend
 * simply reports no dataset and every route keeps its OSM/tile limits, exactly
 * as before NVDB existed. The Android app carries the same table inside a
 * region pack and reads it the same way; only the file's location differs.
 *
 * Schema (mirror of build-nvdb.mjs):
 *   speed_segment(id, limit_kph, geom)   -- geom = JSON "[[lat,lng],…]"
 *   speed_rtree(id, min_lng, max_lng, min_lat, max_lat)  -- bbox index
 */
export class NvdbStore {
  private constructor(private readonly db: DatabaseSync) {}

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
    return new NvdbStore(db);
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

  close(): void {
    this.db.close();
  }
}
