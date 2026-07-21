import { pathViaLabels, ROUTING_PROFILES } from '@atlas/routing';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { NavController } from './useNavigation';
import { BottomSheet } from '../ui/BottomSheet';
import { PROFILE_ICON } from '../ui/modeIcons';

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
    <BottomSheet
      visible
      mode="map"
      onClose={nav.stop}
      initialSnap="peek"
      peekHeight={236}
      bottomInset={bottomInset}
      sheetStyle={
        landscape
          ? {
              right: undefined,
              width: Math.min(420, Math.round(win.width * 0.45)),
              borderTopRightRadius: 18,
            }
          : undefined
      }
      contentStyle={styles.content}
      testID="route-preview-sheet"
    >
      {/* A walk to the car ferry is a different trip: switch the profile here
          and the choices refetch for the same origin/destination. */}
      <View style={styles.profileRow}>
        {ROUTING_PROFILES.map((p) => {
          const active = p.id === nav.profile;
          const Icon = PROFILE_ICON[p.id];
          return (
            <Pressable
              key={p.id}
              style={[styles.profileChip, active && styles.profileChipActive]}
              onPress={() => nav.setProfile(p.id)}
              disabled={nav.previewLoading}
              testID={`nav-profile-${p.id}`}
            >
              <Icon color={active ? '#1d4fd7' : '#5c6270'} size={18} />
              <Text style={[styles.profileLabel, active && styles.profileLabelActive]}>
                {p.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {nav.previewError ? (
        <Text style={styles.previewError}>No route for that profile — kept the current one</Text>
      ) : null}
      <ScrollView
        style={[styles.choices, nav.previewLoading && styles.choicesLoading]}
        bounces={false}
      >
        {paths.map((path, i) => {
          const selected = i === nav.previewIndex;
          return (
            <Pressable
              key={i}
              style={[styles.choice, selected && styles.choiceSelected]}
              onPress={() => nav.selectPreview(i)}
              disabled={nav.previewLoading}
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
        <Pressable
          style={[styles.go, nav.previewLoading && styles.goDisabled]}
          onPress={() => void nav.go()}
          disabled={nav.previewLoading}
          testID="preview-go"
        >
          <Text style={styles.goText}>{nav.previewLoading ? 'Finding routes…' : 'Start'}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: 10 },
  profileRow: { flexDirection: 'row', gap: 8 },
  profileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#eceef2',
  },
  profileChipActive: { backgroundColor: '#d7e4ff' },
  profileLabel: { fontSize: 13, fontWeight: '600', color: '#5c6270' },
  profileLabelActive: { color: '#1d4fd7' },
  previewError: { fontSize: 13, color: '#b3261e' },
  choices: { flex: 1 },
  choicesLoading: { opacity: 0.45 },
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
  goDisabled: { backgroundColor: '#9db9e8' },
  goText: { fontSize: 15, fontWeight: '700', color: '#fff' },
});
