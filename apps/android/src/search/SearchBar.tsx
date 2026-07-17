import type { SearchResult } from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LocalPack } from '../regions/packs';
import { geoSearch } from './geoSearch';

/**
 * Geocoding box: the server's Photon proxy (/api/search) when online, the
 * downloaded packs' FTS5 databases when it can't be reached. The expanded
 * overlay only — App owns the round 🔍 button (bottom-left cluster) and the
 * open state; the input stays at the top so the keyboard never covers it.
 */
export function SearchBar({
  packs,
  onPick,
  onClose,
  top = 0,
}: {
  packs: LocalPack[];
  onPick: (result: SearchResult) => void;
  onClose: () => void;
  /** Absolute top offset (px) for the expanded input. */
  top?: number;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [offline, setOffline] = useState(false);
  const generation = useRef(0);

  const search = useCallback(
    async (text: string) => {
      const gen = ++generation.current;
      if (text.trim().length < 2) {
        setResults([]);
        return;
      }
      const { results: found, offline: usedOffline } = await geoSearch(packs, text);
      if (gen === generation.current) {
        setResults(found);
        setOffline(usedOffline);
      }
    },
    [packs],
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

  // The overlay can also be unmounted from outside (navigation starting, route
  // planning opening) — the soft keyboard must never outlive the input.
  useEffect(() => {
    return () => Keyboard.dismiss();
  }, []);

  return (
    <View style={[styles.wrap, { top }]}>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="Search places"
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoFocus
          testID="search-input"
        />
        <Pressable style={styles.closeButton} onPress={close} testID="search-close">
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
      {results.length > 0 ? (
        <View style={styles.results}>
          {offline ? <Text style={styles.offlineTag}>offline results</Text> : null}
          {results.map((r, i) => (
            <Pressable
              key={`${r.name}-${i}`}
              style={styles.result}
              testID={`search-result-${i}`}
              onPress={() => {
                close();
                onPick(r);
              }}
            >
              <Text style={styles.resultName}>{r.name}</Text>
              {r.label ? <Text style={styles.resultLabel}>{r.label}</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
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
  closeText: { fontSize: 16, color: '#778' },
  results: {
    backgroundColor: '#fff',
    borderRadius: 10,
    marginTop: 6,
    paddingVertical: 4,
    elevation: 4,
  },
  offlineTag: { fontSize: 11, color: '#886', paddingHorizontal: 14, paddingTop: 4 },
  result: { paddingHorizontal: 14, paddingVertical: 8 },
  resultName: { fontSize: 15, color: '#111' },
  resultLabel: { fontSize: 12, color: '#778' },
});
