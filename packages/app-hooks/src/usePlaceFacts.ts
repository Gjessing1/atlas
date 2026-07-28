/**
 * "What is this spot like" — the two facts every place card leads with, before
 * anything about what you can *do* with the spot (ROADMAP § 7.2).
 *
 * They are one hook rather than two because they had drifted: the web card
 * showed elevation and light, the Android card showed neither, even though both
 * facts were already shared code sitting one import away. Deriving them
 * together means a card renders the pair or nothing — there is no arrangement
 * in which one client quietly has half of them.
 *
 * The two facts fail in opposite ways, which is why they are kept apart in the
 * result. Light is pure local maths: no network, no coverage limits, always an
 * answer. Elevation is a fetch against a Norway-only model, so it is the one
 * thing on the card that can be missing or fail — and "no data here" (a point
 * at sea off Denmark) is deliberately not the same state as "the lookup broke".
 */

import { describeSunDay, sunDay } from '@atlas/conditions';
import type { ElevationResponse, LatLng } from '@atlas/core';
import { useEffect, useMemo, useState } from 'react';

export interface ElevationState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Metres above sea level; null when the point is outside the model's coverage. */
  elevationM: number | null;
}

export interface PlaceFacts {
  elevation: ElevationState;
  /** One line about the day's light, or '' when there is nothing to say. */
  light: string;
}

const IDLE: ElevationState = { status: 'idle', elevationM: null };

/**
 * Terrain height for a point from the backend's Høydedata proxy.
 *
 * `origin` is the Atlas server to ask: '' on the web, where the app is served
 * same-origin, and the configured server on Android.
 */
export function useElevation(origin: string, target: LatLng | null): ElevationState {
  const [state, setState] = useState<ElevationState>(IDLE);
  // Round to the proxy's own ~1 m cache grid: a marker dragged by centimetres
  // should not re-fetch, and this keeps the effect from firing on float noise.
  const lat = target ? Math.round(target.lat * 1e5) / 1e5 : undefined;
  const lon = target ? Math.round(target.lng * 1e5) / 1e5 : undefined;

  useEffect(() => {
    if (lat === undefined || lon === undefined) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', elevationM: null });
    fetch(`${origin}/api/elevation?lat=${lat}&lon=${lon}`)
      .then((res) => (res.ok ? (res.json() as Promise<ElevationResponse>) : null))
      .then((data) => {
        if (cancelled) return;
        setState(
          data
            ? { status: 'ready', elevationM: data.elevationM }
            : { status: 'error', elevationM: null },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', elevationM: null });
      });
    return () => {
      cancelled = true;
    };
  }, [origin, lat, lon]);

  return state;
}

/**
 * Both facts for one point. `at` may be null (no card open), which parks the
 * elevation lookup at `idle` and leaves the light line empty.
 */
export function usePlaceFacts(origin: string, at: LatLng | null): PlaceFacts {
  const elevation = useElevation(origin, at);
  // Recomputed per position, and per day only in the sense that a card is
  // short-lived — a card left open past midnight is not a case worth a timer.
  const light = useMemo(
    () => (at ? describeSunDay(sunDay(new Date(), at.lat, at.lng)) : ''),
    [at?.lat, at?.lng],
  );
  return { elevation, light };
}
