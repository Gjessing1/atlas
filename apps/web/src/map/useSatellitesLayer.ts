import { satelliteElementsUrl, type LayerMeta } from '@atlas/core';
import {
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
  track: string;
  dot: string;
  label: string;
}

const idsFor = (layerId: string): LayerIds => ({
  source: `atlas-${layerId}`,
  track: `atlas-${layerId}-track`,
  dot: `atlas-${layerId}-dot`,
  label: `atlas-${layerId}-label`,
});

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

export function useSatellitesLayer(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
  layerId: string,
  selectedNoradId: number | null = null,
): SatelliteLayerState {
  const elementsRef = useRef<SatelliteOmm[]>([]);
  const fetchedRevRef = useRef<number | null>(null);
  const trackAtRef = useRef(0);
  const tracksRef = useRef<GeoJSON.Feature[]>([]);
  const [state, setState] = useState<Omit<SatelliteLayerState, 'active'>>({
    elements: [],
    fetchedAt: null,
    status: 'idle',
  });

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
      for (const id of [ids.label, ids.dot, ids.track]) {
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
          filter: ['!=', ['get', 'track'], true],
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
          filter: ['all', ['!=', ['get', 'track'], true], ['==', ['get', 'station'], true]],
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
      source.setData({
        type: 'FeatureCollection',
        features: [...tracksRef.current, ...pointFeatures(elements, at, layerId, selectedNoradId)],
      });
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
      if (timer) clearInterval(timer);
      map.off('style.load', sync);
    };
  }, [map, layerId, Boolean(active), rev, opacity, selectedNoradId]);

  return { active: Boolean(active), ...state };
}
