import {
  EXPLORE_CATEGORIES,
  fmtDistanceM,
  type ExploreCategoryId,
  type LatLng,
  type SearchResult,
} from '@atlas/core';
import { useCallback, useEffect, useState } from 'react';

export interface ExploreArea {
  center: LatLng;
  radiusM: number;
}

/** Category-first POI browse for the current map view. */
export function ExplorePanel({
  getArea,
  onPick,
  onClose,
}: {
  getArea: () => ExploreArea;
  onPick: (result: SearchResult) => void;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<ExploreCategoryId>('food');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(async () => {
    const area = getArea();
    const params = new URLSearchParams({
      category,
      lat: String(area.center.lat),
      lon: String(area.center.lng),
      radius: String(area.radiusM),
    });
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(`/api/explore?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setResults(((await response.json()) as { results: SearchResult[] }).results);
    } catch {
      setResults([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [category, getArea]);

  useEffect(() => {
    void load();
  }, [load, refresh]);

  return (
    <aside className="explore-panel" aria-label="Explore nearby places">
      <div className="explore-head">
        <div>
          <strong>Explore this area</strong>
          <span>Top places in the current map view</span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close explore">
          ✕
        </button>
      </div>
      <div className="explore-categories" role="tablist" aria-label="Place category">
        {EXPLORE_CATEGORIES.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={category === item.id}
            className={category === item.id ? 'selected' : undefined}
            onClick={() => setCategory(item.id)}
            key={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="explore-status">
        {loading
          ? 'Looking nearby…'
          : error
            ? 'Explore is unavailable.'
            : `${results.length} places`}
        <button
          type="button"
          className="link-button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh map view
        </button>
      </div>
      {!loading && !error && results.length === 0 ? (
        <p className="explore-empty">No places in this category are indexed here.</p>
      ) : null}
      <ul className="explore-results">
        {results.map((result) => (
          <li key={`${result.name}/${result.position.lat}/${result.position.lng}`}>
            <button type="button" onClick={() => onPick(result)}>
              <span>
                <strong>{result.name}</strong>
                {result.label ? <small>{result.label}</small> : null}
              </span>
              {result.distanceM !== undefined ? (
                <span className="explore-distance">{fmtDistanceM(result.distanceM)}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
