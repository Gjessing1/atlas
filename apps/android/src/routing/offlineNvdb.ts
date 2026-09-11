import { bboxContains, type LatLng } from '@atlas/core';
import {
  conflateCameras,
  httpNvdbCameras,
  httpNvdbLanes,
  httpNvdbLimits,
  nvdbLaneOverrides,
  nvdbSpeedOverrides,
  type NvdbCameraPoint,
  type NvdbCameraSection,
  type NvdbLimitTransport,
  type NvdbLaneTransport,
  type NvdbCameraTransport,
  type NvdbSpeedSegment,
  type NvdbLaneSegment,
} from '@atlas/routing';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { listLocalPacks, type LocalPack } from '../regions/packs';

/**
 * Offline NVDB road data, the on-device mirror of the backend's
 * NvdbStore: speed-limit overrides, turn-lane guidance and speed-camera warnings read out of a
 * downloaded pack's `nvdb.sqlite` — NVDB in Norway plus OSM `speed_camera`
 * points elsewhere — so a drive covered by a pack gets both with no network.
 *
 * The dataset and the conflation are deliberately identical to the server's:
 * the same SQLite schema (built by infrastructure/packs/build-pack-nvdb.mjs),
 * queried the same way, then handed to the very same platform-neutral
 * `nvdbSpeedOverrides` / `nvdbLaneOverrides` / `conflateCameras`. Only the read path differs — this
 * file opens the pack file through expo-sqlite where the backend opens it
 * through node:sqlite.
 *
 * Both transports are offline-first with the server as fallback (architecture
 * rule 3): a pack that covers the route and ships the dataset answers locally;
 * anything else — no pack, an older pack without the file, or a read error on a
 * SQLite build lacking the rtree module — falls through to the same HTTP
 * transport the app used before, which offline simply yields nothing and leaves
 * the tile limits standing. Nothing here can crash a drive.
 */

const RTREE_PAD_DEG = 0.001;

/** One open handle per pack dir; expo-sqlite takes a plain directory path. */
const open = new Map<string, Promise<SQLiteDatabase>>();

function packNvdbDb(pack: LocalPack): Promise<SQLiteDatabase> {
  let db = open.get(pack.dir);
  if (!db) {
    db = openDatabaseAsync('nvdb.sqlite', {}, pack.dir);
    open.set(pack.dir, db);
  }
  return db;
}

/** The downloaded pack that covers every route point and ships an nvdb dataset. */
function packWithNvdb(packs: LocalPack[], points: LatLng[]): LocalPack | null {
  if (points.length === 0) return null;
  return (
    packs.find(
      (pack) =>
        pack.manifest.files.nvdb &&
        points.every((point) => bboxContains(pack.manifest.bbox, point)),
    ) ?? null
  );
}

/** Axis-aligned bounds of the route, for the dataset's bbox queries. */
function routeBounds(points: LatLng[]): { sw: LatLng; ne: LatLng } {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { sw: { lat: minLat, lng: minLng }, ne: { lat: maxLat, lng: maxLng } };
}

/** Parse a stored `[[lat,lng],…]` geometry, dropping malformed rows. */
function parseGeom(geom: string): LatLng[] | null {
  let coords: unknown;
  try {
    coords = JSON.parse(geom);
  } catch {
    return null;
  }
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const points: LatLng[] = [];
  for (const c of coords) {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      points.push({ lat: c[0], lng: c[1] });
    }
  }
  return points.length >= 2 ? points : null;
}

async function querySpeedSegments(
  db: SQLiteDatabase,
  sw: LatLng,
  ne: LatLng,
): Promise<NvdbSpeedSegment[]> {
  const rows = await db.getAllAsync<{ limitKph: number; geom: string }>(
    `SELECT s.limit_kph AS limitKph, s.geom AS geom
       FROM speed_rtree r JOIN speed_segment s ON s.id = r.id
      WHERE r.min_lng <= ? AND r.max_lng >= ? AND r.min_lat <= ? AND r.max_lat >= ?`,
    ne.lng + RTREE_PAD_DEG,
    sw.lng - RTREE_PAD_DEG,
    ne.lat + RTREE_PAD_DEG,
    sw.lat - RTREE_PAD_DEG,
  );
  const out: NvdbSpeedSegment[] = [];
  for (const row of rows) {
    const points = parseGeom(row.geom);
    if (points && typeof row.limitKph === 'number' && row.limitKph > 0) {
      out.push({ limitKph: row.limitKph, points });
    }
  }
  return out;
}

async function queryLaneSegments(
  db: SQLiteDatabase,
  sw: LatLng,
  ne: LatLng,
): Promise<NvdbLaneSegment[]> {
  const rows = await db.getAllAsync<{ fieldCodes: string; geom: string }>(
    `SELECT s.field_codes AS fieldCodes, s.geom AS geom
       FROM lane_rtree r JOIN lane_segment s ON s.id = r.id
      WHERE r.min_lng <= ? AND r.max_lng >= ? AND r.min_lat <= ? AND r.max_lat >= ?`,
    ne.lng + RTREE_PAD_DEG,
    sw.lng - RTREE_PAD_DEG,
    ne.lat + RTREE_PAD_DEG,
    sw.lat - RTREE_PAD_DEG,
  );
  return rows.flatMap((row): NvdbLaneSegment[] => {
    const points = parseGeom(row.geom);
    const fieldCodes =
      typeof row.fieldCodes === 'string'
        ? row.fieldCodes
            .split('#')
            .map((code) => code.trim())
            .filter(Boolean)
        : [];
    return points && fieldCodes.length >= 2 ? [{ points, fieldCodes }] : [];
  });
}

