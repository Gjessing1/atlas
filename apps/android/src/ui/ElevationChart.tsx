import { fmtKm } from '@atlas/core';
import { buildElevationProfile, type TrackData } from '@atlas/gpx';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { theme } from './theme';

const CHART_HEIGHT = 96;
/** Downsample to roughly one bar per couple of px so layout stays cheap. */
const MAX_BARS = 160;

/**
 * Interactive elevation profile — the mobile counterpart of the web
 * ElevationProfile (apps/web/src/ElevationProfile.tsx). Drawn with plain Views
 * (a column per sample) instead of SVG so it needs no native chart/SVG module
 * and stays OTA-updatable. Touch-drag scrubs a crosshair with an elevation +
 * distance readout, like the web chart's hover.
 */
export function ElevationChart({ data }: { data: TrackData }) {
  const [width, setWidth] = useState(0);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);

  const profile = useMemo(() => buildElevationProfile(data, MAX_BARS), [data]);

  const chart = useMemo(() => {
    if (profile.length < 2) return null;
    const maxDist = profile[profile.length - 1]!.distM;
    let minEle = Infinity;
    let maxEle = -Infinity;
    for (const p of profile) {
      if (p.ele < minEle) minEle = p.ele;
      if (p.ele > maxEle) maxEle = p.ele;
    }
    // Flat tracks still get a visible band rather than a zero-height chart.
    if (maxEle - minEle < 10) {
      const mid = (minEle + maxEle) / 2;
      minEle = mid - 5;
      maxEle = mid + 5;
    }
    const heightFor = (ele: number) =>
      Math.max(2, Math.round(((ele - minEle) / (maxEle - minEle)) * CHART_HEIGHT));
    return { maxDist, minEle, maxEle, heightFor };
  }, [profile]);

  if (!chart) {
    return <Text style={styles.empty}>No elevation data.</Text>;
  }

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const scrubTo = (x: number) => {
    if (width <= 0) return;
    const index = Math.min(
      profile.length - 1,
      Math.max(0, Math.round((x / width) * (profile.length - 1))),
    );
    setScrubIndex(index);
  };

  const scrubbed = scrubIndex !== null ? profile[scrubIndex] : undefined;
  const scrubX = scrubIndex !== null ? (scrubIndex / (profile.length - 1)) * width : 0;

  return (
    <View>
      <View style={styles.readoutRow}>
        <Text style={styles.axisLabel}>{Math.round(chart.maxEle)} m</Text>
        {scrubbed ? (
          <Text style={styles.readout}>
            {Math.round(scrubbed.ele)} m · {fmtKm(scrubbed.distM)}
          </Text>
        ) : (
          <Text style={styles.readoutHint}>touch the chart to inspect</Text>
        )}
      </View>
      <View
        style={styles.chart}
        onLayout={onLayout}
        // A plain touch handler (not PanResponder) is enough: the chart lives
        // inside sheets/panels whose ScrollViews still win vertical drags.
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => scrubTo(e.nativeEvent.locationX)}
        onResponderMove={(e) => scrubTo(e.nativeEvent.locationX)}
        onResponderRelease={() => setScrubIndex(null)}
        onResponderTerminate={() => setScrubIndex(null)}
        testID="elevation-chart"
      >
        {profile.map((p, i) => (
          <View
            key={i}
            style={[styles.bar, { height: chart.heightFor(p.ele) }]}
            pointerEvents="none"
          />
        ))}
        {scrubbed ? (
          <View pointerEvents="none" style={[styles.crosshair, { left: scrubX }]} />
        ) : null}
      </View>
      <View style={styles.readoutRow}>
        <Text style={styles.axisLabel}>{Math.round(chart.minEle)} m</Text>
        <Text style={styles.axisLabel}>{fmtKm(chart.maxDist)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chart: {
    height: CHART_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: theme.surfaceMuted,
    borderRadius: 8,
    overflow: 'hidden',
  },
  bar: { flex: 1, backgroundColor: '#7fb0e8' },
  crosshair: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: '#16324f',
  },
  readoutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  axisLabel: { fontSize: 11, color: theme.textMuted },
  readout: { fontSize: 12, color: theme.text, fontWeight: '700' },
  readoutHint: { fontSize: 11, color: theme.textMuted },
  empty: { fontSize: 13, color: theme.textMuted },
});
