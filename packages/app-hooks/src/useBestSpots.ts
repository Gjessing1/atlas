/**
 * "Best spots in view" — the shortlist, and the *when* that goes with it
 * (ROADMAP § N5 → E6, designed in docs/FISH-HUNT-ENGINE.md § UX).
 *
 * The derived surface answers **where**. It has nothing to say about tonight,
 * and that is by design: D3 keeps structure and conditions apart, because
 * bottom structure is the same next week and the wind is not. This hook is
 * where the two halves are put back together for the user — "prime structure ·
 * best window 05:10–08:00" is one thought, and it reads as one only if the same
 * code owns both ends of it.
 *
 * Three decisions worth stating, because each rejects an obvious alternative:
 *
 * - **One forecast for the whole shortlist**, taken at the strongest spot. The
 *   eight spots share a viewport ~10 km across, met.no's own grid is ~1 km, and
 *   its terms explicitly ask for no synthetic polling — so eight point requests
 *   would buy noise at the cost of exactly the behaviour we are asked not to
 *   have. The window is a property of the *area*, and is presented as one.
 * - **Today, not the best of 72 hours.** `bestWindows` over the whole horizon
 *   happily reports tomorrow's dawn as *the* window, which is useless to
 *   someone deciding whether to go out now. The rows are cut to today first,
 *   and if nothing today clears the bar the honest answer is that nothing does.
 * - **The list never fetches on its own.** It is asked for when it is opened and
 *   when the map settles somewhere new — panning with it open must not become a
 *   load generator against the derive service or the router.
 */

import {
  assessConditions,
  bestWindows,
  buildPlanner,
  type ActivityRating,
  type WeatherForecast,
} from '@atlas/conditions';
import type { LngLatBbox } from '@atlas/core';
import {
  CELL_ZOOM,
  fishSpecies,
  potentialSpotsUrl,
  SPOT_LIMIT,
  type PotentialSpot,
  type PotentialSpotsResponse,
  type SurfaceVocabulary,
} from '@atlas/potential';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PotentialTargetSelection, PotentialView } from './usePotential.js';
import type { PlanningArea } from './usePlanningAreas.js';

/** The stretch of today worth planning around, at the top spot's coordinates. */
export interface SpotsWindow {
  readonly startMs: number;
  readonly endMs: number;
  /** The best hour inside it — what a countdown would count to. */
  readonly peakMs: number;
  /** 0..100, the conditions engine's own weighted score at the peak. */
  readonly score: number;
  readonly rating: ActivityRating;
  /** The peak hour's one-line takeaway, naming driver and limiter. */
  readonly summary: string;
  /** Meteorological direction the wind comes from at the peak hour. */
  readonly windFromDeg: number | null;
}

export type StandWindRisk = 'good' | 'crosswind' | 'blown' | null;

/**
 * Does the forecast carry the caller's scent from the stand toward the paired
 * habitat? A 60° cone is deliberately broad: forecast direction and forest
 * wind are not precise enough to bless a marginal angle.
 */
export function standWindRisk(
  spot: Pick<PotentialSpot, 'stand'>,
  window: Pick<SpotsWindow, 'windFromDeg'> | null,
): StandWindRisk {
  if (!spot.stand || window?.windFromDeg === null || window?.windFromDeg === undefined) return null;
  const windTo = (window.windFromDeg + 180) % 360;
  const delta = Math.abs(((windTo - spot.stand.aim.bearing + 540) % 360) - 180);
  if (delta <= 60) return 'blown';
  if (delta >= 120) return 'good';
  return 'crosswind';
}

export type BestSpotsStatus = 'off' | 'loading' | 'ready' | 'empty' | 'error';

export interface BestSpotsState {
  readonly status: BestSpotsStatus;
  readonly mode: 'habitat' | 'stands';
  readonly spots: readonly PotentialSpot[];
  /** Today's window at the top spot, or null when today has none. */
  readonly window: SpotsWindow | null;
  /**
   * Why there is no window, when there is none. Separate from `note` because a
   * flat forecast says nothing about whether the *water* is any good.
   */
  readonly windowNote: string | null;
  /** Why the list is empty or short — the surface's own words. */
  readonly note: string | null;
  /** Cells under this view that are still being derived. */
  readonly pending: number;
  /** Whether walk-in times could be asked for at all. */
  readonly accessAvailable: boolean;
  /** Ask again for the current view (the list's own refresh button). */
  readonly refresh: () => void;
}

