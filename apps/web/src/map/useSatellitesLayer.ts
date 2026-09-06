import { satelliteElementsUrl, type LayerMeta } from '@atlas/core';
import {
  coversGround,
  footprintRing,
  groundTrackSegments,
  subpointAt,
  type SatelliteElementSet,
  type SatelliteOmm,
} from '@atlas/satellites';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';

import type { ActiveOverlay } from './useOverlayLayers.js';

/**
 * Live satellite positions, computed on the device.
 *
 * The one map layer here that is not fetched but *propagated*: the client
 * downloads orbital elements once every couple of hours and works out where
 * everything is itself, sixty times a minute, from arithmetic. So it keeps
 * running with the network off, and the thing it degrades by is the age of its
 * elements — which is why the age travels with every feature rather than being
 * dropped on the floor.
 */

/** Colour says one thing only: whether sunlight is reaching the object. */
const SUNLIT_COLOR = '#fbbf24';
const ECLIPSED_COLOR = '#64748b';

/**
 * The selection colour, shared by the selected track, its dot's ring and its
 * footprint.
 *
 * The footprint deliberately does *not* recolour itself when the observer is
 * inside it. Colour on this layer already means illumination, and a third
 * meaning on the same channel would make a lit satellite and a reachable one
 * indistinguishable at a glance. Whether you personally can see it is said in
 * words on the card instead.
 */
const SELECTED_COLOR = '#38bdf8';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Above this many objects the tick slows down.
 *
 * Propagating the 176-object stations+visual set costs about a millisecond;
 * the 11 086-object Starlink set costs ~40 ms on a desktop and several times
 * that on a phone. Once a second there would be a visible tax on a layer the
 * user may well have left switched on, and at the zooms anyone actually reads a
 * constellation from, two seconds of ISS travel is a few pixels.
 */
const LARGE_SET = 500;
const TICK_SMALL_MS = 1000;
const TICK_LARGE_MS = 2000;

/** Ground tracks change slowly; recomputing them every tick would be waste. */
const TRACK_REFRESH_MS = 30_000;

interface LayerIds {
  source: string;
  footprint: string;
  footprintEdge: string;
  track: string;
  dot: string;
  label: string;
}

const idsFor = (layerId: string): LayerIds => ({
  source: `atlas-${layerId}`,
  footprint: `atlas-${layerId}-footprint`,
  footprintEdge: `atlas-${layerId}-footprint-edge`,
  track: `atlas-${layerId}-track`,
  dot: `atlas-${layerId}-dot`,
  label: `atlas-${layerId}-label`,
});

/** What the footprint of the selected object should be drawn against. */
export interface SatelliteFootprint {
  /**
   * Horizon floor, degrees — the same value the pass list is filtered by, so
   * the circle on the map and the list beside it can never disagree about
   * what counts as visible.
   */
  minElevationDeg: number;
  /** Where the user is standing, for the overhead test. */
  observer: { lat: number; lng: number };
}

/** Hit-test layers shared with the single map identify pass. */
export const satelliteIdentifyLayers = (layerId: string): string[] => {
  const ids = idsFor(layerId);
  return [ids.label, ids.dot];
};

export interface SatelliteLayerState {
  active: boolean;
  elements: readonly SatelliteOmm[];
  fetchedAt: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /**
   * Whether the selected object is above the observer's horizon right now —
   * null when nothing is selected. Ticks with the map, so a card reading it
   * flips at the same moment the user's position crosses the drawn rim.
   */
  overhead: boolean | null;
}

/** One point per object: the cheap half, rebuilt every tick. */
function pointFeatures(
  elements: readonly SatelliteOmm[],
  at: Date,
  layerId: string,
  selectedNoradId: number | null,
): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  for (const omm of elements) {
    const fix = subpointAt(omm, at);
    // A decayed object, or elements SGP4 will not take: it drops off the map
    // rather than being drawn somewhere meaningless.
    if (!fix) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [fix.lng, fix.lat] },
      properties: {
        noradId: fix.noradId,
        layerId,
        name: fix.name,
        station: fix.group === 'stations',
        sunlit: fix.sunlit,
        color: fix.sunlit ? SUNLIT_COLOR : ECLIPSED_COLOR,
        altitudeKm: Math.round(fix.altitudeKm),
        speedKmH: Math.round(fix.speedKmS * 3600),
        ageDays: Number(fix.ageDays.toFixed(2)),
        selected: fix.noradId === selectedNoradId,
      },
    });
  }
  return features;
}

