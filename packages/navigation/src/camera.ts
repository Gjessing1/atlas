import type { LatLng } from '@atlas/core';
import type { RoutingProfile } from '@atlas/routing';

import { cumulativeDistances, subPolyline } from './geometry.js';

/**
 * How the follow camera frames a given travel mode. The driving defaults —
 * heavy pitch, speed-scaled zoom, course-up — are windscreen furniture: they
 * exist to stretch the visible road ahead of a fast vehicle. A pedestrian
 * moves at 1.4 m/s and mostly wants to read the streets *around* them, so
 * walking modes get a flat, closer, north-up-by-default view (the OsmAnd
 * pedestrian defaults, and north-up for the same reason orientation comes
 * from the compass on foot: the walker turns constantly, and a map that spun
 * with every turn of the head would be unreadable).
 */
export interface NavCameraStyle {
  /** Camera pitch (deg) while course-up. Walking modes stay flat. */
  pitchDeg: number;
  /** Zoom while stationary or moving slowly (no useful speed signal). */
  stationaryZoom: number;
  /** Zoom clamp for the speed-scaled part. */
  minZoom: number;
  /** Also the ceiling of the lean-in toward an approaching maneuver. */
  maxZoom: number;
  /**
   * Orientation a fresh trip defaults to when the user has never chosen one
   * for this class of mode. A persisted preference always wins.
   */
  defaultFollowMode: 'course' | 'north';
}

const DRIVING_CAMERA: NavCameraStyle = {
  pitchDeg: 45,
  stationaryZoom: 17,
  minZoom: 15,
  maxZoom: 17.5,
  defaultFollowMode: 'course',
};

/** Flat and close-in; at walking speed the speed-zoom floor is the ceiling. */
const WALKING_CAMERA: NavCameraStyle = {
  pitchDeg: 0,
  stationaryZoom: 17.75,
  minZoom: 16,
  maxZoom: 18,
  defaultFollowMode: 'north',
};

const CAMERA_STYLES: Record<RoutingProfile, NavCameraStyle> = {
  car: DRIVING_CAMERA,
  // A cyclist is between the two: course-up and pitched still earn their keep
  // at riding speed, but the zoom band sits closer than a car's.
  bike: { ...DRIVING_CAMERA, stationaryZoom: 17.25, minZoom: 15.5 },
  foot: WALKING_CAMERA,
  // A hike reads terrain, not street corners: one step further out than the
  // urban walking frame so the ridge/valley context stays on screen.
  hike: { ...WALKING_CAMERA, stationaryZoom: 16.75, minZoom: 15.5, maxZoom: 17.5 },
  run: { ...DRIVING_CAMERA, stationaryZoom: 17.25, minZoom: 15.5 },
};

/** The follow-camera framing for a travel mode. */
export function navCameraStyle(profile: RoutingProfile): NavCameraStyle {
  return CAMERA_STYLES[profile];
}

/**
 * Bounding box of the not-yet-driven part of the route, for the guidance
 * overview camera (Google's overview button): fit everything from the current
 * along-route position to the destination. Null for degenerate routes.
 */
export function remainingRouteBounds(
  points: LatLng[],
  traveledM: number,
): { sw: LatLng; ne: LatLng } | null {
  if (points.length < 2) return null;
  const cum = cumulativeDistances(points);
  const totalM = cum[cum.length - 1]!;
  const rest = subPolyline(points, cum, Math.min(traveledM, totalM), totalM);
  if (rest.length < 2) return null;
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const p of rest) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { sw: { lat: minLat, lng: minLng }, ne: { lat: maxLat, lng: maxLng } };
}

/**
 * Follow-mode zoom from ground speed — the OsmAnd/Google approach: rather than
 * a fixed zoom, keep a constant look-ahead *time*, i.e. pick the zoom at which
 * the distance covered in the next ~12 s fits the forward part of the screen.
 * 78271.5 m is the ground size of one 512px tile pixel at zoom 0 on the
 * equator; cos(lat) corrects for Web Mercator stretch. Clamped to a sane
 * range and quantized so GPS jitter doesn't constantly re-target the camera.
 */
export function zoomForSpeed(
  speedMps: number | null,
  lat: number | undefined,
  forwardDp = 400,
  style: NavCameraStyle = DRIVING_CAMERA,
): number {
  const LOOKAHEAD_S = 12;
  const v = speedMps ?? 0;
  if (v < 1) return style.stationaryZoom; // stationary/unknown: close-in
  const metersAhead = v * LOOKAHEAD_S;
  const scale = 78271.5 * Math.cos(((lat ?? 60) * Math.PI) / 180);
  const z = Math.log2((scale * forwardDp) / metersAhead);
  return Math.round(Math.min(style.maxZoom, Math.max(style.minZoom, z)) * 4) / 4;
}

/**
 * Follow-mode zoom that also leans into the next maneuver: the speed zoom far
 * from a turn, zooming in over the last 300 m so the turn geometry is readable
 * when it matters (the Google/OsmAnd behavior) — but never so far in that the
 * maneuver point itself leaves the screen. The old fixed ramp did exactly
 * that (at full lean only ~100 m ahead was visible while the turn was still
 * 250 m out), which made turns arrive "sooner than the map said". The cap
 * keeps the turn on-screen (with a margin) all the way in, reaching the full
 * intersection zoom only in the last ~60 m. `forwardDp` is how much screen
 * (in dp) lies ahead of the position puck — a bottom-anchored puck sees more
 * road than a centered one.
 */
export function followZoom(
  speedMps: number | null,
  lat: number | undefined,
  nextManeuverM: number | null,
  forwardDp = 400,
  style: NavCameraStyle = DRIVING_CAMERA,
): number {
  const base = zoomForSpeed(speedMps, lat, forwardDp, style);
  if (nextManeuverM === null || nextManeuverM > 300) return base;
  const TURN_MARGIN_M = 40;
  const scale = 78271.5 * Math.cos(((lat ?? 60) * Math.PI) / 180);
  // The zoom at which the maneuver point plus a margin still fits ahead.
  const keepTurnVisible = Math.log2((scale * forwardDp) / (nextManeuverM + TURN_MARGIN_M));
  const z = Math.min(style.maxZoom, Math.max(base, keepTurnVisible));
  return Math.round(z * 4) / 4;
}
