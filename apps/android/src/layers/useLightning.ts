import type { PotentialView } from '@atlas/app-hooks';
import { LIGHTNING_OBSERVATIONS_ID, type LightningResponse } from '@atlas/conditions';
import { viewportFeaturesUrl } from '@atlas/core';
import { useEffect, useRef, useState } from 'react';

import type { ActiveOverlay } from './useOverlays';
import type { VectorOverlayData } from './useVectorOverlay';

/** Viewport-scoped Frost strikes, refreshed once a minute so age colours advance. */
export function useLightning(
  overlays: ActiveOverlay[],
  origin: string,
  view: PotentialView | null,
): VectorOverlayData | null {
  const active = overlays.find(
    (overlay) => overlay.meta.id === LIGHTNING_OBSERVATIONS_ID && overlay.meta.vector,
  );
  const present = Boolean(active);
  const minzoom = active?.meta.minzoom ?? 4;
  const metaRef = useRef(active?.meta);
  metaRef.current = active?.meta;
  const [data, setData] = useState<LightningResponse | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!present) return;
    const timer = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, [present]);

  const bbox = view?.bbox;
  const key =
    present && view && view.zoom >= minzoom && bbox
      ? `${bbox.map((value) => value.toFixed(3)).join(',')}@${tick}`
      : null;

  useEffect(() => {
    const meta = metaRef.current;
    if (!meta || !view || !key) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(viewportFeaturesUrl(origin, meta, view.bbox));
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as LightningResponse;
        if (!cancelled) setData(body);
      } catch {
        // Preserve the last strike set; the minute tick or next camera move retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, key]);

  if (!present || !view || view.zoom < minzoom || !data) return null;
  return { data: data as GeoJSON.FeatureCollection, opacity: active?.opacity ?? 1 };
}
