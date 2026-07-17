/**
 * Follow-mode zoom from ground speed — the OsmAnd/Google approach: rather than
 * a fixed zoom, keep a constant look-ahead *time*, i.e. pick the zoom at which
 * the distance covered in the next ~12 s fits the forward part of the screen.
 * 78271.5 m is the ground size of one 512px tile pixel at zoom 0 on the
 * equator; cos(lat) corrects for Web Mercator stretch. Clamped to a sane
 * range and quantized so GPS jitter doesn't constantly re-target the camera.
 */
export function zoomForSpeed(speedMps: number | null, lat: number | undefined): number {
  const LOOKAHEAD_S = 12;
  const FORWARD_DP = 400; // roughly the screen half ahead of the position puck
  const v = speedMps ?? 0;
  if (v < 1) return 17; // stationary/unknown: close-in city zoom
  const metersAhead = v * LOOKAHEAD_S;
  const scale = 78271.5 * Math.cos(((lat ?? 60) * Math.PI) / 180);
  const z = Math.log2((scale * FORWARD_DP) / metersAhead);
  return Math.round(Math.min(17.5, Math.max(15, z)) * 4) / 4;
}
