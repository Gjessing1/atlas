/**
 * The saved-stand board — "which of my stands is on tonight?" (ROADMAP § E12).
 *
 * Every other hunting surface in Atlas answers a question asked once per area.
 * This one answers the question asked once per afternoon, over stands the user
 * already chose, and it needs nothing new to do it: no derive, no router, no new
 * upstream. It is the rose each stand was saved with, the sun, and the forecast.
 *
 * **The forecast budget is stated here rather than inherited.** `useBestSpots`
 * takes one forecast at the strongest spot and applies it to all eight, which is
 * right for a shortlist over a ~10 km viewport — met.no's grid is ~1 km and its
 * terms ask for no synthetic polling. A handful of saved stands is a different
 * surface with a different budget: they can be tens of kilometres apart, they
 * are checked once a day rather than on every pan, and the whole point of the
 * board is to tell them apart. So this fetches **one forecast per stand**, and
 * pays for that honesty with a hard cap (`STAND_BOARD_LIMIT`) and by only ever
 * fetching when the board is open and its stands actually change.
 *
 * The slope each stand sits on comes from the elevation service, in one batched
 * request for the whole board — the fit that revives the thermal factor, which
 * every production caller had been dropping on the floor.
 */

import {
  compareStandCells,
  standWatchDays,
  STAND_BOARD_DAYS,
  STAND_SLOPE_BEARINGS,
  STAND_SLOPE_RADIUS_M,
  type StandDayCell,
  type StandSit,
  type WeatherForecast,
} from '@atlas/conditions';
import {
  destinationPoint,
  slopeFromRing,
  type ElevationProfileResponse,
  type LatLng,
  type PlaceStand,
} from '@atlas/core';
import { quarryByLabel } from '@atlas/potential';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * How many stands the board will read the weather for.
 *
 * Not a display limit — a politeness limit. One request per stand is defensible
 * for the three-to-eight stands a season actually has; it would not be for a
 * hunter who has starred forty candidates over five years, and the board must
 * not turn into a poller the first time someone does. Over the cap, the nearest
 * stands to the map are kept and the rest are named as left out.
 */
export const STAND_BOARD_LIMIT = 12;

/** A saved place that carries a stand plan — the board's input. */
export interface StandBoardPlace {
  readonly id: string;
  readonly name?: string | undefined;
  readonly lat: number;
  readonly lng: number;
  readonly stand?: PlaceStand | null;
}

/** One stand's whole ten-day column, plus the cell the board is showing. */
export interface StandBoardRow {
  readonly placeId: string;
  readonly name: string;
  readonly position: LatLng;
  readonly stand: PlaceStand;
  readonly days: readonly StandDayCell[];
  /** The selected day's cell — what the row is ranked and read by. */
  readonly cell: StandDayCell | null;
  /** Ground fall at the stand, when the terrain fit succeeded. */
  readonly slopeDeg: number | null;
  readonly aspectDeg: number | null;
}

export type StandBoardStatus = 'off' | 'loading' | 'ready' | 'empty';

export interface StandBoardState {
  readonly status: StandBoardStatus;
  /** Ranked by the selected day: scent verdict first, then the score. */
  readonly rows: readonly StandBoardRow[];
  readonly sit: StandSit;
  readonly setSit: (sit: StandSit) => void;
  /** 0 = today, up to `STAND_BOARD_DAYS - 1`. */
  readonly dayOffset: number;
  readonly setDayOffset: (offset: number) => void;
  /** Local midnight of each day the board offers, for the scrubber. */
  readonly dayStamps: readonly number[];
  /** Why the board is short or empty, in its own words. */
  readonly note: string | null;
  readonly refresh: () => void;
}

const IDLE: Omit<StandBoardState, 'sit' | 'setSit' | 'dayOffset' | 'setDayOffset' | 'refresh'> = {
  status: 'off',
  rows: [],
  dayStamps: [],
  note: null,
};

/** The ring of points whose elevations a stand's slope is fitted through. */
function slopeRing(at: LatLng): LatLng[] {
  return STAND_SLOPE_BEARINGS.map((bearing) => destinationPoint(at, bearing, STAND_SLOPE_RADIUS_M));
}

interface TerrainFit {
  readonly slopeDeg: number | null;
  readonly aspectDeg: number | null;
}

