import { fmtDistanceM, type PoiResult } from '@atlas/core';
import { useState } from 'react';

export function PoiViewportPanel({
  results,
  loading,
  error,
  tooWide,
  onPick,
  onRefresh,
}: {
  results: readonly PoiResult[];
  loading: boolean;
  error: boolean;
  tooWide: boolean;
  onPick: (result: PoiResult) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(true);
  const status = tooWide
    ? 'Zoom in to load places'
    : loading
      ? 'Loading places in view…'
      : error
        ? 'Places are unavailable'
        : `${results.length} ${results.length === 1 ? 'place' : 'places'} in view`;
  return (
    <aside className={`poi-results-panel${open ? ' open' : ''}`} aria-label="POIs in map view">
      <button
        type="button"
        className="poi-results-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>
          <strong>Places in view</strong>
          <small>{status}</small>
        </span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <>
          {error ? (
            <button type="button" className="link-button poi-results-refresh" onClick={onRefresh}>
              Try again
            </button>
          ) : null}
          {!loading && !error && !tooWide && results.length === 0 ? (
            <p>No places in these categories are mapped in this view.</p>
          ) : null}
          <ol className="poi-results-list">
            {results.map((result, index) => (
              <li key={result.id}>
                <button type="button" onClick={() => onPick(result)}>
                  <span className="poi-result-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="poi-result-copy">
                    <strong>{result.name}</strong>
                    <small>{[result.category, result.address].filter(Boolean).join(' · ')}</small>
                  </span>
                  {result.distanceM !== undefined ? (
                    <span className="poi-result-distance">{fmtDistanceM(result.distanceM)}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </aside>
  );
}
