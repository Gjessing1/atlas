import {
  LIGHTNING_AGE_BANDS,
  LIGHTNING_PULSE_MS,
  LIGHTNING_PULSE_STILL,
  LIGHTNING_STROKE_COLOR,
  lightningBandExpression,
  lightningFlashFilter,
  lightningHasFlash,
  lightningPulse,
  type LightningResponse,
} from '@atlas/conditions';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import type { VectorOverlayData } from '../layers/useVectorOverlay';

export const LIGHTNING_DOT_LAYER_ID = 'atlas-lightning-dot';
export const LIGHTNING_CORE_LAYER_ID = 'atlas-lightning-core';

/** The age bands move on between refreshes; a few seconds is finer than any band edge needs. */
const CLOCK_MS = 5_000;
/** ~15 fps: smooth enough for a ring, and it runs only while a strike is under a minute old. */
const PULSE_FRAME_MS = 66;

/**
 * @atlas/conditions builds the expressions as plain JSON (it cannot depend on a
 * map library); the Layer props want the style spec's own types.
 */
const expression = (value: unknown[]) => value as never;

/**
 * Frost strikes drawn by age (LIGHTNING_AGE_BANDS in @atlas/conditions, the
 * same bands the web draws): solid dots cooling from magenta to a faint grey,
 * and a pulsing orange core with an expanding ring for a strike under a minute
 * old. Its own component so the clock and the pulse re-render these three
 * layers, not the whole map.
 */
export function LightningLayers({ lightning }: { lightning: VectorOverlayData }) {
  const data = lightning.data as unknown as LightningResponse;
  const opacity = lightning.opacity;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pulseAt, setPulseAt] = useState<number | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setReduceMotion(on));
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [data]);

  const flashing = lightningHasFlash(data, nowMs) && !reduceMotion;
  useEffect(() => {
    if (!flashing) {
      setPulseAt(null);
      return;
    }
    const timer = setInterval(() => setPulseAt(Date.now()), PULSE_FRAME_MS);
    return () => clearInterval(timer);
  }, [flashing]);

  const pulse =
    pulseAt === null
      ? LIGHTNING_PULSE_STILL
      : lightningPulse((pulseAt % LIGHTNING_PULSE_MS) / LIGHTNING_PULSE_MS);
  const band = (pick: Parameters<typeof lightningBandExpression>[1]) =>
    expression(lightningBandExpression(nowMs, pick));
  const flashFilter = expression(lightningFlashFilter(nowMs));
  const flash = LIGHTNING_AGE_BANDS[0]!;

  return (
    <GeoJSONSource id="atlas-lightning" data={lightning.data}>
      {/* Oldest first in the data, so the newest dots land on top. */}
      <Layer
        type="circle"
        id={LIGHTNING_DOT_LAYER_ID}
        minzoom={4}
        paint={{
          'circle-radius': band((b) => b.radius),
          'circle-color': band((b) => b.color),
          'circle-opacity': band((b) => b.opacity * opacity),
          'circle-stroke-color': LIGHTNING_STROKE_COLOR,
          'circle-stroke-width': band((b) => b.strokeWidth),
          'circle-stroke-opacity': 0.75 * opacity,
        }}
      />
      <Layer
        type="circle"
        id="atlas-lightning-ring"
        minzoom={4}
        filter={flashFilter}
        paint={{
          'circle-radius': pulse.ringRadius,
          'circle-color': flash.color,
          'circle-opacity': 0,
          'circle-stroke-color': flash.color,
          'circle-stroke-width': pulse.ringWidth,
          'circle-stroke-opacity': pulse.ringOpacity * opacity,
        }}
      />
      <Layer
        type="circle"
        id={LIGHTNING_CORE_LAYER_ID}
        minzoom={4}
        filter={flashFilter}
        paint={{
          'circle-radius': pulse.coreRadius,
          'circle-color': flash.color,
          'circle-opacity': opacity,
          'circle-stroke-color': LIGHTNING_STROKE_COLOR,
          'circle-stroke-width': flash.strokeWidth,
          'circle-stroke-opacity': opacity,
        }}
      />
    </GeoJSONSource>
  );
}