async function queryCameraPoints(
  db: SQLiteDatabase,
  sw: LatLng,
  ne: LatLng,
): Promise<NvdbCameraPoint[]> {
  const rows = await db.getAllAsync<{
    name: string | null;
    bearingDeg: number | null;
    lat: number;
    lng: number;
  }>(
    `SELECT c.name AS name, c.bearing_deg AS bearingDeg, c.lat AS lat, c.lng AS lng
       FROM camera_point_rtree r JOIN camera_point c ON c.id = r.id
      WHERE r.min_lng <= ? AND r.max_lng >= ? AND r.min_lat <= ? AND r.max_lat >= ?`,
    ne.lng + RTREE_PAD_DEG,
    sw.lng - RTREE_PAD_DEG,
    ne.lat + RTREE_PAD_DEG,
    sw.lat - RTREE_PAD_DEG,
  );
  return rows
    .filter((r) => typeof r.lat === 'number' && typeof r.lng === 'number')
    .map((r) => ({
      lat: r.lat,
      lng: r.lng,
      bearingDeg: typeof r.bearingDeg === 'number' ? r.bearingDeg : null,
      name: typeof r.name === 'string' && r.name.length > 0 ? r.name : null,
    }));
}

async function queryCameraSections(
  db: SQLiteDatabase,
  sw: LatLng,
  ne: LatLng,
): Promise<NvdbCameraSection[]> {
  const rows = await db.getAllAsync<{ name: string | null; geom: string }>(
    `SELECT c.name AS name, c.geom AS geom
       FROM camera_section_rtree r JOIN camera_section c ON c.id = r.id
      WHERE r.min_lng <= ? AND r.max_lng >= ? AND r.min_lat <= ? AND r.max_lat >= ?`,
    ne.lng + RTREE_PAD_DEG,
    sw.lng - RTREE_PAD_DEG,
    ne.lat + RTREE_PAD_DEG,
    sw.lat - RTREE_PAD_DEG,
  );
  const out: NvdbCameraSection[] = [];
  for (const row of rows) {
    const points = parseGeom(row.geom);
    if (points) {
      out.push({
        name: typeof row.name === 'string' && row.name.length > 0 ? row.name : null,
        points,
      });
    }
  }
  return out;
}

/**
 * NVDB speed-limit overrides, offline-first: a pack covering the route reads
 * its own speed dataset; otherwise the server. A pack that ships the dataset
 * but has no segments near the route (the whole region is outside Norway)
 * simply produces no overrides — the tile limits stand, exactly as intended.
 */
export function makeNvdbLimitTransport(serverOrigin: string): NvdbLimitTransport {
  const online = httpNvdbLimits({ baseUrl: serverOrigin });
  return async (points, signal) => {
    try {
      const pack = packWithNvdb(await listLocalPacks(), points);
      if (pack) {
        const db = await packNvdbDb(pack);
        const { sw, ne } = routeBounds(points);
        return nvdbSpeedOverrides(points, await querySpeedSegments(db, sw, ne));
      }
    } catch (error) {
      console.warn('offline NVDB limits failed, falling back to server:', error);
    }
    return online(points, signal);
  };
}

/** Dedicated turn lanes, using a covering pack before the server. */
export function makeNvdbLaneTransport(serverOrigin: string): NvdbLaneTransport {
  const online = httpNvdbLanes({ baseUrl: serverOrigin });
  return async (route, signal) => {
    try {
      const pack = packWithNvdb(await listLocalPacks(), route.points);
      if (pack) {
        const db = await packNvdbDb(pack);
        const { sw, ne } = routeBounds(route.points);
        return nvdbLaneOverrides(route, await queryLaneSegments(db, sw, ne));
      }
    } catch (error) {
      // Older installed packs have the pre-lane schema. Falling through keeps
      // them useful online and leaves lanes simply absent while fully offline.
      console.warn('offline NVDB lanes failed, falling back to server:', error);
    }
    return online(route, signal);
  };
}

/**
 * ATK / OSM speed cameras the route passes, offline-first like the limits. The
 * conflation is the same one the server runs, so an offline drive gets the same
 * point-camera warnings and average-speed sections a connected one would.
 */
export function makeNvdbCameraTransport(serverOrigin: string): NvdbCameraTransport {
  const online = httpNvdbCameras({ baseUrl: serverOrigin });
  return async (points, signal) => {
    try {
      const pack = packWithNvdb(await listLocalPacks(), points);
      if (pack) {
        const db = await packNvdbDb(pack);
        const { sw, ne } = routeBounds(points);
        const [cameraPoints, sections] = await Promise.all([
          queryCameraPoints(db, sw, ne),
          queryCameraSections(db, sw, ne),
        ]);
        return conflateCameras(points, { points: cameraPoints, sections });
      }
    } catch (error) {
      console.warn('offline NVDB cameras failed, falling back to server:', error);
    }
    return online(points, signal);
  };
}
