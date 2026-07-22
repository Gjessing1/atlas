import { scaleBarFor } from '@atlas/core';
import { useMemo } from 'react';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';

interface Props {
  /** Map centre latitude — ground resolution shrinks towards the poles. */
  lat: number;
  zoom: number;
  /** Distance from the bottom edge, already including the safe-area inset. */
  bottom: number;
  /** Distance from the left edge, likewise inset-adjusted (landscape nav bar). */
  left?: number;
  /** Longest the bar may draw, in px. The rounded distance fits inside this. */
  maxWidth?: number;
}

/**
 * Metric scale bar, drawn in JS.
 *
 * Replaces MapLibre Native's ScaleBarPlugin, which picks metric vs imperial
 * from the device locale and exposes no unit option through
 * maplibre-react-native (`scaleBar` is a bare boolean) — so an en-US device
 * showed feet. Atlas is metric everywhere, hence our own bar.
 */
export function ScaleBar({ lat, zoom, bottom, left = 20, maxWidth = 110 }: Props) {
  const bar = useMemo(() => scaleBarFor(lat, zoom, maxWidth), [lat, zoom, maxWidth]);
  const dark = useColorScheme() === 'dark';
  const ink = dark ? '#fff' : '#111';
  const halo = dark ? 'rgba(22,28,33,0.92)' : 'rgba(255,255,255,0.92)';
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom, left }]}>
      <Text style={[styles.label, { color: ink, textShadowColor: halo }]}>{bar.label}</Text>
      <View
        style={[
          styles.bar,
          { width: Math.round(bar.widthPx), borderColor: ink, backgroundColor: halo },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', alignItems: 'flex-start' },
  // Text is drawn over the map, so it carries its own halo rather than a plate.
  label: {
    fontSize: 11,
    fontWeight: '600',
    textShadowRadius: 2,
    marginBottom: 2,
  },
  bar: {
    height: 4,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderBottomWidth: 2,
  },
});
