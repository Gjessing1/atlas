import { snapLabelBbox } from '@atlas/core';
import type { LayerMeta, OverlayIdentifyResponse, OverlayLabelsResponse } from '@atlas/core';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

/** Shared empty payload for a label source before its first fetch lands. */
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

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

const LABEL_PREFIX = 'atlas-overlay-label-';

/**
 * Draws an overlay's attribute labels straight onto the map — the number a
 * raster tile cannot carry because it lives in the upstream's attributes
 * rather than its symbology (a surveyed lake's maximum depth).
 *
 * Fetched per viewport rather than per tile: the backend snaps the bbox to a
 * coarse grid and caches, so panning around a region reuses one upstream
 * answer. Fetches are keyed on the snapped viewport too, so a pan that stays
 * inside the same cell doesn't re-request at all.
 */
export function useOverlayLabels(map: maplibregl.Map | null, overlays: ActiveOverlay[]): void {
  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    const labelled = overlays.filter((o) => o.meta.labels);
    // Remembers the last viewport fetched per layer, so moveend is cheap.
    const fetched = new Map<string, string>();

    const ensure = () => {
      if (cancelled || !map.isStyleLoaded()) return;
      const style = map.getStyle();
      const wanted = new Map(labelled.map((o) => [LABEL_PREFIX + o.meta.id, o]));
      for (const layer of style.layers ?? []) {
        if (layer.id.startsWith(LABEL_PREFIX) && !wanted.has(layer.id)) map.removeLayer(layer.id);
      }
      for (const sourceId of Object.keys(style.sources ?? {})) {
        if (sourceId.startsWith(LABEL_PREFIX) && !wanted.has(sourceId)) map.removeSource(sourceId);
      }
      for (const [id, overlay] of wanted) {
        if (!map.getSource(id)) {
          map.addSource(id, { type: 'geojson', data: EMPTY_FC });
          fetched.delete(id); // a fresh source starts empty, so refetch into it
        }
        if (!map.getLayer(id)) {
          // Added on top (no beforeId): unlike the raster, these are meant to
          // read over everything, including the basemap's own labels.
          map.addLayer({
            id,
            type: 'symbol',
            source: id,
            minzoom: overlay.meta.labels?.minzoom ?? 0,
            layout: {
              'text-field': ['get', 'label'],
              'text-font': ['Noto Sans Bold'],
              'text-size': 13,
              // A lake gets one number; dropping it when it collides with a
              // basemap label is better than stacking two unreadable ones.
              'text-allow-overlap': false,
              'text-padding': 4,
            },
            paint: {
              'text-color': '#0b3d63',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.6,
            },
          });
        }
      }
    };

    const refresh = () => {
      if (cancelled || labelled.length === 0 || !map.isStyleLoaded()) return;
      const b = map.getBounds();
      // Snapped to the shared grid so a small pan is not a new request at all,
      // and so this key matches the one the backend caches under.
      const bbox = snapLabelBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]).join(',');
      const zoom = Math.round(map.getZoom());
      for (const overlay of labelled) {
        const id = LABEL_PREFIX + overlay.meta.id;
        const key = `${bbox}@${zoom}`;
        if (fetched.get(id) === key) continue;
        fetched.set(id, key);
        void (async () => {
          try {
            const res = await fetch(
              `/api/overlay/${overlay.meta.id}/labels?bbox=${bbox}&zoom=${zoom}`,
            );
            if (!res.ok || cancelled) return;
            const body = (await res.json()) as OverlayLabelsResponse;
            const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
            if (!cancelled && source) source.setData(body as unknown as GeoJSON.FeatureCollection);
          } catch {
            // Labels are an enhancement; the raster underneath still renders.
            fetched.delete(id);
          }
        })();
      }
    };

    const sync = () => {
      ensure();
      refresh();
    };
    sync();
    map.on('style.load', sync);
    map.on('idle', sync);
    map.on('moveend', refresh);
    return () => {
      cancelled = true;
      map.off('style.load', sync);
      map.off('idle', sync);
      map.off('moveend', refresh);
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
