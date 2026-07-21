import { scaleBarFor } from '@atlas/core';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../ui/theme';

interface Props {
  /** Map centre latitude — ground resolution shrinks towards the poles. */
  lat: number;
  zoom: number;
  /** Distance from the bottom edge, already including the safe-area inset. */
  bottom: number;
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
export function ScaleBar({ lat, zoom, bottom, maxWidth = 110 }: Props) {
  const bar = useMemo(() => scaleBarFor(lat, zoom, maxWidth), [lat, zoom, maxWidth]);
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom }]}>
      <Text style={styles.label}>{bar.label}</Text>
      <View style={[styles.bar, { width: Math.round(bar.widthPx) }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 20, alignItems: 'flex-start' },
  // Text is drawn over the map, so it carries its own halo rather than a plate.
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.text,
    textShadowColor: theme.surface,
    textShadowRadius: 2,
    marginBottom: 2,
  },
  bar: {
    height: 4,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: theme.text,
    backgroundColor: theme.surfaceOverlay,
  },
});
