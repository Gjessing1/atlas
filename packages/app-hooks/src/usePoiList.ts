import { haversineM, type LatLng, type PoiCategoryId, type PoiResult } from '@atlas/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { exploreAreaIsStale, type ExploreArea } from './useExplore.js';
import type { PoiViewport } from './usePoiViewport.js';

/** The pins already follow the map; this action replaces only the frozen list. */
export const POI_LIST_REFRESH = 'Refresh list view';

function areaOf(viewport: PoiViewport | null): ExploreArea | null {
  if (!viewport) return null;
  const center = {
    lat: (viewport.bbox[1] + viewport.bbox[3]) / 2,
    lng: (viewport.bbox[0] + viewport.bbox[2]) / 2,
  };
  return { center, radiusM: haversineM(center, { lat: viewport.bbox[3], lng: viewport.bbox[2] }) };
}

export interface PoiListState {
  results: PoiResult[];
  stale: boolean;
  refresh: () => void;
  /** The list is about to be read: pulled above peek, or its panel expanded. */
  open: () => void;
  scrollOffset: number;
  setScrollOffset: (offset: number) => void;
}

/**
 * The readable POI list: a snapshot, while the map pins underneath it stay live.
 *
 * The freeze exists so rows do not reorder under a reading finger, so it lasts
 * exactly as long as there is something to read. Until the list is first opened —
 * and for as long as it is empty — it simply follows the live view, which is what
 * keeps a selector switched on over a whole country from insisting there are no
 * places once the user zooms into a town. From the first open it is frozen: a category choice or the explicit
 * refresh replaces it, the map moving only offers to, and opening it again at a
 * view that has meaningfully moved takes the new snapshot the user just asked
 * for. It outlives its own sheet unmounting, so a place card opened from a row
 * comes back to the same rows and the same scroll position.
 */
export function usePoiList({
  active,
  viewport,
  categories,
  liveResults,
  loading,
  liveRevision,
  origin,
  refreshLive,
}: {
  active: boolean;
  viewport: PoiViewport | null;
  categories: readonly PoiCategoryId[];
  liveResults: readonly PoiResult[];
  loading: boolean;
  liveRevision: number;
  origin: LatLng | null;
  refreshLive: () => void;
}): PoiListState {
  const [snapshot, setSnapshot] = useState<PoiResult[]>([]);
  const [snapshotArea, setSnapshotArea] = useState<ExploreArea | null>(null);
  const [opened, setOpened] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const categoryKey = categories.join(',');
  const previousCategory = useRef(categoryKey);
  const awaitingRevision = useRef<number | null>(null);
  const followedRevision = useRef<number | null>(null);
  // Read inside the sort so a moved position never re-sorts an open list.
  const originRef = useRef(origin);
  originRef.current = origin;
  const currentArea = areaOf(viewport);

  // Sorted once, from where the user stood when the snapshot was taken. Later
  // fixes update the numbers below without reshuffling rows under a reading
  // finger; the incoming order is the live view's own, nearest its centre, which
  // is what a list with no fix keeps.
  const byOrigin = useCallback((rows: readonly PoiResult[]) => {
    const at = originRef.current;
    if (!at) return [...rows];
    return [...rows].sort((a, b) => haversineM(at, a.position) - haversineM(at, b.position));
  }, []);

  const capture = useCallback(() => {
    setSnapshot(byOrigin(liveResults));
    setSnapshotArea(areaOf(viewport));
    setScrollOffset(0);
  }, [byOrigin, liveResults, viewport]);

  useEffect(() => {
    if (!active) return;
    if (previousCategory.current === categoryKey) return;
    previousCategory.current = categoryKey;
    // A category choice is itself an explicit refresh. Filter immediately so
    // an old category never remains labelled as the new one, then replace the
    // snapshot seamlessly when its live answer settles.
    const selected = new Set(categories);
    setSnapshot(
      categories.length ? byOrigin(liveResults.filter((r) => selected.has(r.categoryId))) : [],
    );
    setSnapshotArea(currentArea);
    setScrollOffset(0);
    awaitingRevision.current = liveRevision;
    setAwaiting(true);
  }, [active, byOrigin, categories, categoryKey, currentArea, liveResults]);

  useEffect(() => {
    if (!active || !awaiting || loading || liveRevision === awaitingRevision.current) return;
    capture();
    awaitingRevision.current = null;
    setAwaiting(false);
  }, [active, awaiting, capture, liveRevision, loading]);

  // Not being read yet — or read but empty, which has nothing to keep still:
  // follow the live view, once per settled live answer. Without the empty case a
  // panel that came up over a zoomed-out view sits beside a map full of pins
  // insisting there is nothing here. The revision guard is what stops this
  // re-capturing on every render, since `capture` closes over results that
  // change with the map.
  useEffect(() => {
    if (!active || loading || !currentArea) return;
    if (opened && snapshot.length > 0) return;
    if (followedRevision.current === liveRevision && snapshotArea) return;
    followedRevision.current = liveRevision;
    capture();
  }, [active, capture, currentArea, liveRevision, loading, opened, snapshot.length, snapshotArea]);

  const stale = Boolean(
    snapshotArea && currentArea && exploreAreaIsStale(snapshotArea, currentArea),
  );
  const staleRef = useRef(stale);
  staleRef.current = stale;

  const open = useCallback(() => {
    setOpened(true);
    if (!snapshotArea || staleRef.current) capture();
  }, [capture, snapshotArea]);

  const refresh = useCallback(() => {
    awaitingRevision.current = liveRevision;
    setAwaiting(true);
    refreshLive();
  }, [liveRevision, refreshLive]);

  const results = useMemo(
    () =>
      snapshot.map((result) => ({
        ...result,
        ...(origin ? { distanceM: haversineM(origin, result.position) } : { distanceM: undefined }),
      })),
    [snapshot, origin],
  );

  return { results, stale, refresh, open, scrollOffset, setScrollOffset };
}
