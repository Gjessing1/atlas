import { pathViaLabels } from '@atlas/routing';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { NavController } from './useNavigation';

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/** Extra minutes over the fastest choice, e.g. "+4 min" ("+<1 min" when tiny). */
function formatExtra(ms: number, fastestMs: number): string {
  const min = Math.round((ms - fastestMs) / 60000);
  return min < 1 ? '+<1 min' : `+${min} min`;
}

/**
 * Route-choice card shown in the nav `preview` phase (Google-style): one row
 * per choice — fastest first and pre-selected — with duration, distance, a
 * "via …" label where the roads tell the choices apart, and the extra minutes
 * for the slower ones. Start begins guidance along the selected row.
 */
export function RoutePreview({ nav, bottomInset }: { nav: NavController; bottomInset: number }) {
  const win = useWindowDimensions();
  const paths = nav.previewPaths;
  const vias = useMemo(() => (paths ? pathViaLabels(paths) : []), [paths]);
  if (nav.phase !== 'preview' || !paths || paths.length === 0) return null;
  const fastestMs = paths[0]!.timeMs;
  // Landscape: a left-anchored card instead of a full-width sheet, so the
  // drawn route choices stay visible beside it.
  const landscape = win.width > win.height;

  return (
    <View
      style={[
        styles.wrap,
        { paddingBottom: bottomInset + 12 },
        landscape && {
          right: undefined,
          width: Math.min(420, Math.round(win.width * 0.45)),
          borderTopRightRadius: 18,
        },
      ]}
    >
      <ScrollView style={styles.choices} bounces={false}>
        {paths.map((path, i) => {
          const selected = i === nav.previewIndex;
          return (
            <Pressable
              key={i}
              style={[styles.choice, selected && styles.choiceSelected]}
              onPress={() => nav.selectPreview(i)}
              testID={`route-choice-${i}`}
            >
              <View style={styles.choiceMain}>
                <Text style={[styles.choiceTime, selected && styles.choiceTimeSelected]}>
                  {formatDuration(path.timeMs)}
                  {i > 0 ? (
                    <Text style={styles.choiceExtra}> ({formatExtra(path.timeMs, fastestMs)})</Text>
                  ) : null}
                </Text>
                <Text style={styles.choiceDetail}>
                  {formatDistance(path.distanceM)}
                  {vias[i] ? ` · via ${vias[i]}` : i === 0 ? ' · fastest' : ''}
                </Text>
              </View>
              <View style={[styles.radio, selected && styles.radioSelected]} />
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.actions}>
        <Pressable style={styles.cancel} onPress={nav.stop} testID="preview-cancel">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.go} onPress={() => void nav.go()} testID="preview-go">
          <Text style={styles.goText}>Start</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 10,
    paddingHorizontal: 14,
    elevation: 12,
    gap: 10,
  },
  choices: { maxHeight: 220 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
    borderWidth: 1.5,
    borderColor: '#e3e5ea',
  },
  choiceSelected: { borderColor: '#2b6cff', backgroundColor: '#eef3ff' },
  choiceMain: { flex: 1, gap: 2 },
  choiceTime: { fontSize: 18, fontWeight: '700', color: '#20242b' },
  choiceTimeSelected: { color: '#1d4fd7' },
  choiceExtra: { fontSize: 14, fontWeight: '600', color: '#8a8f99' },
  choiceDetail: { fontSize: 13, color: '#5c6270' },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#c3c8d1',
  },
  radioSelected: { borderWidth: 6, borderColor: '#2b6cff' },
  actions: { flexDirection: 'row', gap: 10 },
  cancel: {
    flex: 1,
    borderRadius: 22,
    paddingVertical: 11,
    alignItems: 'center',
    backgroundColor: '#eceef2',
  },
  cancelText: { fontSize: 15, fontWeight: '700', color: '#3a3f4a' },
  go: {
    flex: 2,
    borderRadius: 22,
    paddingVertical: 11,
    alignItems: 'center',
    backgroundColor: '#1a73e8',
  },
  goText: { fontSize: 15, fontWeight: '700', color: '#fff' },
});
