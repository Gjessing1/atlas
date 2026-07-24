import type { NvdbCameraPoint } from './cameras.js';

/**
 * OSM speed-camera fallback for the *point* half of the ATK feature
 * (ROADMAP §2.1). Where Vegvesen's NVDB is the authoritative source inside
 * Norway, OSM `highway=speed_camera` nodes are the only camera data available
 * everywhere else — so a route driven on an offline pack outside Norway still
 * gets point-camera warnings, feeding the exact same {@link NvdbCameraPoint}
 * shape the conflation already consumes (the *section* half stays Norway-only
 * by data reality: OSM has no average-speed-section equivalent).
 *
 * This module is only the tag→point translation, kept pure and platform-neutral
 * so both the offline-pack build (which reads OSM nodes out of the region
 * extract) and any test can share one definition of what an OSM speed camera is
 * and which way it faces. Matching onto a route is still {@link conflateCameras}.
 */

/** OSM tags of a single node/feature, as string values (the shape osmium exports). */
export type OsmTags = Record<string, string | undefined>;

/** The 16-point compass, for `direction=NNE` style values. */
const COMPASS: Record<string, number> = {
  n: 0,
  nne: 22.5,
  ne: 45,
  ene: 67.5,
  e: 90,
  ese: 112.5,
  se: 135,
  sse: 157.5,
  s: 180,
  ssw: 202.5,
  sw: 225,
  wsw: 247.5,
  w: 270,
  wnw: 292.5,
  nw: 315,
  nnw: 337.5,
};

/**
 * Parse an OSM `direction`/`camera:direction` value into a compass bearing
 * (deg from north, 0–360), or null when it carries no absolute heading.
 *
 * OSM allows a number (degrees) or a 16-point compass abbreviation. The
 * relative values `forward`/`backward` are deliberately *not* resolved here:
 * without the parent way's geometry they carry no absolute heading, and a
 * bearing guessed wrong would silence the camera on the side it actually
 * controls — a null (which makes the camera warn both ways) is the safer miss,
 * matching how the NVDB import treats an unresolvable direction.
 */
export function parseOsmCameraDirection(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const num = Number(trimmed);
  if (Number.isFinite(num)) {
    // Normalise into [0, 360); a stray 360/-90 shouldn't leak through.
    return ((num % 360) + 360) % 360;
  }
  const compass = COMPASS[trimmed.toLowerCase()];
  return compass ?? null;
}

/**
 * Build a point camera from an OSM feature's tags, or null when the feature is
 * not a speed camera. `highway=speed_camera` is the node tagging; the
 * `enforcement=maxspeed` relation member `device` some mappers use for the
 * physical camera is accepted too. The controlled direction comes from
 * `direction` (preferred) or the older `camera:direction`; the name from
 * `name`/`ref`/`operator`, best-effort (many cameras carry none — a null name
 * just means the warning announces "speed camera" with no label).
 */
export function osmCameraFromTags(tags: OsmTags, lat: number, lng: number): NvdbCameraPoint | null {
  const isCamera =
    tags.highway === 'speed_camera' ||
    (tags.enforcement === 'maxspeed' && (tags.device === 'camera' || tags.highway === 'camera'));
  if (!isCamera) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const bearingDeg =
    parseOsmCameraDirection(tags.direction) ?? parseOsmCameraDirection(tags['camera:direction']);
  const name =
    [tags.name, tags.ref, tags.operator].find((v) => typeof v === 'string' && v.trim() !== '') ??
    null;
  return { lat, lng, bearingDeg, name: name ? name.trim() : null };
}
