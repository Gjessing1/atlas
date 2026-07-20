import type { ElevationResponse, LatLng } from '@atlas/core';
import { useEffect, useState } from 'react';

export interface ElevationState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Metres above sea level; null when the point is outside the model's coverage. */
  elevationM: number | null;
}

const IDLE: ElevationState = { status: 'idle', elevationM: null };

/**
 * Terrain height for a point from the backend's Høydedata proxy (null = idle).
 *
 * The height is fetched rather than derived, so it is the one thing on the place
 * card that can fail or be missing. Coverage is Norway-only, and the upstream
 * answers "no data here" with a null height rather than an error — the two are
 * kept apart (`ready` with a null height vs `error`) so the card can say "no
 * elevation data" for a point at sea off Denmark instead of implying the
 * service is broken.
 */
export function useElevation(target: LatLng | null): ElevationState {
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
    fetch(`/api/elevation?lat=${lat}&lon=${lon}`)
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
  }, [lat, lon]);

  return state;
}
