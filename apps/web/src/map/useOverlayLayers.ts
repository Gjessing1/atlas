import type { LayerMeta, OverlayIdentifyResponse } from '@atlas/core';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

/** An overlay the user has switched on, with their chosen opacity. */
export interface ActiveOverlay {
  meta: LayerMeta;
  opacity: number;
}

const ID_PREFIX = 'atlas-overlay-';

/**
 * Renders the enabled catalog overlays as raster layers over the basemap.
 * Same style-swap resilience pattern as useRouteLayers: an idempotent
 * ensure-layers pass re-run on style.load/idle (a partial `load` handler
 * would silently drop layers otherwise). Rasters are inserted below the first
 * symbol layer so labels stay readable on top; `maxzoom` from the catalog
 * caps requests and lets MapLibre overzoom instead.
 */
export function useOverlayLayers(map: maplibregl.Map | null, overlays: ActiveOverlay[]): void {
  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    const sync = () => {
      if (cancelled || !map.isStyleLoaded()) return; // re-runs on style.load/idle
      const style = map.getStyle();
      const wanted = new Map(overlays.map((o) => [ID_PREFIX + o.meta.id, o]));
      for (const layer of style.layers ?? []) {
        if (layer.id.startsWith(ID_PREFIX) && !wanted.has(layer.id)) map.removeLayer(layer.id);
      }
      for (const sourceId of Object.keys(style.sources ?? {})) {
        if (sourceId.startsWith(ID_PREFIX) && !wanted.has(sourceId)) map.removeSource(sourceId);
      }
      // Overlays slide in under the basemap's labels.
      const labelAnchor = (style.layers ?? []).find((l) => l.type === 'symbol')?.id;
      for (const [id, overlay] of wanted) {
        if (!map.getSource(id)) {
          map.addSource(id, {
            type: 'raster',
            tiles: [`${location.origin}/api/overlay/${overlay.meta.id}/{z}/{x}/{y}.png`],
            tileSize: 256,
            maxzoom: overlay.meta.maxzoom,
            ...(overlay.meta.minzoom !== undefined ? { minzoom: overlay.meta.minzoom } : {}),
            attribution: overlay.meta.attribution,
          });
        }
        if (!map.getLayer(id)) {
          map.addLayer(
            { id, type: 'raster', source: id, paint: { 'raster-opacity': overlay.opacity } },
            labelAnchor,
          );
        } else {
          map.setPaintProperty(id, 'raster-opacity', overlay.opacity);
        }
      }
    };

    sync();
    map.on('style.load', sync);
    map.on('idle', sync);
    return () => {
      cancelled = true;
      map.off('style.load', sync);
      map.off('idle', sync);
    };
  }, [map, overlays]);
}

/**
 * Tap-to-identify for overlays that support it (lake depth points, cadastral
 * parcels): a map click queries /api/overlay/:id/identify for each visible
 * identify-capable overlay and pops up the cleaned attributes. Silent when
 * nothing is found — most clicks are navigation, not questions.
 */
export function useOverlayIdentify(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
  suppress?: { readonly current: boolean },
): void {
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;

  useEffect(() => {
    if (!map) return;
    const onClick = async (e: maplibregl.MapMouseEvent) => {
      if (suppress?.current) return;
      const targets = overlaysRef.current.filter((o) => o.meta.identify);
      if (targets.length === 0) return;
      const { lat, lng } = e.lngLat;
      const zoom = Math.round(map.getZoom());
      const settled = await Promise.allSettled(
        targets.map(async (o) => {
          const res = await fetch(
            `/api/overlay/${o.meta.id}/identify?lat=${lat}&lng=${lng}&zoom=${zoom}`,
          );
          if (!res.ok) return [];
          const body = (await res.json()) as OverlayIdentifyResponse;
          return body.results.map((properties) => ({ title: o.meta.title, properties }));
        }),
      );
      const results = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
      if (results.length === 0) return;

      const el = document.createElement('div');
      el.className = 'identify-popup';
      for (const result of results.slice(0, 4)) {
        const heading = document.createElement('strong');
        heading.textContent = result.title;
        el.appendChild(heading);
        for (const [key, value] of Object.entries(result.properties).slice(0, 8)) {
          const row = document.createElement('div');
          row.className = 'identify-row';
          row.textContent = `${key}: ${value}`;
          el.appendChild(row);
        }
      }
      new maplibregl.Popup({ offset: 8, maxWidth: '300px' })
        .setLngLat(e.lngLat)
        .setDOMContent(el)
        .addTo(map);
    };
    const handler = (e: maplibregl.MapMouseEvent) => void onClick(e);
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, suppress]);
}
