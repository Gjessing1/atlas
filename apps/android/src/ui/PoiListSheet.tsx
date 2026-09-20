import { EXPLORE_REFRESH, type PoiListState } from '@atlas/app-hooks';
import {
  fmtDistanceM,
  parseOpeningHours,
  poiCategory,
  type PoiCategoryId,
  type PoiResult,
} from '@atlas/core';
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BottomSheet, type BottomSheetHandle, type SheetSnap } from './BottomSheet';
import { PoiCategoryDock } from './PoiCategoryDock';
import { theme } from './theme';

/**
 * The selector-sized peek: the category row plus the list's own heading. The map
 * chrome above it is positioned from this, so it lives here with the sheet.
 */
export const POI_SHEET_PEEK = 132;
/** BottomSheet's drag handle sits above the peeked content (`handleTouch`). */
export const POI_SHEET_HANDLE = 28;

export function PoiListSheet({
  list,
  categories,
  loading,
  error,
  tooWide,
  onToggleCategory,
  onShowAll,
  onPick,
  bottomInset,
}: {
  list: PoiListState;
  categories: readonly PoiCategoryId[];
  loading: boolean;
  error: boolean;
  tooWide: boolean;
  onToggleCategory: (id: PoiCategoryId) => void;
  onShowAll: () => void;
  onPick: (result: PoiResult) => void;
  bottomInset: number;
}) {
  const sheet = useRef<BottomSheetHandle>(null);
  const snap = useRef<SheetSnap>('peek');
  const scroll = useRef<ScrollView>(null);
  // Read through a ref, not a dependency: restoring the offset is for a sheet
  // that has just remounted behind a card, and reapplying it on every scroll
  // event would fight the user's own fling.
  const offsetRef = useRef(list.scrollOffset);
  offsetRef.current = list.scrollOffset;
  useEffect(() => {
    scroll.current?.scrollTo({ y: offsetRef.current, animated: false });
  }, [list.results]);
  const noun = categories.length === 1 ? poiCategory(categories[0]!).label.toLowerCase() : 'places';
  const status = tooWide
    ? 'Zoom in to search a smaller area'
    : loading && list.results.length === 0
      ? 'Finding places…'
      : error && list.results.length === 0
        ? 'Places are unavailable'
        : `${list.results.length} ${list.results.length === 1 ? 'place' : 'places'} in this area`;

  return (
    <BottomSheet
      ref={sheet}
      visible
      mode="map"
      initialSnap="peek"
      peekHeight={POI_SHEET_PEEK}
      bottomInset={bottomInset}
      // Peek *is* the floor: this sheet is the POI selector, which stays on the
      // map for as long as the layer is on. A downward drag from peek therefore
      // settles back onto it instead of dismissing the selector with it.
      onClose={() => sheet.current?.snapTo('peek')}
      // Back collapses a pulled-up list, and at peek belongs to the app: this
      // sheet *is* the selector and stays for as long as the layer is on, so
      // consuming Back here would leave the map with no way back at all.
      onBack={() => {
        if (snap.current === 'peek') return false;
        sheet.current?.snapTo('peek');
        return true;
      }}
      onSnapChange={(next) => {
        snap.current = next;
        if (next !== 'peek') list.open();
      }}
      contentStyle={styles.content}
      testID="poi-list-sheet"
    >
      <PoiCategoryDock categories={categories} onToggle={onToggleCategory} onShowAll={onShowAll} />
      <View style={styles.head}>
        <View>
          <Text style={styles.title}>Places in view</Text>
          <Text style={styles.status}>{status}</Text>
        </View>
        {list.stale ? (
          <Pressable onPress={list.refresh} testID="poi-list-refresh">
            <Text style={styles.refresh}>↻ {EXPLORE_REFRESH}</Text>
          </Pressable>
        ) : error ? (
          <Pressable onPress={list.refresh}>
            <Text style={styles.refresh}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
      {!loading && !error && !tooWide && list.results.length === 0 ? (
        <Text style={styles.empty}>No {noun} in this area. Zoom out for a larger search.</Text>
      ) : null}
      <ScrollView
        ref={scroll}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onScroll={(event) => list.setScrollOffset(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={100}
        directionalLockEnabled
        testID="poi-results-list"
      >
        {list.results.map((result) => {
          const hours = parseOpeningHours(result.openingHours);
          return (
            <Pressable
              key={result.id}
              style={styles.row}
              onPress={() => onPick(result)}
              testID={`poi-result-${result.id.replace('/', '-')}`}
            >
              <View style={styles.copy}>
                <Text style={styles.name} numberOfLines={1}>
                  {result.name}
                </Text>
                <Text style={styles.detail} numberOfLines={1}>
                  {[result.category, hours?.statusText, hours?.nextOpenOrClose]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              {result.distanceM !== undefined ? (
                <Text style={styles.distance}>{fmtDistanceM(result.distanceM)}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: 6 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
  },
  title: { color: theme.text, fontSize: 14, fontWeight: '800' },
  status: { color: theme.textMuted, fontSize: 11, opacity: 0.72 },
  refresh: { color: theme.warning, fontSize: 12, fontWeight: '800' },
  empty: { color: theme.textMuted, fontSize: 12, paddingHorizontal: 8, paddingVertical: 8 },
  list: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  listContent: { paddingBottom: 12 },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  copy: { flex: 1, minWidth: 0 },
  name: { color: theme.text, fontSize: 13, fontWeight: '700' },
  detail: { color: theme.textMuted, fontSize: 11, opacity: 0.72 },
  distance: { color: theme.textMuted, fontSize: 11 },
});
