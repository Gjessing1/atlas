import type { PotentialView } from '@atlas/app-hooks';
import { transitVehicleFeaturesUrl } from '@atlas/transit';
import { useEffect, useState } from 'react';

import type { ActiveOverlay } from './useOverlays';
import type { VectorOverlayData } from './useVectorOverlay';

export const TRANSIT_VEHICLES_ID = 'transit-vehicles';
const REFRESH_MS = 20_000;

/** Current Entur vehicle positions in the settled map viewport. */
export function useTransitVehicles(
  overlays: ActiveOverlay[],
  origin: string,
  view: PotentialView | null,
): VectorOverlayData | null {
  const active = overlays.find(
    (overlay) => overlay.meta.id === TRANSIT_VEHICLES_ID && overlay.meta.vector,
  );
  const visible = Boolean(active && view && view.zoom >= (active.meta.minzoom ?? 8));
  const bboxKey = view?.bbox.map((value) => value.toFixed(5)).join(',') ?? '';
  const [data, setData] = useState<GeoJSON.FeatureCollection | null>(null);

  useEffect(() => {
    if (!visible || !view) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(transitVehicleFeaturesUrl(origin, view.bbox));
        if (!response.ok || cancelled) return;
        const next = (await response.json()) as GeoJSON.FeatureCollection;
        if (!cancelled) setData(next);
      } catch {
        // Keep the last positions on a transient failure; the layer is explicitly live-only.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, origin, bboxKey, view]);

  if (!active || !visible || !data) return null;
  return { data, opacity: active.opacity };
}
