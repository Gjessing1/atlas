import { identifyOverlays, overlayTileUrl, snapLabelBbox } from '@atlas/core';
import type { LayerMeta, OverlayLabelsResponse } from '@atlas/core';
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
            tiles: [overlayTileUrl(location.origin, overlay.meta)],
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
  // Label data outlives the effect on purpose. `overlays` is a fresh array on
  // every render, so this effect re-runs constantly; keeping the last payload
  // and the last viewport in refs means a re-run (or a style reload, which
  // wipes every source) can re-seed the layer from what we already have instead
  // of blanking it and waiting on the network. Without this the number appears
  // for a moment and then vanishes.
  const dataRef = useRef(new Map<string, OverlayLabelsResponse>());
  const fetchedRef = useRef(new Map<string, string>());

  // Only the set of label-capable layers should restart the effect, not every
  // opacity tweak or unrelated re-render.
  const labelledKey = overlays
    .filter((o) => o.meta.labels)
    .map((o) => o.meta.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!map) return;
    const ids = labelledKey ? labelledKey.split(',') : [];
    const metaById = new Map(overlays.filter((o) => o.meta.labels).map((o) => [o.meta.id, o.meta]));

    const ensure = () => {
      // Not gated on isStyleLoaded(): that reports false while tiles are still
      // arriving, and gating on it meant the first pass silently did nothing.
      // getStyle() throws only before the style exists at all, so guard on that.
      let style: maplibregl.StyleSpecification;
      try {
        style = map.getStyle();
      } catch {
        return;
      }
      const wanted = new Set(ids.map((id) => LABEL_PREFIX + id));
      for (const layer of style.layers ?? []) {
        if (layer.id.startsWith(LABEL_PREFIX) && !wanted.has(layer.id)) map.removeLayer(layer.id);
      }
      for (const sourceId of Object.keys(style.sources ?? {})) {
        if (sourceId.startsWith(LABEL_PREFIX) && !wanted.has(sourceId)) map.removeSource(sourceId);
      }
      for (const overlayId of ids) {
        const id = LABEL_PREFIX + overlayId;
        const meta = metaById.get(overlayId);
        if (!meta) continue;
        if (!map.getSource(id)) {
          // Seed with whatever we last fetched, so a style reload re-draws
          // immediately rather than flashing empty.
          map.addSource(id, {
            type: 'geojson',
            data: (dataRef.current.get(id) ?? EMPTY_FC) as GeoJSON.FeatureCollection,
          });
        }
        if (!map.getLayer(id)) {
          // Added on top (no beforeId): unlike the raster, these are meant to
          // read over everything, including the basemap's own labels.
          map.addLayer({
            id,
            type: 'symbol',
            source: id,
            minzoom: meta.labels?.minzoom ?? 0,
            layout: {
              'text-field': ['get', 'label'],
              'text-font': ['Noto Sans Bold'],
              'text-size': 13,
              // Sits below the anchor so it reads under the basemap's own
              // lake name rather than through it — both are centred on the
              // same water, and overlap-forcing alone stacked them.
              'text-offset': [0, 1.4],
              // Must draw unconditionally. Symbol placement runs in layer order
              // and this layer is added last, so with collision enabled the
              // depth loses every contest against a basemap label and flickers
              // as placement resettles on each zoom.
              'text-allow-overlap': true,
              'text-ignore-placement': true,
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
      if (ids.length === 0) return;
      const b = map.getBounds();
      // Snapped to the shared grid so a small pan is not a new request at all,
      // and so this key matches the one the backend caches under.
      const bbox = snapLabelBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]).join(',');
      const zoom = Math.round(map.getZoom());
      const key = `${bbox}@${zoom}`;
      for (const overlayId of ids) {
        const id = LABEL_PREFIX + overlayId;
        if (fetchedRef.current.get(id) === key) continue;
        fetchedRef.current.set(id, key);
        void (async () => {
          try {
            const res = await fetch(`/api/overlay/${overlayId}/labels?bbox=${bbox}&zoom=${zoom}`);
            if (!res.ok) {
              fetchedRef.current.delete(id);
              return;
            }
            const body = (await res.json()) as OverlayLabelsResponse;
            // Deliberately not gated on an effect-scoped `cancelled` flag: the
            // response outliving its effect run is the normal case here, and
            // dropping it on the floor is what made labels disappear.
            dataRef.current.set(id, body);
            const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
            if (source) source.setData(body as unknown as GeoJSON.FeatureCollection);
          } catch {
            // Labels are an enhancement; the raster underneath still renders.
            fetchedRef.current.delete(id);
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
      map.off('style.load', sync);
      map.off('idle', sync);
      map.off('moveend', refresh);
    };
    // `overlays` is intentionally not a dependency — see labelledKey above.
  }, [map, labelledKey]);
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
      // Served same-origin, so the shared helper needs no origin prefix.
      const results = await identifyOverlays(
        '',
        overlaysRef.current.map((o) => o.meta),
        e.lngLat,
        map.getZoom(),
      );
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
