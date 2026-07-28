import { useRecentSearches } from '@atlas/app-hooks';
import {
  coordinateSearchResult,
  parseCoordinateQuery,
  savedPlaceResults,
  type LatLng,
  type SearchablePlace,
  type SearchResult,
} from '@atlas/core';
import { useEffect, useMemo, useRef, useState } from 'react';

interface SearchBoxProps {
  /** Called when the user picks a result. */
  onSelect: (result: SearchResult) => void;
  /** Current map center, used to bias results towards the viewport. */
  getBias: () => LatLng | null;
  /** The user's saved places, matched locally and offered above geocoder hits. */
  places: SearchablePlace[];
}

/**
 * Recents are kept in `localStorage`, not in the OPFS database: they are a
 * convenience, and the database is single-tab (a second window has none), so
 * losing them there would be a worse trade than the one the platform seam
 * exists to allow. Android's half of the seam is a `local.` setting.
 */
const RECENT_KEY = 'atlas.search.recent';

export function SearchBox({ onSelect, getBias, places }: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const {
    recent,
    remember,
    clear: clearRecentList,
  } = useRecentSearches(
    useMemo(
      () => ({
        load: () => localStorage.getItem(RECENT_KEY),
        save: (raw: string) => localStorage.setItem(RECENT_KEY, raw),
      }),
      [],
    ),
  );
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Picking a result writes its name into the input; that change must not
  // re-trigger a search (which would pop the dropdown right back open).
  const pickedRef = useRef<string | null>(null);
  // Read when a search runs, not depended on: `places` is a fresh array every
  // render, and depending on it would restart the debounce forever.
  const placesRef = useRef(places);
  placesRef.current = places;

  // An empty (or too-short) query shows the recent picks instead of results.
  const showingRecent = query.trim().length < 2;
  const shown = showingRecent ? recent : results;

  useEffect(() => {
    abortRef.current?.abort();
    const q = query.trim();
    if (q === pickedRef.current) return;
    pickedRef.current = null;
    if (q.length < 2) {
      setResults([]);
      setHighlighted(0);
      return;
    }
    // A typed-in coordinate pair is its own result — no geocoder round-trip.
    const coord = parseCoordinateQuery(q);
    if (coord) {
      setResults([coordinateSearchResult(coord)]);
      setHighlighted(0);
      setOpen(true);
      return;
    }
    // The user's own places answer instantly and without a network round-trip:
    // show them before the debounce, and keep them on top once Photon replies.
    const saved = savedPlaceResults(placesRef.current, q);
    if (saved.length > 0) {
      setResults(saved);
      setHighlighted(0);
      setOpen(true);
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q });
        const bias = getBias();
        if (bias) {
          params.set('lat', String(bias.lat));
          params.set('lon', String(bias.lng));
        }
        const res = await fetch(`/api/search?${params}`, { signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { results: SearchResult[] };
        setResults([...saved, ...data.results]);
        setHighlighted(0);
        setOpen(true);
      } catch {
        // Aborted or offline; the saved matches shown above still stand.
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, getBias]);

  const pick = (result: SearchResult) => {
    remember(result);
    pickedRef.current = result.name;
    setQuery(result.name);
    setOpen(false);
    onSelect(result);
  };

  // Recents are a convenience, not a record — the user can wipe them, and
  // nothing else in the app depends on them being there.
  const clearRecent = () => {
    clearRecentList();
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || shown.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const result = shown[highlighted];
      if (result) pick(result);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="searchbox">
      <input
        type="search"
        placeholder="Search places or coordinates…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => shown.length > 0 && setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label="Search places"
      />
      {open && shown.length > 0 && (
        <ul className="searchbox-results" role="listbox">
          {showingRecent && (
            <li className="searchbox-tag">
              <span>Recent</span>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault(); // keep input focus
                  clearRecent();
                }}
              >
                Clear
              </button>
            </li>
          )}
          {shown.map((result, i) => (
            <li
              key={`${result.position.lat}/${result.position.lng}/${result.name}`}
              role="option"
              aria-selected={i === highlighted}
              className={i === highlighted ? 'highlighted' : undefined}
              onMouseEnter={() => setHighlighted(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep input focus
                pick(result);
              }}
            >
              <span className="result-name">{result.name}</span>
              {result.label && <span className="result-label">{result.label}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
