import { snapLabelBbox } from '@atlas/core';
import type { LatLng, OverlayLabelsResponse } from '@atlas/core';
import { useEffect, useState } from 'react';

import { useServerOrigin } from '../serverOrigin';
import type { ActiveOverlay } from './useOverlays';

/** Label GeoJSON per overlay id, ready to hand to a ShapeSource. */
export type OverlayLabelData = Record<string, OverlayLabelsResponse>;

// The grid itself lives in @atlas/core (OVERLAY_LABEL_SNAP_DEG) so the backend
// caches under the same key. Quantizing here is what keeps this off the render
// hot path: the camera reports a new position on every frame of a pan, but the
// *cell* only changes when you cross a boundary, so React bails out of the
// state update and no fetch is issued in between.

/**
 * The viewport key to fetch labels for, or null when there is nothing to draw.
 * Derived from the camera rather than read off the map, because this version of
 * maplibre-react-native exposes no `getVisibleBounds`.
 */
export function labelCellFor(
  center: LatLng,
  zoom: number,
  screen: { width: number; height: number },
): string {
  // MapLibre's world is 512 px at zoom 0. In Mercator a pixel spans fewer
  // degrees of latitude than longitude, by cos(latitude).
  const degPerPxLng = 360 / (512 * 2 ** zoom);
  const cosLat = Math.max(0.02, Math.cos((center.lat * Math.PI) / 180));
  const halfLng = (screen.width / 2) * degPerPxLng;
  const halfLat = (screen.height / 2) * degPerPxLng * cosLat;

  const bbox = snapLabelBbox([
    center.lng - halfLng,
    center.lat - halfLat,
    center.lng + halfLng,
    center.lat + halfLat,
  ]);
  return `${bbox.join(',')}@${Math.round(zoom)}`;
}

const EMPTY: OverlayLabelsResponse = { type: 'FeatureCollection', features: [] };

/**
 * Fetches on-map attribute labels for the enabled overlays that publish them
 * (today: a surveyed lake's maximum depth, which the WMS raster cannot draw
 * because it lives in the upstream's attributes rather than its symbology).
 *
 * `cell` is the snapped viewport from `labelCellFor` — passing a quantized
 * string rather than a live camera is deliberate, so panning does not refetch.
 */
export function useOverlayLabels(overlays: ActiveOverlay[], cell: string | null): OverlayLabelData {
  const origin = useServerOrigin();
  const [data, setData] = useState<OverlayLabelData>({});

  // The ids that want labels, as a stable string so the effect doesn't re-run
  // on every overlay array identity change (opacity edits, re-renders).
  const ids = overlays
    .filter((o) => o.meta.labels)
    .map((o) => o.meta.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!cell || ids.length === 0) {
      setData((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    let cancelled = false;
    const [bbox, zoom] = cell.split('@');
    void (async () => {
      const next: OverlayLabelData = {};
      await Promise.all(
        ids.split(',').map(async (id) => {
          try {
            const res = await fetch(`${origin}/api/overlay/${id}/labels?bbox=${bbox}&zoom=${zoom}`);
            if (!res.ok) return;
            next[id] = (await res.json()) as OverlayLabelsResponse;
          } catch {
            // Offline or upstream down: the raster overlay still renders, so
            // leaving the labels empty degrades rather than breaks.
            next[id] = EMPTY;
          }
        }),
      );
      if (!cancelled) setData(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, ids, cell]);

  return data;
}
