import {
  useExplore,
  EXPLORE_EMPTY,
  EXPLORE_REFRESH,
  EXPLORE_TITLE,
  type ExploreArea,
  type ExploreQuery,
} from '@atlas/app-hooks';
import {
  clampExploreRadiusM,
  EXPLORE_CATEGORIES,
  fmtDistanceM,
  type LatLng,
  type SearchResult,
} from '@atlas/core';
import { useCallback } from 'react';
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { LocalPack } from '../regions/packs';
import { geoExplore } from '../search/geoExplore';
import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

function viewRadiusM(center: LatLng, zoom: number): number {
  const { width, height } = Dimensions.get('window');
  const metresPerPixel =
    (156_543.03392 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** Math.max(0, zoom);
  return clampExploreRadiusM((Math.hypot(width, height) / 2) * metresPerPixel);
}

/** Offline-capable category browse over the current Android map view. */
export function ExploreSheet({
  visible,
  packs,
  getCenter,
  zoom,
  onPick,
  onClose,
  bottomInset,
}: {
  visible: boolean;
  packs: LocalPack[];
  getCenter: () => Promise<LatLng | null>;
  zoom: number;
  onPick: (result: SearchResult) => void;
  onClose: () => void;
  bottomInset: number;
}) {
  const getArea = useCallback(async (): Promise<ExploreArea | null> => {
    const center = await getCenter();
    return center ? { center, radiusM: viewRadiusM(center, zoom) } : null;
  }, [getCenter, zoom]);

  // The pack fallback is what makes this sheet answer at all in the field; the
  // shared hook only ever sees "the query succeeded, offline or not".
  const fetchNearby = useCallback(
    ({ category, center, radiusM }: ExploreQuery) => geoExplore(packs, category, center, radiusM),
    [packs],
  );

  const explore = useExplore({ getArea, fetchNearby, active: visible });

  return (
    <BottomSheet
      visible={visible}
      mode="map"
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="explore-sheet"
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.heading}>{EXPLORE_TITLE}</Text>
          <Text style={styles.muted}>{explore.subtitle}</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.categories}>
        {EXPLORE_CATEGORIES.map((item) => (
          <Pressable
            key={item.id}
            style={[styles.category, explore.category === item.id && styles.categorySelected]}
            onPress={() => explore.setCategory(item.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: explore.category === item.id }}
            testID={`explore-${item.id}`}
          >
            <Text style={styles.categoryText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.status}>
        <Text style={styles.muted}>{explore.status}</Text>
        <Pressable onPress={explore.refresh}>
          <Text style={styles.refresh}>{EXPLORE_REFRESH}</Text>
        </Pressable>
      </View>
      {explore.showEmpty ? <Text style={styles.empty}>{EXPLORE_EMPTY}</Text> : null}
      <ScrollView style={styles.results}>
        {explore.results.map((result, index) => (
          <Pressable
            style={styles.result}
            key={`${result.name}/${result.position.lat}/${result.position.lng}`}
            onPress={() => onPick(result)}
            testID={`explore-result-${index}`}
          >
            <View style={styles.resultText}>
              <Text style={styles.resultName} numberOfLines={1}>
                {result.name}
              </Text>
              {result.label ? (
                <Text style={styles.resultLabel} numberOfLines={1}>
                  {result.label}
                </Text>
              ) : null}
            </View>
            {result.distanceM !== undefined ? (
              <Text style={styles.distance}>{fmtDistanceM(result.distanceM)}</Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { color: theme.text, fontSize: 17, fontWeight: '700' },
  muted: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  close: { color: theme.textMuted, fontSize: 18, paddingHorizontal: 4 },
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  category: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  categorySelected: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  categoryText: { color: theme.text, fontWeight: '600', fontSize: 13 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  refresh: { color: theme.accent, fontWeight: '700', fontSize: 12 },
  empty: { color: theme.textMuted, fontSize: 13, marginTop: 18 },
  results: { marginTop: 6 },
  result: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    paddingVertical: 8,
  },
  resultText: { flex: 1, paddingRight: 10 },
  resultName: { color: theme.text, fontWeight: '700', fontSize: 15 },
  resultLabel: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  distance: { color: theme.textMuted, fontSize: 12, fontWeight: '600' },
});
