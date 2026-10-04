import {
  useExplore,
  useExploreShortcuts,
  EXPLORE_EMPTY,
  EXPLORE_REFRESH,
  EXPLORE_TITLE,
  type ExploreArea,
  type ExploreQuery,
  type ExploreShortcutSettings,
} from '@atlas/app-hooks';
import { EXPLORE_CATEGORIES, fmtDistanceM, type SearchResult } from '@atlas/core';
import { useEffect, useState } from 'react';

export type { ExploreArea };

/** The web half of the seam: the backend's Photon-backed browse endpoint. */
async function fetchExplore({ category, center, radiusM, signal }: ExploreQuery) {
  const params = new URLSearchParams({
    category,
    lat: String(center.lat),
    lon: String(center.lng),
    radius: String(radiusM),
  });
  const response = await fetch(`/api/explore?${params}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { results: SearchResult[] };
  // Web has no offline packs (a deliberate difference), so an answer here is
  // always the live index — the tag is rendered from shared state regardless,
  // and starts telling the truth by itself the day web gets packs.
  return { results: body.results, offline: false };
}

/** Category-first POI browse for the current map view. */
export function ExplorePanel({
  getArea,
  currentArea,
  profileId,
  settings,
  onPick,
  onResultsChange,
  onClose,
}: {
  getArea: () => ExploreArea;
  currentArea: ExploreArea | null;
  profileId: string;
  settings: ExploreShortcutSettings;
  onPick: (result: SearchResult) => void;
  onResultsChange: (results: SearchResult[]) => void;
  onClose: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { shortcuts, categories, editable, setPinned, reset } = useExploreShortcuts(
    settings,
    profileId,
  );
  const explore = useExplore({
    getArea,
    currentArea,
    fetchNearby: fetchExplore,
    initialCategory: categories[0]!.id,
  });
  useEffect(() => onResultsChange(explore.results), [explore.results, onResultsChange]);

  return (
    <aside className="explore-panel" aria-label="Explore nearby places">
      <div className="explore-head">
        <div>
          <strong>{EXPLORE_TITLE}</strong>
          <span>{explore.subtitle}</span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close explore">
          ✕
        </button>
      </div>
      <div className="explore-categories" role="tablist" aria-label="Place category">
        {categories.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={explore.category === item.id}
            className={explore.category === item.id ? 'selected' : undefined}
            onClick={() => explore.setCategory(item.id)}
            key={item.id}
          >
            {item.label}
          </button>
        ))}
        <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
          More…
        </button>
      </div>
      {moreOpen ? (
        <div className="explore-more" aria-label="Choose Explore shortcuts">
          <div className="explore-more-head">
            <strong>All categories</strong>
            <button type="button" className="link-button" onClick={reset} disabled={!editable}>
              Reset shortcuts
            </button>
          </div>
          {EXPLORE_CATEGORIES.map((item) => (
            <div className="explore-more-row" key={item.id}>
              <button
                type="button"
                onClick={() => explore.setCategory(item.id)}
                aria-current={explore.category === item.id ? 'true' : undefined}
              >
                {item.label}
              </button>
              <button
                type="button"
                onClick={() => setPinned(item.id, !shortcuts.includes(item.id))}
                disabled={!editable}
                aria-pressed={shortcuts.includes(item.id)}
                aria-label={`${shortcuts.includes(item.id) ? 'Remove' : 'Add'} ${item.label} ${shortcuts.includes(item.id) ? 'from' : 'to'} shortcuts`}
              >
                {shortcuts.includes(item.id) ? '★' : '☆'}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className={`explore-status${explore.stale ? ' stale' : ''}`}>
        {explore.status}
        <button type="button" className="link-button" onClick={explore.refresh}>
          {EXPLORE_REFRESH}
        </button>
      </div>
      {explore.showEmpty ? <p className="explore-empty">{EXPLORE_EMPTY}</p> : null}
      <ul className="explore-results">
        {explore.results.map((result, index) => (
          <li key={`${result.name}/${result.position.lat}/${result.position.lng}`}>
            <button type="button" onClick={() => onPick(result)}>
              <span className="explore-result-index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="explore-result-text">
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
