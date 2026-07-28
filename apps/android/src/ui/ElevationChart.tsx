import { fmtKm } from '@atlas/core';
import { buildElevationProfile, type TrackData } from '@atlas/gpx';
import { routeSurfaceAt, routeSurfaceBreakdown, type RouteEnrichment } from '@atlas/routing';
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
function gradeColor(grade: number): string {
  const magnitude = Math.abs(grade);
  if (magnitude < 3) return '#3b9b62';
  if (magnitude < 6) return grade < 0 ? '#54a6c7' : '#d4a52d';
  if (magnitude < 12) return grade < 0 ? '#397fba' : '#e47f2c';
  return grade < 0 ? '#315e9f' : '#d84b3e';
}

export function ElevationChart({
  data,
  enrichment,
}: {
  data: TrackData;
  enrichment?: RouteEnrichment;
}) {
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
  const scrubbedPrevious =
    scrubIndex !== null && scrubIndex > 0 ? profile[scrubIndex - 1] : undefined;
  const scrubbedGrade =
    scrubbed && scrubbedPrevious && scrubbed.distM > scrubbedPrevious.distM
      ? ((scrubbed.ele - scrubbedPrevious.ele) / (scrubbed.distM - scrubbedPrevious.distM)) * 100
      : null;
  const scrubbedSurface = scrubbed ? routeSurfaceAt(enrichment, scrubbed.distM) : null;
  const scrubX = scrubIndex !== null ? (scrubIndex / (profile.length - 1)) * width : 0;
  const surfaces = routeSurfaceBreakdown(enrichment, chart.maxDist);

  return (
    <View>
      <View style={styles.readoutRow}>
        <Text style={styles.axisLabel}>{Math.round(chart.maxEle)} m</Text>
        {scrubbed ? (
          <Text style={styles.readout}>
            {Math.round(scrubbed.ele)} m · {fmtKm(scrubbed.distM)}
            {scrubbedGrade !== null ? ` · ${scrubbedGrade.toFixed(1)}%` : ''}
            {scrubbedSurface ? ` · ${scrubbedSurface}` : ''}
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
        {profile.map((p, i) => {
          const previous = profile[i - 1];
          const distanceM = previous ? p.distM - previous.distM : 0;
          const grade = previous && distanceM > 0 ? ((p.ele - previous.ele) / distanceM) * 100 : 0;
          return (
            <View
              key={i}
              style={[
                styles.bar,
                { height: chart.heightFor(p.ele), backgroundColor: gradeColor(grade) },
              ]}
              pointerEvents="none"
            />
          );
        })}
        {scrubbed ? (
          <View pointerEvents="none" style={[styles.crosshair, { left: scrubX }]} />
        ) : null}
      </View>
      <View style={styles.readoutRow}>
        <Text style={styles.axisLabel}>{Math.round(chart.minEle)} m</Text>
        <Text style={styles.axisLabel}>{fmtKm(chart.maxDist)}</Text>
      </View>
      {surfaces.length > 0 ? (
        <View style={styles.surfaceRow}>
          <Text style={styles.surfaceTitle}>Surface</Text>
          {surfaces.map((surface) => (
            <Text key={surface.label} style={styles.axisLabel}>
              {surface.label} {surface.percent}%
            </Text>
          ))}
        </View>
      ) : null}
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
  bar: { flex: 1 },
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
  surfaceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 3 },
  surfaceTitle: { fontSize: 11, color: theme.text, fontWeight: '700' },
  empty: { fontSize: 13, color: theme.textMuted },
});
