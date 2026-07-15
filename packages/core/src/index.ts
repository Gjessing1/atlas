export const APP_NAME = 'Atlas';

/** WGS84 coordinate. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Geographic bounding box (south-west / north-east corners). */
export interface BBox {
  sw: LatLng;
  ne: LatLng;
}

/** Whether a point lies inside a bounding box (inclusive). Does not handle antimeridian-crossing boxes. */
export function bboxContains(bbox: BBox, point: LatLng): boolean {
  return (
    point.lat >= bbox.sw.lat &&
    point.lat <= bbox.ne.lat &&
    point.lng >= bbox.sw.lng &&
    point.lng <= bbox.ne.lng
  );
}
