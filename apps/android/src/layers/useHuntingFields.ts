import { overlayFeaturesUrl } from '@atlas/core';
import { useEffect, useRef, useState } from 'react';

import type { ActiveOverlay } from './useOverlays';

/** Catalog id of the Statskog storviltjaktfelt vector overlay. */
export const STATSKOG_JAKTFELT_ID = 'statskog-jaktfelt';

/** The jaktfelt coverage ready for MapScene's GeoJSON source, plus its opacity. */
export interface HuntingFields {
  data: GeoJSON.FeatureCollection;
  opacity: number;
}

/**
 * Fetch the Statskog hunting-fields coverage while the `statskog-jaktfelt`
 * vector overlay is on (Android twin of the web's useHuntingFieldsLayer). One
 * country-sized GeoJSON fetch — 922 polygons, server-simplified to ~4.4 MB —
 * cached in a ref so toggling the overlay off and on, or a light/dark restyle,
 * never refetches. Keyed on the layer's `rev` so a new hunting season (a rev
 * bump) does refetch.
 *
 * Returns null whenever the overlay is off or the coverage hasn't arrived, so
 * MapScene simply renders nothing. A transient/offline fetch failure is silent:
 * the overlay just doesn't draw until connectivity returns and the effect
 * re-runs — consistent with the raster overlays, which also need the network.
 */
export function useHuntingFields(overlays: ActiveOverlay[], origin: string): HuntingFields | null {
  const active = overlays.find((o) => o.meta.id === STATSKOG_JAKTFELT_ID && o.meta.vector);
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
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(overlayFeaturesUrl(origin, meta));
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as GeoJSON.FeatureCollection;
        cache.current = { rev, data: body };
        if (!cancelled) setData(body);
      } catch {
        // Offline/transient: leave the overlay undrawn until the next attempt.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [present, rev, origin]);

  if (!present || !data) return null;
  return { data, opacity };
}