const IDLE: BestSpotsState = {
  status: 'off',
  mode: 'habitat',
  spots: [],
  window: null,
  windowNote: null,
  note: null,
  pending: 0,
  accessAvailable: false,
  refresh: () => {},
};

/** How long after the map settles before the shortlist is asked for again. */
const DEBOUNCE_MS = 600;

/** Local midnight after `now` — the edge of "today" the window is cut to. */
function endOfDay(now: Date): number {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

/**
 * Today's best window at a point, or null.
 *
 * Exported and pure so the rule ("today, and only if it clears the bar") is
 * testable without a forecast fetch or a rendered hook.
 */
export function windowForToday(
  forecast: WeatherForecast,
  opts: { vocabulary: SurfaceVocabulary; species?: string | null; now?: Date },
): SpotsWindow | null {
  const now = opts.now ?? new Date();
  const kind = opts.vocabulary === 'hunt' ? 'hunting' : 'fishing';
  const rows = buildPlanner(forecast, { kind, species: opts.species ?? null, now }).filter(
    (row) => row.timeMs <= endOfDay(now),
  );
  const window = bestWindows(rows, { count: 1 })[0];
  if (!window) return null;
  const peak = rows[window.peakIdx]!;
  const start = rows[window.startIdx]!;
  const end = rows[window.endIdx]!;
  const assessment =
    peak.assessment ??
    assessConditions(kind, {
      point: peak.point,
      sunAltitudeDeg: peak.sunAltitudeDeg,
      pressureTrendHpa: peak.pressureTrendHpa,
      species: opts.species ?? null,
    });
  return {
    startMs: start.timeMs,
    // A planner row describes the hour *after* its timestamp, so the window
    // ends an hour after its last row rather than at it.
    endMs: end.timeMs + 3600_000,
    peakMs: peak.timeMs,
    score: Math.round(assessment.score),
    rating: assessment.rating,
    summary: assessment.summary,
    windFromDeg: peak.point.windFromDir ?? null,
  };
}

/** The bbox as a key, so a pan of a few metres is not a new request. */
function viewKey(bbox: LngLatBbox | undefined): string {
  return bbox ? bbox.map((n) => n.toFixed(4)).join(',') : '';
}

function intersects(a: LngLatBbox, b: LngLatBbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function inRing(
  position: { lat: number; lng: number },
  ring: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (
      yi > position.lat !== yj > position.lat &&
      position.lng < ((xj - xi) * (position.lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Exterior ring contains the point and no hole removes it. */
function inArea(position: { lat: number; lng: number }, area: PlanningArea): boolean {
  return area.polygons.some((polygon) => {
    const exterior = polygon[0];
    return Boolean(
      exterior &&
      inRing(position, exterior) &&
      !polygon.slice(1).some((hole) => inRing(position, hole)),
    );
  });
}

export function useBestSpots(
  origin: string,
  selection: PotentialTargetSelection | null,
  view: PotentialView | null,
  opts: {
    /** The list is open. Closed, this hook does nothing at all. */
    readonly enabled: boolean;
    /** `usePotential`'s digest: a cell landing is a reason to ask again. */
    readonly readyKey?: string;
    readonly vocabulary?: SurfaceVocabulary;
    readonly limit?: number;
    /** Visible saved permit areas; hunting stands and their aim are clipped to them. */
    readonly areas?: readonly PlanningArea[];
  },
): BestSpotsState {
  const [response, setResponse] = useState<PotentialSpotsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [nonce, setNonce] = useState(0);

  const layer = selection?.layer ?? null;
  const target = selection?.target ?? '';
  const vocabulary = opts.vocabulary ?? 'fishing';
  const limit = opts.limit ?? SPOT_LIMIT;
  const bbox = view?.bbox;
  const zoom = view?.zoom ?? 0;
  const active = opts.enabled && layer !== null && bbox !== undefined && zoom >= CELL_ZOOM;
  const relevantAreas = bbox
    ? (opts.areas ?? []).filter((area) => intersects(area.bbox, bbox))
    : [];
  const areasKey = relevantAreas.map((area) => `${area.id}:${area.bbox.join(',')}`).join('|');
  // Everything the request is made of, so the effect below can depend on the
  // *request* rather than on a bbox array that is new on every render.
  const key = active
    ? `${layer}/${target}/${limit}/${viewKey(bbox)}/${areasKey}/${opts.readyKey ?? ''}/${nonce}`
    : '';

  // A new area, target or nonce starts a fresh answer: the counts and the
  // numbering belong to the request that produced them.
  useEffect(() => {
    if (!active) {
      setResponse(null);
      setFailed(false);
    }
  }, [active]);

  useEffect(() => {
    if (!active || !bbox) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(potentialSpotsUrl(origin, layer!, target, bbox, limit));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const received = (await res.json()) as PotentialSpotsResponse;
          if (cancelled) return;
          if (received.mode === 'stands' && relevantAreas.length > 0) {
            const clipped = received.spots.filter(
              (spot) =>
                spot.stand &&
                relevantAreas.some(
                  (area) => inArea(spot.position, area) && inArea(spot.stand!.aim.position, area),
                ),
            );
            const names = relevantAreas.map((area) => area.name).join(', ');
            setResponse({
              ...received,
              spots: clipped,
              note:
                clipped.length > 0
                  ? `Clipped to saved area: ${names}. ${received.note ?? ''}`.trim()
                  : `No paired stand falls fully inside the visible saved area: ${names}.`,
            });
          } else {
            setResponse(received);
          }
          setFailed(false);
        } catch {
          if (!cancelled) setFailed(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setLoading(false);
    };
  }, [origin, key]);

  // One forecast for the shortlist, at its strongest spot — see the file note.
  const top = response?.spots[0]?.position;
  const forecastLat = top ? Number(top.lat.toFixed(2)) : null;
  const forecastLng = top ? Number(top.lng.toFixed(2)) : null;
  useEffect(() => {
    if (forecastLat === null || forecastLng === null) {
      setForecast(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${origin}/api/weather?lat=${forecastLat.toFixed(4)}&lon=${forecastLng.toFixed(4)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as WeatherForecast;
        if (!cancelled) setForecast(body);
      } catch {
        // A missing forecast costs the window, never the spots.
        if (!cancelled) setForecast(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, forecastLat, forecastLng]);

  const window = useMemo(() => {
    if (!forecast) return null;
    return windowForToday(forecast, {
      vocabulary,
      species: fishSpecies(target)?.conditionsSpecies ?? null,
    });
  }, [forecast, vocabulary, target]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return useMemo((): BestSpotsState => {
    if (!active) return { ...IDLE, refresh };
    const base = {
      mode: response?.mode ?? (vocabulary === 'hunt' ? 'stands' : 'habitat'),
      spots: response?.spots ?? [],
      window,
      windowNote:
        forecast && !window
          ? vocabulary === 'hunt'
            ? 'No standout window left today.'
            : 'No standout bite window left today.'
          : null,
      note: response?.note ?? null,
      pending: response?.pending ?? 0,
      accessAvailable: response?.accessAvailable ?? false,
      refresh,
    };
    if (failed && !response) return { ...base, status: 'error', note: 'Could not read this area.' };
    if (!response || (loading && response.spots.length === 0)) {
      return { ...base, status: 'loading' };
    }
    // An empty shortlist is a finding, not a failure — the note says which one.
    return { ...base, status: base.spots.length === 0 ? 'empty' : 'ready' };
  }, [active, response, window, forecast, failed, loading, vocabulary, refresh]);
}

/**
 * The number the list shows for a spot's walk in, or null when there is none.
 * Shared so both clients round and hedge the same way.
 */
export function spotWalkLabel(spot: PotentialSpot): string | null {
  if (!spot.access) return null;
  const minutes = Math.max(1, Math.round(spot.access.durationS / 60));
  const time =
    minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  // The tilde is not decoration: it marks a walk the router could not actually
  // follow, computed straight-line over ground that may be a bog.
  return `${spot.access.approximate ? '≈' : ''}${time} from the road`;
}

/** Local `HH:MM–HH:MM` for a window, on both platforms' clock rules. */
export function spotWindowLabel(window: SpotsWindow, fmt: (ms: number) => string): string {
  return `${fmt(window.startMs)}–${fmt(window.endMs)}`;
}