/**
 * The stations' and selected object's ground tracks: a full revolution each,
 * ~190 propagations per object against one for a dot. Recomputed on its own slow cadence and held,
 * because a track a minute old is visually identical to a fresh one — but a
 * `setData` that omitted it would blink it off the map every tick.
 */
function trackFeatures(
  elements: readonly SatelliteOmm[],
  at: Date,
  selectedNoradId: number | null,
): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  for (const omm of elements) {
    // Stations keep their tracks all the time. Picking any other object adds
    // just that orbit, which makes an individual dot in the visual or Starlink
    // cloud possible to follow without turning the whole map into spaghetti.
    if (omm.ATLAS_GROUP !== 'stations' && omm.NORAD_CAT_ID !== selectedNoradId) continue;
    for (const segment of groundTrackSegments(omm, { at, revolutions: 1, stepSeconds: 30 })) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: segment },
        properties: {
          track: true,
          noradId: omm.NORAD_CAT_ID,
          name: omm.OBJECT_NAME,
          selected: omm.NORAD_CAT_ID === selectedNoradId,
        },
      });
    }
  }
  return features;
}

/**
 * The selected object's horizon circle: the ground it can currently be seen
 * from, and the answer to "is that us".
 *
 * Only ever the selected object. Two permanent 2000 km discs for the stations
 * would cover a good part of the map at the zoom anyone reads a constellation
 * at, and the station tracks already say where they are; the disc is the thing
 * you ask for about one object at a time.
 */
function footprintFeatures(
  elements: readonly SatelliteOmm[],
  at: Date,
  selectedNoradId: number | null,
  footprint: SatelliteFootprint | null,
): { features: GeoJSON.Feature[]; overhead: boolean | null } {
  if (selectedNoradId === null || !footprint) return { features: [], overhead: null };
  const omm = elements.find((element) => element.NORAD_CAT_ID === selectedNoradId);
  if (!omm) return { features: [], overhead: null };
  const fix = subpointAt(omm, at);
  if (!fix) return { features: [], overhead: null };
  const ring = footprintRing(fix, { minElevationDeg: footprint.minElevationDeg });
  if (ring.length === 0) return { features: [], overhead: null };
  const overhead = coversGround(fix, footprint.observer, footprint.minElevationDeg);
  return {
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { footprint: true, noradId: fix.noradId, overhead },
      },
    ],
    overhead,
  };
}

