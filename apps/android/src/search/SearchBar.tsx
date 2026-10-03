import { useRecentSearches, useSearch, type SearchFn } from '@atlas/app-hooks';
import {
  RECENT_SEARCHES_SETTING,
  isCollectionSearchResult,
  type MainSearchResult,
  type SearchableFolder,
  type SearchablePlace,
  type SearchableTrack,
} from '@atlas/core';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LocalPack } from '../regions/packs';
import { BottomSheet } from '../ui/BottomSheet';
import { theme } from '../ui/theme';
import { geoSearch, type SearchBias } from './geoSearch';

/**
 * Geocoding box: the server's Photon proxy (/api/search) when online, the
 * downloaded packs' FTS5 databases when it can't be reached. The expanded
 * bottom sheet only — App owns the round search button and the open state.
 * Android's adjustResize keeps the sheet above the keyboard while the common
 * snap model keeps the input and results in the thumb-reachable lower screen.
 * While the input is empty it lists the recent picks (device-local setting).
 */
export function SearchBar({
  packs,
  places,
  tracks,
  folders,
  getBias,
  onPick,
  onClose,
  bottomInset = 0,
  getSetting,
  setSetting,
}: {
  packs: LocalPack[];
  /** The user's saved places, matched locally and offered above geocoder hits. */
  places: SearchablePlace[];
  tracks: SearchableTrack[];
  folders: SearchableFolder[];
  /** Current map centre, to bias results towards the viewport (web parity). */
  getBias: SearchBias;
  onPick: (result: MainSearchResult) => void;
  onClose: () => void;
  /** System nav-bar inset — supplied with Atlas's zero-inset fallback. */
  bottomInset?: number;
  /** Settings accessors, for the persisted recent-searches list. */
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}) {
  const input = useRef<TextInput>(null);
  const fetchSearch = useCallback<SearchFn>(
    async ({ text, signal }) => geoSearch(packs, text, getBias, { signal }),
    [packs, getBias],
  );
  const search = useSearch({ search: fetchSearch, places, tracks, folders, debounceMs: 300 });

  const {
    recent,
    remember,
    clear: clearRecent,
  } = useRecentSearches(
    useMemo(
      () => ({
        load: () => getSetting(RECENT_SEARCHES_SETTING),
        save: (raw: string) => setSetting(RECENT_SEARCHES_SETTING, raw),
      }),
      [getSetting, setSetting],
    ),
  );

  const close = useCallback(() => {
    // Blur the native owner before React removes it. Keyboard.dismiss() alone
    // can race the unmount and leave Android's IME visible over a map that no
    // longer has an input.
    input.current?.blur();
    Keyboard.dismiss();
    search.reset();
    onClose();
  }, [search, onClose]);

  const pick = useCallback(
    (result: MainSearchResult) => {
      if (!isCollectionSearchResult(result)) remember(result);
      close();
      onPick(result);
    },
    [remember, close, onPick],
  );

  // The overlay can also be unmounted from outside (navigation starting, route
  // planning opening) — the soft keyboard must never outlive the input.
  useEffect(() => {
    return () => Keyboard.dismiss();
  }, []);

  // An empty input shows the recent picks so frequent trips are two taps.
  const showingRecent = search.query.trim().length < 2;
  const shown = showingRecent ? recent : search.results;

  return (
    <BottomSheet
      visible
      mode="map"
      onClose={close}
      initialSnap="half"
      peekHeight={116}
      bottomInset={bottomInset}
      testID="search-sheet"
    >
      <View style={styles.inputRow}>
        <TextInput
          ref={input}
          style={styles.input}
          placeholder="Search places, tracks or folders"
          value={search.query}
          onChangeText={search.setQuery}
          autoCorrect={false}
          // Android otherwise opens its fullscreen "extract" editor in
          // landscape, making this look like two separate search fields.
          disableFullscreenUI
          autoFocus
          testID="search-input"
        />
        <Pressable style={styles.closeButton} onPress={close} testID="search-close">
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
      {shown.length > 0 || (!showingRecent && search.statusText) ? (
        <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
          {showingRecent ? (
            // Web has offered this since its recents shipped; Android never
            // did, which left the phone the one device that cannot forget
            // where you have been.
            <View style={styles.tagRow}>
              <Text style={styles.listTag}>recent</Text>
              <Pressable onPress={clearRecent} hitSlop={10} testID="search-recent-clear">
                <Text style={styles.clearRecent}>Clear</Text>
              </Pressable>
            </View>
          ) : search.statusText ? (
            <Text style={styles.listTag}>{search.statusText}</Text>
          ) : null}
          {shown.map((r, i) => (
            <Pressable
              key={`${r.name}-${i}`}
              style={styles.result}
              testID={`search-result-${i}`}
              onPress={() => pick(r)}
            >
              <Text style={styles.resultName}>{r.name}</Text>
              {r.label ? (
                // Postcode + county make the label long enough to wrap; one
                // line per row keeps the list the same shape as the web one.
                <Text style={styles.resultLabel} numberOfLines={1}>
                  {r.label}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderRadius: 10,
    elevation: 4,
  },
  input: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  closeButton: { paddingHorizontal: 12, paddingVertical: 10 },
  closeText: { fontSize: 16, color: theme.textMuted },
  results: {
    flex: 1,
    backgroundColor: theme.surface,
    borderRadius: 10,
    marginTop: 6,
    paddingVertical: 4,
    elevation: 4,
  },
  listTag: { fontSize: 11, color: theme.textMuted, paddingHorizontal: 14, paddingTop: 4 },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 14,
  },
  clearRecent: { fontSize: 12, color: theme.accent, fontWeight: '700', paddingTop: 4 },
  result: { paddingHorizontal: 14, paddingVertical: 8 },
  resultName: { fontSize: 15, color: theme.text },
  resultLabel: { fontSize: 12, color: theme.textMuted },
});
