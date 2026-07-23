import { savedPlaceResults, type SearchablePlace, type SearchResult } from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LocalPack } from '../regions/packs';
import { BottomSheet } from '../ui/BottomSheet';
import { theme } from '../ui/theme';
import { geoSearch, type SearchBias } from './geoSearch';
import { parseRecentSearches, pushRecentSearch, RECENT_SEARCHES_SETTING } from './recentSearches';

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
  /** Current map centre, to bias results towards the viewport (web parity). */
  getBias: SearchBias;
  onPick: (result: SearchResult) => void;
  onClose: () => void;
  /** System nav-bar inset — supplied with Atlas's zero-inset fallback. */
  bottomInset?: number;
  /** Settings accessors, for the persisted recent-searches list. */
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [recent, setRecent] = useState<SearchResult[]>([]);
  const [offline, setOffline] = useState(false);
  const generation = useRef(0);
  // Read when a search runs rather than depended on — a fresh array each render.
  const placesRef = useRef(places);
  placesRef.current = places;

  useEffect(() => {
    void getSetting(RECENT_SEARCHES_SETTING).then((raw) => setRecent(parseRecentSearches(raw)));
  }, [getSetting]);

  const search = useCallback(
    async (text: string) => {
      const gen = ++generation.current;
      if (text.trim().length < 2) {
        setResults([]);
        return;
      }
      // The user's own places answer instantly and offline; a geocoder can never
      // find "Bogdan og Ada", so a query that only went upstream missed them.
      const saved = savedPlaceResults(placesRef.current, text);
      if (saved.length > 0 && gen === generation.current) setResults(saved);
      const { results: found, offline: usedOffline } = await geoSearch(packs, text, getBias);
      if (gen === generation.current) {
        setResults([...saved, ...found]);
        setOffline(usedOffline);
      }
    },
    [packs, getBias],
  );

  useEffect(() => {
    const t = setTimeout(() => void search(query), 300);
    return () => clearTimeout(t);
  }, [query, search]);

  const close = useCallback(() => {
    Keyboard.dismiss();
    setQuery('');
    setResults([]);
    onClose();
  }, [onClose]);

  const pick = useCallback(
    (result: SearchResult) => {
      setSetting(RECENT_SEARCHES_SETTING, JSON.stringify(pushRecentSearch(recent, result)));
      close();
      onPick(result);
    },
    [recent, setSetting, close, onPick],
  );

  // The overlay can also be unmounted from outside (navigation starting, route
  // planning opening) — the soft keyboard must never outlive the input.
  useEffect(() => {
    return () => Keyboard.dismiss();
  }, []);

  // An empty input shows the recent picks so frequent trips are two taps.
  const showingRecent = results.length === 0 && query.trim().length < 2;
  const shown = showingRecent ? recent : results;

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
          style={styles.input}
          placeholder="Search places or coordinates"
          value={query}
          onChangeText={setQuery}
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
      {shown.length > 0 ? (
        <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
          {showingRecent ? (
            <Text style={styles.listTag}>recent</Text>
          ) : offline ? (
            <Text style={styles.listTag}>offline results</Text>
          ) : null}
          {shown.map((r, i) => (
            <Pressable
              key={`${r.name}-${i}`}
              style={styles.result}
              testID={`search-result-${i}`}
              onPress={() => pick(r)}
            >
              <Text style={styles.resultName}>{r.name}</Text>
              {r.label ? <Text style={styles.resultLabel}>{r.label}</Text> : null}
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
  result: { paddingHorizontal: 14, paddingVertical: 8 },
  resultName: { fontSize: 15, color: theme.text },
  resultLabel: { fontSize: 12, color: theme.textMuted },
});