export function useSatellitesLayer(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
  layerId: string,
  selectedNoradId: number | null = null,
  footprint: SatelliteFootprint | null = null,
): SatelliteLayerState {
  const elementsRef = useRef<SatelliteOmm[]>([]);
  const fetchedRevRef = useRef<number | null>(null);
  const trackAtRef = useRef(0);
  const tracksRef = useRef<GeoJSON.Feature[]>([]);
  const [state, setState] = useState<Omit<SatelliteLayerState, 'active' | 'overhead'>>({
    elements: [],
    fetchedAt: null,
    status: 'idle',
  });
  // Read inside the tick rather than closed over, so moving the observer or
  // the elevation slider does not tear down and rebuild the map layers.
  const footprintRef = useRef(footprint);
  footprintRef.current = footprint;
  const [overhead, setOverhead] = useState<boolean | null>(null);
  // Lets the elevation control repaint the disc at once. Without it the change
  // would wait for the next propagation tick, up to two seconds of a button
  // that looks like it did nothing.
  const drawRef = useRef<(() => void) | null>(null);

  const active = overlays.find((o) => o.meta.id === layerId && o.meta.vector);
  const rev = active?.meta.rev ?? 0;
  const opacity = active?.opacity ?? 1;
  const metaRef = useRef<LayerMeta | undefined>(active?.meta);
  metaRef.current = active?.meta;

  useEffect(() => {
    if (!map) return;
    const ids = idsFor(layerId);
    // Selection changes which non-station track belongs in the held set.
    trackAtRef.current = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const removeAll = () => {
      if (!map.getStyle()) return;
      for (const id of [ids.label, ids.dot, ids.track, ids.footprintEdge, ids.footprint]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(ids.source)) map.removeSource(ids.source);
    };

    if (!active) {
      removeAll();
      return;
    }

    const ensure = () => {
      if (cancelled || !map.getStyle()) return;
      if (!map.getSource(ids.source)) {
        map.addSource(ids.source, { type: 'geojson', data: EMPTY });
      }
      // Added first so it sits under the tracks and dots: it is context for
      // them, not a thing to be read over the top of them.
      if (!map.getLayer(ids.footprint)) {
        map.addLayer({
          id: ids.footprint,
          type: 'fill',
          source: ids.source,
          filter: ['==', ['get', 'footprint'], true],
          paint: {
            'fill-color': SELECTED_COLOR,
            'fill-opacity': 0.12 * opacity,
          },
        });
      }
      if (!map.getLayer(ids.footprintEdge)) {
        map.addLayer({
          id: ids.footprintEdge,
          type: 'line',
          source: ids.source,
          filter: ['==', ['get', 'footprint'], true],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': SELECTED_COLOR,
            'line-width': 1.5,
            'line-opacity': 0.7 * opacity,
          },
        });
      }
      if (!map.getLayer(ids.track)) {
        map.addLayer({
          id: ids.track,
          type: 'line',
          source: ids.source,
          filter: ['==', ['get', 'track'], true],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['case', ['get', 'selected'], '#38bdf8', SUNLIT_COLOR],
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              2,
              ['case', ['get', 'selected'], 2, 1],
              8,
              ['case', ['get', 'selected'], 3, 2],
            ],
            'line-opacity': ['case', ['get', 'selected'], 0.85 * opacity, 0.45 * opacity],
            'line-dasharray': [2, 2],
          },
        });
      }
      if (!map.getLayer(ids.dot)) {
        map.addLayer({
          id: ids.dot,
          type: 'circle',
          source: ids.source,
          // Both exclusions matter: a circle layer draws one circle per
          // *vertex*, so without the footprint clause the polygon's rim would
          // come out as 128 stray dots — and hit-test as them too.
          filter: ['all', ['!=', ['get', 'track'], true], ['!=', ['get', 'footprint'], true]],
          paint: {
            // Size carries the group, colour carries illumination — one meaning
            // per channel, so a dim station still reads as a station.
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              2,
              ['case', ['get', 'selected'], 7, ['get', 'station'], 5, 2],
              8,
              ['case', ['get', 'selected'], 11, ['get', 'station'], 9, 4],
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': ['case', ['get', 'selected'], 3, ['get', 'station'], 2, 0],
            'circle-stroke-color': ['case', ['get', 'selected'], '#38bdf8', '#ffffff'],
            'circle-opacity': opacity,
            'circle-stroke-opacity': opacity,
          },
        });
      }
      if (!map.getLayer(ids.label)) {
        map.addLayer({
          id: ids.label,
          type: 'symbol',
          source: ids.source,
          // Only the stations are named. The same treatment across 157 rocket
          // bodies — let alone 11 000 Starlink — is an unreadable map.
          filter: [
            'all',
            ['!=', ['get', 'track'], true],
            ['!=', ['get', 'footprint'], true],
            ['==', ['get', 'station'], true],
          ],
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 12,
            'text-offset': [0, 1.2],
            'text-anchor': 'top',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#f8fafc',
            'text-halo-color': 'rgba(15,23,42,0.85)',
            'text-halo-width': 1.2,
            'text-opacity': opacity,
          },
        });
      } else {
        map.setPaintProperty(ids.footprint, 'fill-opacity', 0.12 * opacity);
        map.setPaintProperty(ids.footprintEdge, 'line-opacity', 0.7 * opacity);
        map.setPaintProperty(ids.dot, 'circle-opacity', opacity);
        map.setPaintProperty(ids.dot, 'circle-stroke-opacity', opacity);
        map.setPaintProperty(ids.label, 'text-opacity', opacity);
        map.setPaintProperty(ids.track, 'line-opacity', [
          'case',
          ['get', 'selected'],
          0.85 * opacity,
          0.45 * opacity,
        ]);
      }
    };

    const draw = () => {
      if (cancelled || !map.getStyle()) return;
      const elements = elementsRef.current;
      if (elements.length === 0) return;
      const source = map.getSource(ids.source) as maplibregl.GeoJSONSource | undefined;
      if (!source) return;
      const now = Date.now();
      const at = new Date(now);
      if (now - trackAtRef.current >= TRACK_REFRESH_MS) {
        trackAtRef.current = now;
        tracksRef.current = trackFeatures(elements, at, selectedNoradId);
      }
      // Rebuilt every tick, unlike the tracks: this is one object's ring, and
      // it is the feature whose whole point is that it moves over you.
      const disc = footprintFeatures(elements, at, selectedNoradId, footprintRef.current);
      source.setData({
        type: 'FeatureCollection',
        features: [
          ...disc.features,
          ...tracksRef.current,
          ...pointFeatures(elements, at, layerId, selectedNoradId),
        ],
      });
      // Only on a change: this runs once a second, and a setState per tick
      // would re-render the card's whole pass list for nothing.
      setOverhead((current) => (current === disc.overhead ? current : disc.overhead));
    };

    const startTicking = () => {
      if (timer) clearInterval(timer);
      const period = elementsRef.current.length > LARGE_SET ? TICK_LARGE_MS : TICK_SMALL_MS;
      timer = setInterval(() => {
        // A background tab must not spend the battery propagating a map nobody
        // is looking at; the next visible tick catches straight up, because
        // position is a function of the clock and not of the last frame.
        if (typeof document !== 'undefined' && document.hidden) return;
        draw();
      }, period);
    };

    const load = () => {
      const meta = metaRef.current;
      if (!meta || fetchedRevRef.current === meta.rev) return;
      fetchedRevRef.current = meta.rev;
      setState((current) => ({ ...current, status: 'loading' }));
      void (async () => {
        try {
          const res = await fetch(satelliteElementsUrl('', meta));
          if (!res.ok) throw new Error(`satellite elements: HTTP ${res.status}`);
          if (cancelled) return;
          const body = (await res.json()) as SatelliteElementSet;
          if (cancelled || !Array.isArray(body.satellites)) return;
          elementsRef.current = body.satellites;
          setState({
            elements: body.satellites,
            fetchedAt: body.fetchedAt,
            status: 'ready',
          });
          // Force a track rebuild against the set that just arrived.
          trackAtRef.current = 0;
          draw();
          startTicking();
        } catch {
          // Offline, or the instance has never reached CelesTrak. Any elements
          // already in hand keep propagating; a later activation retries.
          fetchedRevRef.current = null;
          if (elementsRef.current.length === 0) {
            setState((current) => ({ ...current, status: 'error' }));
          }
        }
      })();
    };

    drawRef.current = draw;
    const sync = () => {
      ensure();
      draw();
    };
    sync();
    load();
    startTicking();
    map.on('style.load', sync);
    return () => {
      cancelled = true;
      drawRef.current = null;
      if (timer) clearInterval(timer);
      map.off('style.load', sync);
    };
  }, [map, layerId, Boolean(active), rev, opacity, selectedNoradId]);

  // Primitives, not the object: the caller rebuilds it every render.
  useEffect(() => {
    drawRef.current?.();
  }, [footprint?.minElevationDeg, footprint?.observer.lat, footprint?.observer.lng]);

  // No circle asked for, no answer — rather than the last one, which would
  // outlive the layer being switched off.
  return { active: Boolean(active), ...state, overhead: footprint ? overhead : null };
}
