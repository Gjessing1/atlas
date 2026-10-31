import { libraryPlaceName, useRecentSearches, useSearch, type SearchFn } from '@atlas/app-hooks';
import {
  isCollectionSearchResult,
  type LatLng,
  type MainSearchResult,
  type SearchableFolder,
  type SearchablePlace,
  type SearchableTrack,
  type SearchResult,
} from '@atlas/core';
import type { PlaceRecord } from '@atlas/storage';
import { useCallback, useMemo, useState } from 'react';

interface SearchBoxProps {
  /** Called when the user picks a result. */
  onSelect: (result: MainSearchResult) => void;
  /** Current map center, used to bias results towards the viewport. */
  getBias: () => LatLng | null;
  /** The user's saved places, matched locally and offered above geocoder hits. */
  places: SearchablePlace[];
  tracks: SearchableTrack[];
  folders: SearchableFolder[];
  /**
   * The places pinned to Quick access, offered whenever the box is empty. They
   * were only reachable by opening Collections first, so a shortcut was a
   * detour for anyone who starts from the search box.
   */
  quickAccess: readonly PlaceRecord[];
  /** Show a Quick access place, as its tile in Collections does. */
  onPickPlace: (place: PlaceRecord) => void;
}

/** A row the empty-box dropdown can land on: a Quick access place or a recent pick. */
type Entry = { kind: 'quick'; place: PlaceRecord } | { kind: 'result'; result: MainSearchResult };

/**
 * Recents are kept in `localStorage`, not in the OPFS database: they are a
 * convenience, and the database is single-tab (a second window has none), so
 * losing them there would be a worse trade than the one the platform seam
 * exists to allow. Android's half of the seam is a `local.` setting.
 */
const RECENT_KEY = 'atlas.search.recent';

export function SearchBox({
  onSelect,
  getBias,
  places,
  tracks,
  folders,
  quickAccess,
  onPickPlace,
}: SearchBoxProps) {
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
  const search = useSearch({ search: fetchSearch, places, tracks, folders });
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
  const quick: Entry[] = showingRecent
    ? quickAccess.map((place) => ({ kind: 'quick', place }))
    : [];
  const results: Entry[] = (showingRecent ? recent : search.results).map((result) => ({
    kind: 'result',
    result,
  }));
  const shown = [...quick, ...results];

  const pick = (entry: Entry) => {
    setOpen(false);
    if (entry.kind === 'quick') {
      search.settle(libraryPlaceName(entry.place));
      onPickPlace(entry.place);
      return;
    }
    const { result } = entry;
    if (!isCollectionSearchResult(result)) remember(result);
    search.settle(result.name);
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
      const entry = shown[highlighted];
      if (entry) pick(entry);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const renderEntry = (entry: Entry, i: number) => {
    const quickPlace = entry.kind === 'quick' ? entry.place : null;
    let key: string;
    let name: string;
    let label: string;
    if (entry.kind === 'quick') {
      key = `quick/${entry.place.id}`;
      name = libraryPlaceName(entry.place);
      label = entry.place.address || 'Saved place';
    } else {
      const { result } = entry;
      key = isCollectionSearchResult(result)
        ? `${result.collectionTarget.kind}/${result.collectionTarget.id}`
        : `${result.position.lat}/${result.position.lng}/${result.name}`;
      name = result.name;
      label = result.label;
    }
    return (
      <li
        key={key}
        role="option"
        aria-selected={i === highlighted}
        className={`${quickPlace ? 'searchbox-quick' : ''}${i === highlighted ? ' highlighted' : ''}`}
        onMouseEnter={() => setHighlighted(i)}
        onMouseDown={(e) => {
          e.preventDefault(); // keep input focus
          pick(entry);
        }}
      >
        {quickPlace && (
          <span
            className="searchbox-quick-icon"
            style={{ background: quickPlace.color }}
            aria-hidden="true"
          >
            {quickPlace.icon}
          </span>
        )}
        <span className="result-text">
          <span className="result-name">{name}</span>
          {label && <span className="result-label">{label}</span>}
        </span>
      </li>
    );
  };

  return (
    <div className="searchbox">
      <input
        type="search"
        placeholder="Search places, tracks, folders or coordinates…"
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
          {quick.length > 0 && (
            <li className="searchbox-tag" role="presentation">
              <span>Quick access</span>
            </li>
          )}
          {shown.slice(0, quick.length).map((entry, i) => renderEntry(entry, i))}
          {showingRecent && recent.length > 0 && (
            <li className="searchbox-tag" role="presentation">
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
          {shown.slice(quick.length).map((entry, i) => renderEntry(entry, quick.length + i))}
        </ul>
      )}
    </div>
  );
}