export function useStandBoard(
  origin: string,
  places: readonly StandBoardPlace[],
  opts: {
    /** The board is open. Closed, this hook fetches nothing at all. */
    readonly enabled: boolean;
    /** Where the map is, so the cap keeps the stands the user is looking at. */
    readonly near?: LatLng | null;
    readonly now?: Date;
  },
): StandBoardState {
  const [sit, setSit] = useState<StandSit>('evening');
  const [dayOffset, setDayOffset] = useState(0);
  const [forecasts, setForecasts] = useState<Record<string, WeatherForecast>>({});
  const [terrain, setTerrain] = useState<Record<string, TerrainFit>>({});
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const near = opts.near ?? null;
  const nearLat = near?.lat ?? null;
  const nearLng = near?.lng ?? null;

  // The stands the board is about, closest to the map first so the cap drops
  // the ones furthest from what the user is currently looking at.
  const stands = useMemo(() => {
    const withPlan = places.flatMap((place) =>
      place.stand
        ? [
            {
              placeId: place.id,
              name: place.name?.trim() || 'Stand',
              position: { lat: place.lat, lng: place.lng },
              stand: place.stand,
            },
          ]
        : [],
    );
    if (nearLat !== null && nearLng !== null) {
      const distance = (p: LatLng) => (p.lat - nearLat) ** 2 + (p.lng - nearLng) ** 2;
      withPlan.sort((a, b) => distance(a.position) - distance(b.position));
    }
    return withPlan;
  }, [places, nearLat, nearLng]);

  const shown = useMemo(() => stands.slice(0, STAND_BOARD_LIMIT), [stands]);
  const dropped = stands.length - shown.length;

  // The *request*, as a string: the effect below must not re-run because a new
  // array arrived carrying the same stands.
  const key = shown
    .map((row) => `${row.placeId}:${row.position.lat.toFixed(3)},${row.position.lng.toFixed(3)}`)
    .join('|');
  // Read through a ref so the fetch can use the objects without depending on
  // their identity — the render/request loop this avoids has bitten before.
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const active = opts.enabled && shown.length > 0;

  useEffect(() => {
    if (!active) return;
    const rows = shownRef.current;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const collected: Record<string, WeatherForecast> = {};
      await Promise.all(
        rows.map(async (row) => {
          try {
            const res = await fetch(
              `${origin}/api/weather?lat=${row.position.lat.toFixed(4)}&lon=${row.position.lng.toFixed(4)}`,
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            collected[row.placeId] = (await res.json()) as WeatherForecast;
          } catch {
            // A stand whose forecast failed keeps its window and its rose; the
            // cell says the weather is missing rather than the board failing.
          }
        }),
      );
      if (!cancelled) {
        setForecasts(collected);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setLoading(false);
    };
  }, [origin, key, active, nonce]);

  // One batched elevation request for every stand's ring. Terrain does not
  // change, so this is asked once per set of stands and never on a day change.
  useEffect(() => {
    if (!active) return;
    const rows = shownRef.current;
    let cancelled = false;
    void (async () => {
      const points = rows.flatMap((row) => slopeRing(row.position));
      try {
        const res = await fetch(`${origin}/api/elevation/profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ points }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ElevationProfileResponse;
        if (cancelled) return;
        const fitted: Record<string, TerrainFit> = {};
        rows.forEach((row, index) => {
          const ring = STAND_SLOPE_BEARINGS.map((bearingDeg, spoke) => ({
            bearingDeg,
            elevationM:
              body.samples[index * STAND_SLOPE_BEARINGS.length + spoke]?.elevationM ?? null,
          }));
          const fit = slopeFromRing(ring, STAND_SLOPE_RADIUS_M);
          fitted[row.placeId] = {
            slopeDeg: fit?.slopeDeg ?? null,
            aspectDeg: fit?.aspectDeg ?? null,
          };
        });
        setTerrain(fitted);
      } catch {
        // No slope means no thermal factor — exactly the behaviour every
        // caller had before, rather than a board that refuses to draw.
        if (!cancelled) setTerrain({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, key, active, nonce]);

  const nowMs = opts.now?.getTime() ?? null;
  const rows = useMemo((): StandBoardRow[] => {
    if (!active) return [];
    const now = nowMs === null ? new Date() : new Date(nowMs);
    const built = shown.map((row): StandBoardRow => {
      const fit = terrain[row.placeId];
      const days = standWatchDays(row.stand, forecasts[row.placeId] ?? null, sit, {
        huntProfile: quarryByLabel(row.stand.target)?.conditionsProfile ?? 'general',
        slopeDeg: fit?.slopeDeg ?? null,
        aspectDeg: fit?.aspectDeg ?? null,
        now,
      });
      return {
        ...row,
        days,
        cell: days[dayOffset] ?? null,
        slopeDeg: fit?.slopeDeg ?? null,
        aspectDeg: fit?.aspectDeg ?? null,
      };
    });
    return built.sort((a, b) => compareStandCells(a.cell, b.cell));
    // `shown` is memoised on the places array; `forecasts`/`terrain` change only
    // when a fetch lands.
  }, [active, shown, forecasts, terrain, sit, dayOffset, nowMs]);

  const dayStamps = useMemo(() => rows[0]?.days.map((day) => day.dayMs) ?? [], [rows]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const changeDay = useCallback(
    (offset: number) => setDayOffset(Math.max(0, Math.min(STAND_BOARD_DAYS - 1, offset))),
    [],
  );

  return useMemo((): StandBoardState => {
    const controls = { sit, setSit, dayOffset, setDayOffset: changeDay, refresh };
    if (!opts.enabled) return { ...IDLE, ...controls };
    if (stands.length === 0) {
      return {
        ...IDLE,
        ...controls,
        status: 'empty',
        note: 'No saved stands yet — plan stands in view and star the ones worth keeping.',
      };
    }
    const missing = rows.filter((row) => row.cell?.score == null).length;
    return {
      ...controls,
      status: loading && Object.keys(forecasts).length === 0 ? 'loading' : 'ready',
      rows,
      dayStamps,
      note:
        dropped > 0
          ? `Showing the ${STAND_BOARD_LIMIT} stands nearest the map; ${dropped} more are saved.`
          : missing > 0 && missing === rows.length
            ? 'No forecast right now — the sit times are still exact.'
            : null,
    };
  }, [
    opts.enabled,
    stands.length,
    rows,
    dayStamps,
    dropped,
    loading,
    forecasts,
    sit,
    dayOffset,
    changeDay,
    refresh,
  ]);
}
