import {
  ICE_OBSERVATIONS_ID,
  iceObservationsUrl,
  type IceObservationsResponse,
  type LngLatBbox,
} from '@atlas/core';
import { useEffect, useRef, useState } from 'react';

import type { ActiveOverlay } from './useOverlays';
import type { VectorOverlayData } from './useVectorOverlay';

export interface IceObservationView {
  bbox: LngLatBbox;
  zoom: number;
}

/**
 * Android's viewport-fetched Regobs feed. The camera hook derives the bbox
 * because this MapLibre binding has no `getVisibleBounds`; settled cameras only
 * update it after a pan ends, keeping observation requests off the render path.
 */
export function useIceObservations(
  overlays: ActiveOverlay[],
  origin: string,
  view: IceObservationView | null,
): VectorOverlayData | null {
  const active = overlays.find((o) => o.meta.id === ICE_OBSERVATIONS_ID && o.meta.vector);
  const present = Boolean(active);
  const rev = active?.meta.rev ?? 0;
  const opacity = active?.opacity ?? 1;
  const minzoom = active?.meta.minzoom ?? 7;
  const metaRef = useRef(active?.meta);
  metaRef.current = active?.meta;
  const dataRef = useRef<IceObservationsResponse | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const revisionRef = useRef(0);
  const [data, setData] = useState<IceObservationsResponse | null>(null);

  const bbox = view?.bbox;
  const key =
    present && view && view.zoom >= minzoom && bbox
      ? bbox.map((value) => value.toFixed(3)).join(',')
      : null;

  useEffect(() => {
    if (revisionRef.current !== rev) {
      revisionRef.current = rev;
      dataRef.current = null;
      loadedKeyRef.current = null;
      setData(null);
    }
    const meta = metaRef.current;
    if (!present || !meta || !view || !key || loadedKeyRef.current === key) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(iceObservationsUrl(origin, meta, view.bbox));
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as IceObservationsResponse;
        dataRef.current = body;
        loadedKeyRef.current = key;
        if (!cancelled) setData(body);
      } catch {
        // Offline/transient: the map keeps the last successful observation set;
        // the next settled camera change retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [present, rev, origin, key]);

  if (!present || !view || view.zoom < minzoom || !(data ?? dataRef.current)) return null;
  return { data: (data ?? dataRef.current) as GeoJSON.FeatureCollection, opacity };
}
