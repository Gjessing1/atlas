import { EXPLORE_REFRESH, type PoiListState } from '@atlas/app-hooks';
import {
  fmtDistanceM,
  parseOpeningHours,
  poiCategory,
  type PoiCategoryId,
  type PoiResult,
} from '@atlas/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useBottomSheet } from '../BottomSheet.js';
import { PoiCategoryDock } from './PoiCategoryDock.js';

export function PoiViewportPanel({
  list,
  loading,
  error,
  tooWide,
  categories,
  onToggleCategory,
  onShowAll,
  onPick,
}: {
  list: PoiListState;
  loading: boolean;
  error: boolean;
  tooWide: boolean;
  categories: readonly PoiCategoryId[];
  onToggleCategory: (id: PoiCategoryId) => void;
  onShowAll: () => void;
  onPick: (result: PoiResult) => void;
}) {
  const [desktopOpen, setDesktopOpen] = useState(true);
  const sheet = useBottomSheet({ initial: 'peek' });
  const scrollRef = useRef<HTMLOListElement>(null);
  // Both callbacks are read through refs on purpose: they are new functions on
  // every render, and depending on their identity would recapture the snapshot
  // (and rewrite the scroll position) every time the live map moved underneath —
  // the one thing this list exists not to do. Only the snap transition and a new
  // snapshot may run these.
  const openRef = useRef(list.open);
  openRef.current = list.open;
  const offsetRef = useRef(list.scrollOffset);
  offsetRef.current = list.scrollOffset;
  // Being read: pulled above peek on a phone, expanded in the desktop panel.
  // That is what freezes the rows, so the desktop panel — open from the start —
  // is a snapshot immediately, while a peeked phone sheet still follows the map.
  //
  // `useBottomSheet` only learns which layout this is in its own mount effect, so
  // the first render cannot tell a peeked phone sheet from an expanded desktop
  // panel. Nothing is read before that is known: assuming desktop for one commit
  // froze a phone's list on whatever the map happened to show at startup.
  const [layoutKnown, setLayoutKnown] = useState(false);
  useEffect(() => setLayoutKnown(true), []);
  const reading = layoutKnown && (sheet.active ? sheet.snap !== 'peek' : desktopOpen);
  useEffect(() => {
    if (reading) openRef.current();
  }, [reading]);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = offsetRef.current;
  }, [list.results]);

  const noun = categories.length === 1 ? poiCategory(categories[0]!).label.toLowerCase() : 'places';
  const status = tooWide
    ? 'Zoom in to search a smaller area'
    : loading && list.results.length === 0
      ? 'Finding places…'
      : error && list.results.length === 0
        ? 'Places are unavailable'
        : `${list.results.length} ${list.results.length === 1 ? 'place' : 'places'} in this area`;

  return (
    <aside
      ref={sheet.sheetRef}
      className={`poi-results-panel${reading ? ' open' : ''}${list.stale ? ' stale' : ''}`}
      aria-label="POIs in map view"
    >
      <div className="sheet-grabber poi-results-grabber" {...sheet.grabberProps}>
        <div className="sheet-grabber-pill" />
      </div>
      <PoiCategoryDock
        categories={categories}
        onToggle={onToggleCategory}
        onShowAll={onShowAll}
        className="poi-results-categories"
      />
      <button
        type="button"
        className="poi-results-head"
        onClick={() => {
          if (sheet.active) sheet.setSnap(sheet.snap === 'peek' ? 'half' : 'peek');
          else setDesktopOpen((value) => !value);
        }}
        aria-expanded={reading}
      >
        <span>
          <strong>Places in view</strong>
          <small>{status}</small>
        </span>
        <span aria-hidden="true">{reading ? '▾' : '▸'}</span>
      </button>
      {reading ? (
        <>
          {list.stale ? (
            <button
              type="button"
              className="link-button poi-results-refresh"
              onClick={list.refresh}
            >
              ↻ {EXPLORE_REFRESH}
            </button>
          ) : error ? (
            <button
              type="button"
              className="link-button poi-results-refresh"
              onClick={list.refresh}
            >
              Try again
            </button>
          ) : null}
          {!loading && !error && !tooWide && list.results.length === 0 ? (
            <p>No {noun} in this area. Zoom out for a larger search.</p>
          ) : null}
          <ol
            ref={scrollRef}
            className="poi-results-list"
            onScroll={(event) => list.setScrollOffset(event.currentTarget.scrollTop)}
          >
            {list.results.map((result) => {
              const hours = parseOpeningHours(result.openingHours);
              return (
                <li key={result.id}>
                  <button type="button" onClick={() => onPick(result)}>
                    <span className="poi-result-copy">
                      <strong>{result.name}</strong>
                      <small>
                        {[result.category, hours?.statusText, hours?.nextOpenOrClose]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </span>
                    {result.distanceM !== undefined ? (
                      <span className="poi-result-distance">{fmtDistanceM(result.distanceM)}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </aside>
  );
}
