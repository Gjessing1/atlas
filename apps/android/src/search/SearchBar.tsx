import type { SearchResult } from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SERVER_ORIGIN } from '../config';
import type { LocalPack } from '../regions/packs';
import { searchOffline } from './offlineSearch';

/**
 * Geocoding box: the server's Photon proxy (/api/search) when online, the
 * downloaded packs' FTS5 databases when it can't be reached.
 */
export function SearchBar({
  packs,
  onPick,
  topInset = 0,
}: {
  packs: LocalPack[];
  onPick: (result: SearchResult) => void;
  topInset?: number;
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
      let found: SearchResult[] = [];
      let usedOffline = false;
      try {
        const res = await fetch(`${SERVER_ORIGIN}/api/search?q=${encodeURIComponent(text)}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
        found = ((await res.json()) as { results: SearchResult[] }).results;
      } catch {
        found = await searchOffline(packs, text);
        usedOffline = true;
      }
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

  return (
    <View style={[styles.wrap, { top: topInset + 8 }]}>
      <TextInput
        style={styles.input}
        placeholder="Search places"
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        testID="search-input"
      />
      {results.length > 0 ? (
        <View style={styles.results}>
          {offline ? <Text style={styles.offlineTag}>offline results</Text> : null}
          {results.map((r, i) => (
            <Pressable
              key={`${r.name}-${i}`}
              style={styles.result}
              testID={`search-result-${i}`}
              onPress={() => {
                setQuery('');
                setResults([]);
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
  wrap: { position: 'absolute', left: 12, right: 68 },
  input: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    elevation: 4,
  },
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
