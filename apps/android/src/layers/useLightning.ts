import type { PotentialView } from '@atlas/app-hooks';
import {
  LIGHTNING_OBSERVATIONS_ID,
  type LightningResponse,
  type LightningWindow,
} from '@atlas/conditions';
import { viewportFeaturesUrl } from '@atlas/core';
import { useEffect, useRef, useState } from 'react';

import type { ActiveOverlay } from './useOverlays';
import type { VectorOverlayData } from './useVectorOverlay';

/** Often enough that a strike can still be inside its pulsing first minute on arrival. */
const REFRESH_MS = 20_000;

function sameStrikes(a: LightningResponse | null, b: LightningResponse): boolean {
  if (!a || a.features.length !== b.features.length) return false;
  const edge = (r: LightningResponse, i: number) => r.features[i]?.properties.observedMs;
  return (
    edge(a, 0) === edge(b, 0) && edge(a, a.features.length - 1) === edge(b, b.features.length - 1)
  );
}

/** Viewport-scoped Frost strikes; LightningLayers moves their age bands on between refreshes. */
export function useLightning(
  overlays: ActiveOverlay[],
  origin: string,
  view: PotentialView | null,
  window: LightningWindow,
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
    const timer = setInterval(() => setTick((value) => value + 1), REFRESH_MS);
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
        const response = await fetch(
          `${viewportFeaturesUrl(origin, meta, view.bbox)}&window=${window}`,
        );
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as LightningResponse;
        // The same strikes again (a quiet sky, mostly) must not re-render the whole app.
        if (!cancelled) setData((previous) => (sameStrikes(previous, body) ? previous : body));
      } catch {
        // Preserve the last strike set; the next tick or camera move retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, key, window]);

  if (!present || !view || view.zoom < minzoom || !data) return null;
  return { data: data as GeoJSON.FeatureCollection, opacity: active?.opacity ?? 1 };
}
