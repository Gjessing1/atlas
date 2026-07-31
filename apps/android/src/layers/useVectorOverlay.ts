import { overlayFeaturesUrl } from '@atlas/core';
import { useEffect, useRef, useState } from 'react';

import type { ActiveOverlay } from './useOverlays';

/** A vector overlay's coverage ready for MapScene's GeoJSON source, plus its opacity. */
export interface VectorOverlayData {
  data: GeoJSON.FeatureCollection;
  opacity: number;
}

/**
 * Fetch one `vector:true` overlay's country-sized GeoJSON while it is switched
 * on — the Android twin of the web's bespoke `useXxxLayer` hooks, factored out
 * because both vector overlays we draw need exactly the same fetch discipline
 * and only differ in how MapScene paints the result.
 *
 * The payload is cached in a ref keyed on the layer's `rev`, so toggling the
 * overlay off and on, or a light/dark restyle, never refetches, while a catalog
 * `rev` bump (a new hunting season, a new camera dataset) does.
 *
 * Returns null whenever the overlay is off or the coverage hasn't arrived, so
 * MapScene simply renders nothing. A transient/offline fetch failure is silent:
 * the overlay just doesn't draw until connectivity returns and the effect
 * re-runs — consistent with the raster overlays, which also need the network.
 */
export function useVectorOverlay(
  overlays: ActiveOverlay[],
  origin: string,
  layerId: string,
  /** Rolling feeds refetch on this cadence; static datasets omit it. */
  refreshMs?: number,
): VectorOverlayData | null {
  const active = overlays.find((o) => o.meta.id === layerId && o.meta.vector);
  const present = Boolean(active);
  const rev = active?.meta.rev ?? 0;
  const opacity = active?.opacity ?? 1;
  // `overlays` is a fresh array each render, so the meta rides on a ref rather
  // than the effect deps — presence and rev are what actually gate a refetch.
  const metaRef = useRef(active?.meta);
  metaRef.current = active?.meta;

  const cache = useRef<{ rev: number; data: GeoJSON.FeatureCollection } | null>(null);
  const [data, setData] = useState<GeoJSON.FeatureCollection | null>(
    () => cache.current?.data ?? null,
  );

  useEffect(() => {
    const meta = metaRef.current;
    if (!present || !meta) return;
    if (cache.current?.rev === rev) {
      setData(cache.current.data);
      if (!refreshMs) return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch(overlayFeaturesUrl(origin, meta));
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as GeoJSON.FeatureCollection;
        cache.current = { rev, data: body };
        if (!cancelled) setData(body);
      } catch {
        // Offline/transient: leave the overlay undrawn until the next attempt.
      }
    };
    void refresh();
    const timer = refreshMs ? setInterval(() => void refresh(), refreshMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [present, rev, origin, refreshMs]);

  if (!present || !data) return null;
  return { data, opacity };
}
