import {
  useExplore,
  EXPLORE_EMPTY,
  EXPLORE_REFRESH,
  EXPLORE_TITLE,
  type ExploreArea,
  type ExploreQuery,
} from '@atlas/app-hooks';
import { EXPLORE_CATEGORIES, fmtDistanceM, type SearchResult } from '@atlas/core';

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
  // Web has no offline packs (§7's deliberate difference), so an answer here is
  // always the live index — the tag is rendered from shared state regardless,
  // and starts telling the truth by itself the day web gets packs.
  return { results: body.results, offline: false };
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
  const explore = useExplore({ getArea, fetchNearby: fetchExplore });

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
        {EXPLORE_CATEGORIES.map((item) => (
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
      </div>
      <div className="explore-status">
        {explore.status}
        <button type="button" className="link-button" onClick={explore.refresh}>
          {EXPLORE_REFRESH}
        </button>
      </div>
      {explore.showEmpty ? <p className="explore-empty">{EXPLORE_EMPTY}</p> : null}
      <ul className="explore-results">
        {explore.results.map((result) => (
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
