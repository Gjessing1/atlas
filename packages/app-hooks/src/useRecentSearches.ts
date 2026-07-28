/**
 * The search box's recent picks, shared by web and Android.
 *
 * The list itself is a pure model in `@atlas/core`; what differs between the
 * clients is only *where* it is kept — an Android `local.` setting (async, via
 * AtlasStorage) or web `localStorage` (sync). So persistence is a two-function
 * seam and everything else — the cap, the dedupe, the clear — is one code path.
 */

import {
  parseRecentSearches,
  pushRecentSearch,
  serializeRecentSearches,
  type SearchResult,
} from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Where the list is kept. Both calls may fail silently — recents are a
 *  convenience, and a full or unavailable store must never break a search. */
export interface RecentSearchStore {
  /** Read the persisted list; null when nothing is stored yet. */
  load: () => Promise<string | null> | string | null;
  /** Persist the serialized list. */
  save: (raw: string) => void;
}

export interface RecentSearches {
  /** Newest first, capped at `MAX_RECENT_SEARCHES`. */
  recent: SearchResult[];
  /** Promote a just-picked result to the front and persist. */
  remember: (result: SearchResult) => void;
  /** Forget everything — recents are a convenience, not a record. */
  clear: () => void;
}

export function useRecentSearches(store: RecentSearchStore): RecentSearches {
  const [recent, setRecent] = useState<SearchResult[]>([]);
  // Callers build the store inline, so it is a fresh object every render;
  // depending on it would re-read the list forever.
  const storeRef = useRef(store);
  storeRef.current = store;
  const recentRef = useRef(recent);
  recentRef.current = recent;
  // A pick can land before an async load resolves (Android's store is a
  // database read). The list the user just changed is the newer truth.
  const written = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let raw: string | null = null;
      try {
        raw = await storeRef.current.load();
      } catch {
        // Storage unavailable (private mode, a closed database) — no recents.
      }
      if (!cancelled && !written.current) setRecent(parseRecentSearches(raw));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const write = useCallback((next: SearchResult[]) => {
    written.current = true;
    setRecent(next);
    try {
      storeRef.current.save(serializeRecentSearches(next));
    } catch {
      // Storage full or unavailable. The list still holds for this session —
      // a failed convenience must never take the search down with it.
    }
  }, []);

  const remember = useCallback(
    (result: SearchResult) => write(pushRecentSearch(recentRef.current, result)),
    [write],
  );

  const clear = useCallback(() => write([]), [write]);

  return { recent, remember, clear };
}
