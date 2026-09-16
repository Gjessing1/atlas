import {
  LIGHTNING_AGE_BANDS,
  LIGHTNING_OBSERVATIONS_ID,
  LIGHTNING_PULSE_MS,
  LIGHTNING_PULSE_STILL,
  LIGHTNING_STROKE_COLOR,
  lightningBandExpression,
  lightningFlashFilter,
  lightningHasFlash,
  lightningPulse,
  type LightningPulseFrame,
  type LightningResponse,
  type LightningWindow,
} from '@atlas/conditions';
import { viewportFeaturesUrl, type LngLatBbox } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import type { ActiveOverlay } from './useOverlayLayers.js';

const SOURCE_ID = 'atlas-lightning';
const DOT_ID = 'atlas-lightning-dot';
const RING_ID = 'atlas-lightning-ring';
const CORE_ID = 'atlas-lightning-core';
const EMPTY: LightningResponse = { type: 'FeatureCollection', features: [] };
/** Frequent enough that a strike can still be inside its pulsing first minute on arrival. */
const REFRESH_MS = 20_000;
/** The age bands move on between refreshes; a few seconds is finer than any band edge needs. */
const CLOCK_MS = 5_000;
/** The pulse needs no more than this; the map repaints only while a new strike is up. */
const PULSE_FRAME_MS = 33;

export const LIGHTNING_IDENTIFY_LAYERS = [CORE_ID, DOT_ID];

type Expression = maplibregl.ExpressionSpecification;

const viewport = (map: maplibregl.Map): LngLatBbox => {
  const bounds = map.getBounds();
  return [
    Math.max(-180, bounds.getWest()),
    Math.max(-85, bounds.getSouth()),
    Math.min(180, bounds.getEast()),
    Math.min(85, bounds.getNorth()),
  ];
};

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Frost strikes over the settled viewport, drawn by age (LIGHTNING_AGE_BANDS):
 * solid dots that cool from magenta to a faint grey, and for a strike under a
 * minute old a pulsing orange core with a shockwave ring. Ages are measured
 * against this clock, not the server's, so a dot changes band between refreshes
 * and the pulse stops on time.
 */
