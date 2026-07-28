import {
  huntingFieldIdentify,
  iceObservationIdentify,
  identifyOverlays,
  layerOptionSignature,
  overlayTileUrl,
  snapLabelBbox,
  speedCameraIdentify,
} from '@atlas/core';
import type { LayerMeta, OverlayIdentifyGroup, OverlayLabelsResponse } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { HUNTING_FIELDS_FILL_LAYER } from './useHuntingFieldsLayer.js';
import { ICE_OBSERVATION_IDENTIFY_LAYERS } from './useIceObservationsLayer.js';
import { SPEED_CAMERA_IDENTIFY_LAYERS } from './useSpeedCameraLayer.js';

/** Shared empty payload for a label source before its first fetch lands. */
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** An overlay the user has switched on, with their chosen opacity. */
export interface ActiveOverlay {
  meta: LayerMeta;
  opacity: number;
  /** The layer's resolved options, for the layers that declare any. */
  options?: Record<string, string>;
  /**
   * An extra generation marker folded into the source id (see `sourceId`).
   *
   * Used by the derived surfaces, whose tiles come into existence *while the
   * map is open*: a cell that finishes building writes new bytes behind URLs the
   * map has already fetched and considers settled, so without a fresh source it
   * would not appear until the user zoomed. The preparation hook's `readyKey`
   * goes here.
   */
  variant?: string;
}

const ID_PREFIX = 'atlas-overlay-';

/**
 * The map source id for an overlay. A layer with options carries its variant in
 * the id, so picking a different species removes the old source and adds a new
 * one through the diff below — swapping only the URL under a live raster source
 * leaves its already-loaded tiles on screen.
 */
function sourceId(overlay: ActiveOverlay): string {
  const signature = layerOptionSignature(overlay.options ?? {});
  return (
    ID_PREFIX +
    overlay.meta.id +
    (signature ? `--${signature}` : '') +
    (overlay.variant ? `--${overlay.variant}` : '')
  );
}

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
      if (cancelled) return;
      // Deliberately *not* gated on isStyleLoaded(), for the reason its sibling
      // useOverlayLabels already records: that reports false while tiles are
      // still arriving, which on a profile with eight WMS overlays is a good ten
      // seconds — during which switching a layer on did nothing at all, until
      // the next idle happened to re-run this. `getStyle()` throws only before a
      // style exists, so that is what we guard on; anything else the style
      // refuses right now is retried on the next style.load/idle.
      let style: maplibregl.StyleSpecification;
      try {
        style = map.getStyle();
      } catch {
        return;
      }
      // Vector overlays are drawn by their own hooks (useSpeedCameraLayer) —
      // requesting raster tiles for them would only 404.
      const wanted = new Map(overlays.filter((o) => !o.meta.vector).map((o) => [sourceId(o), o]));
      try {
        for (const layer of style.layers ?? []) {
          if (layer.id.startsWith(ID_PREFIX) && !wanted.has(layer.id)) map.removeLayer(layer.id);
        }
        for (const id of Object.keys(style.sources ?? {})) {
          if (id.startsWith(ID_PREFIX) && !wanted.has(id)) map.removeSource(id);
        }
        // Overlays slide in under the basemap's labels.
        const labelAnchor = (style.layers ?? []).find((l) => l.type === 'symbol')?.id;
        for (const [id, overlay] of wanted) {
          if (!map.getSource(id)) {
            map.addSource(id, {
              type: 'raster',
              tiles: [overlayTileUrl(location.origin, overlay.meta, overlay.options)],
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
      } catch {
        // Style not applied yet (or swapped underneath us): style.load/idle
        // re-runs this pass, and it is idempotent.
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
 * Everything the visible overlays have to say about the point under a click, in
 * one answer: the vector overlays this client draws itself (hunting fields, ATK
 * cameras) answered from the features on screen, and the raster ones asked over
 * /api/overlay/:id/identify. Silent when nothing is found — most clicks are
 * navigation, not questions.
 *
 * Three separate click handlers used to open three separate MapLibre popups
 * here, each with its own markup, so a click that hit a lake *and* a hunting
 * field produced two floating boxes and neither of them the place card the user
 * was already looking at. Now the answers go to that card via `onIdentify`, the
 * way Android has always assembled them (`useMapPress`), and in the same order:
 * local groups lead, because they are what the user aimed at, and the server's
 * rows are ambient context for the same point.
 */
export function useOverlayIdentify(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
  suppress: { readonly current: boolean } | undefined,
  onIdentify: (at: { lat: number; lng: number }, groups: OverlayIdentifyGroup[]) => void,
): void {
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;
  const onIdentifyRef = useRef(onIdentify);
  onIdentifyRef.current = onIdentify;
  // Identify is a network round trip, so a second click can land before the
  // first answers. Only the newest click's answer may reach the card —
  // otherwise the rows would describe a point the user has left behind.
  const clickSeq = useRef(0);

  useEffect(() => {
    if (!map) return;
    const onClick = async (e: maplibregl.MapMouseEvent) => {
      if (suppress?.current) return;
      const click = ++clickSeq.current;
      const at = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      // Answered from what is already drawn, before the network is involved.
      const drawn = (layers: string[]): Record<string, unknown> | null => {
        const present = layers.filter((id) => map.getLayer(id));
        if (present.length === 0) return null;
        // Finger/mouse-sized target: Regobs points and camera dots should not
        // require a pixel-perfect click on their centre.
        const box: [[number, number], [number, number]] = [
          [e.point.x - 10, e.point.y - 10],
          [e.point.x + 10, e.point.y + 10],
        ];
        return map.queryRenderedFeatures(box, { layers: present })[0]?.properties ?? null;
      };
      const local = [
        iceObservationIdentify(drawn(ICE_OBSERVATION_IDENTIFY_LAYERS)),
        speedCameraIdentify(drawn(SPEED_CAMERA_IDENTIFY_LAYERS)),
        huntingFieldIdentify(drawn([HUNTING_FIELDS_FILL_LAYER])),
      ].filter((group): group is OverlayIdentifyGroup => group !== null);
      // Served same-origin, so the shared helper needs no origin prefix. The
      // options ride along so a filtered layer answers for what it draws.
      const results = await identifyOverlays(
        '',
        overlaysRef.current.map((o) => o.meta),
        e.lngLat,
        map.getZoom(),
        (meta) => overlaysRef.current.find((o) => o.meta.id === meta.id)?.options,
      );
      const groups = [...local, ...results];
      if (groups.length === 0 || click !== clickSeq.current) return;
      onIdentifyRef.current(at, groups);
    };
    const handler = (e: maplibregl.MapMouseEvent) => void onClick(e);
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, suppress]);
}
