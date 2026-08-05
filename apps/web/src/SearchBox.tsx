import { useRecentSearches, useSearch, type SearchFn } from '@atlas/app-hooks';
import { type LatLng, type SearchablePlace, type SearchResult } from '@atlas/core';
import { useCallback, useMemo, useState } from 'react';

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
  const fetchSearch = useCallback<SearchFn>(
    async ({ text, signal }) => {
      const params = new URLSearchParams({ q: text });
      const bias = getBias();
      if (bias) {
        params.set('lat', String(bias.lat));
        params.set('lon', String(bias.lng));
      }
      const response = await fetch(`/api/search?${params}`, { signal });
      if (!response.ok) throw new Error(`search: HTTP ${response.status}`);
      return {
        results: ((await response.json()) as { results: SearchResult[] }).results,
        offline: false,
      };
    },
    [getBias],
  );
  const search = useSearch({ search: fetchSearch, places });
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

  // An empty (or too-short) query shows the recent picks instead of results.
  const showingRecent = search.query.trim().length < 2;
  const shown = showingRecent ? recent : search.results;

  const pick = (result: SearchResult) => {
    remember(result);
    search.settle(result.name);
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
        value={search.query}
        onChange={(e) => {
          search.setQuery(e.target.value);
          setHighlighted(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => (shown.length > 0 || search.statusText !== null) && setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label="Search places"
      />
      {open && (shown.length > 0 || search.statusText !== null) && (
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
          {!showingRecent && search.statusText && (
            <li className="searchbox-tag searchbox-status" role="presentation">
              {search.statusText}
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