export function useLightningLayer(
  map: maplibregl.Map | null,
  overlays: ActiveOverlay[],
  window: LightningWindow,
): void {
  const active = overlays.find(
    (overlay) => overlay.meta.id === LIGHTNING_OBSERVATIONS_ID && overlay.meta.vector,
  );
  const present = Boolean(active);
  const opacity = active?.opacity ?? 1;
  const minzoom = active?.meta.minzoom ?? 4;
  const dataRef = useRef<LightningResponse>(EMPTY);
  const metaRef = useRef(active?.meta);
  metaRef.current = active?.meta;

  useEffect(() => {
    if (!map) return;
    let stopped = false;
    let lastKey = '';
    let pulseFrame = 0;
    let lastPulseAt = 0;
    const remove = () => {
      try {
        for (const id of [CORE_ID, RING_ID, DOT_ID]) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // Style not available yet.
      }
    };
    if (!present) {
      remove();
      return;
    }

    const band = (pick: Parameters<typeof lightningBandExpression>[1]) =>
      lightningBandExpression(Date.now(), pick) as unknown as Expression;
    const flashFilter = () => lightningFlashFilter(Date.now()) as unknown as Expression;

    const paintPulse = (frame: LightningPulseFrame) => {
      if (!map.getLayer(RING_ID) || !map.getLayer(CORE_ID)) return;
      map.setPaintProperty(RING_ID, 'circle-radius', frame.ringRadius);
      map.setPaintProperty(RING_ID, 'circle-stroke-width', frame.ringWidth);
      map.setPaintProperty(RING_ID, 'circle-stroke-opacity', frame.ringOpacity * opacity);
      map.setPaintProperty(CORE_ID, 'circle-radius', frame.coreRadius);
    };

    const ensure = () => {
      if (stopped) return;
      try {
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, { type: 'geojson', data: dataRef.current });
        }
        if (!map.getLayer(DOT_ID)) {
          // Oldest first in the data, so the newest dots land on top.
          map.addLayer({
            id: DOT_ID,
            type: 'circle',
            source: SOURCE_ID,
            minzoom,
            paint: {
              'circle-radius': band((b) => b.radius),
              'circle-color': band((b) => b.color),
              'circle-opacity': band((b) => b.opacity * opacity),
              'circle-stroke-color': LIGHTNING_STROKE_COLOR,
              'circle-stroke-width': band((b) => b.strokeWidth),
              'circle-stroke-opacity': 0.75 * opacity,
            },
          });
          map.addLayer({
            id: RING_ID,
            type: 'circle',
            source: SOURCE_ID,
            minzoom,
            filter: flashFilter(),
            paint: {
              'circle-color': LIGHTNING_AGE_BANDS[0]!.color,
              'circle-opacity': 0,
              'circle-stroke-color': LIGHTNING_AGE_BANDS[0]!.color,
            },
          });
          map.addLayer({
            id: CORE_ID,
            type: 'circle',
            source: SOURCE_ID,
            minzoom,
            filter: flashFilter(),
            paint: {
              'circle-color': LIGHTNING_AGE_BANDS[0]!.color,
              'circle-opacity': opacity,
              'circle-stroke-color': LIGHTNING_STROKE_COLOR,
              'circle-stroke-width': LIGHTNING_AGE_BANDS[0]!.strokeWidth,
              'circle-stroke-opacity': opacity,
            },
          });
          paintPulse(LIGHTNING_PULSE_STILL);
        } else {
          tick();
        }
      } catch {
        // A style swap will retry.
      }
    };

    // Re-reads every band against the current clock.
    const tick = () => {
      try {
        if (!map.getLayer(DOT_ID)) return;
        map.setPaintProperty(
          DOT_ID,
          'circle-radius',
          band((b) => b.radius),
        );
        map.setPaintProperty(
          DOT_ID,
          'circle-color',
          band((b) => b.color),
        );
        map.setPaintProperty(
          DOT_ID,
          'circle-opacity',
          band((b) => b.opacity * opacity),
        );
        map.setPaintProperty(
          DOT_ID,
          'circle-stroke-width',
          band((b) => b.strokeWidth),
        );
        map.setPaintProperty(DOT_ID, 'circle-stroke-opacity', 0.75 * opacity);
        map.setFilter(RING_ID, flashFilter());
        map.setFilter(CORE_ID, flashFilter());
        map.setPaintProperty(CORE_ID, 'circle-opacity', opacity);
        map.setPaintProperty(CORE_ID, 'circle-stroke-opacity', opacity);
      } catch {
        // Style mid-swap.
      }
      animate();
    };

    // The pulse runs only while some strike is still in its first minute.
    const animate = () => {
      const flashing = lightningHasFlash(dataRef.current, Date.now());
      if (!flashing || reducedMotion()) {
        if (pulseFrame) cancelAnimationFrame(pulseFrame);
        pulseFrame = 0;
        try {
          paintPulse(LIGHTNING_PULSE_STILL);
        } catch {
          // Style mid-swap.
        }
        return;
      }
      if (pulseFrame) return;
      const step = (at: number) => {
        pulseFrame = 0;
        if (stopped) return;
        if (at - lastPulseAt >= PULSE_FRAME_MS) {
          lastPulseAt = at;
          try {
            paintPulse(lightningPulse((Date.now() % LIGHTNING_PULSE_MS) / LIGHTNING_PULSE_MS));
          } catch {
            // Style mid-swap: the next frame retries.
          }
        }
        if (lightningHasFlash(dataRef.current, Date.now())) {
          pulseFrame = requestAnimationFrame(step);
        } else {
          tick();
        }
      };
      pulseFrame = requestAnimationFrame(step);
    };

    const refresh = async (force = false) => {
      const meta = metaRef.current;
      if (!meta || map.getZoom() < minzoom) return;
      const bbox = viewport(map);
      const key = bbox.map((value) => value.toFixed(3)).join(',');
      if (!force && key === lastKey) return;
      try {
        const response = await fetch(`${viewportFeaturesUrl('', meta, bbox)}&window=${window}`);
        if (!response.ok || stopped) return;
        const data = (await response.json()) as LightningResponse;
        dataRef.current = data;
        lastKey = key;
        (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(data);
        tick();
      } catch {
        // Keep the last strikes while offline; the timer or next pan retries.
      }
    };
    const sync = () => {
      ensure();
      void refresh();
    };
    sync();
    const timer = setInterval(() => void refresh(true), REFRESH_MS);
    const clock = setInterval(tick, CLOCK_MS);
    map.on('style.load', sync);
    map.on('moveend', sync);
    return () => {
      stopped = true;
      if (pulseFrame) cancelAnimationFrame(pulseFrame);
      clearInterval(timer);
      clearInterval(clock);
      map.off('style.load', sync);
      map.off('moveend', sync);
    };
  }, [map, present, opacity, minzoom, window]);
}
