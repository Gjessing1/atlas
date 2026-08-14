import { STAND_SLOPE_BEARINGS, STAND_SLOPE_RADIUS_M } from '@atlas/conditions';
import {
  destinationPoint,
  slopeFromRing,
  type ElevationProfileResponse,
  type LatLng,
  type TerrainSlope,
} from '@atlas/core';
import { useEffect, useState } from 'react';

export interface TerrainSlopeState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly fit: TerrainSlope | null;
}

const IDLE: TerrainSlopeState = { status: 'idle', fit: null };

/** The same eight-point terrain ring used by the saved-stand board. */
export function terrainSlopeRing(at: LatLng): LatLng[] {
  return STAND_SLOPE_BEARINGS.map((bearing) => destinationPoint(at, bearing, STAND_SLOPE_RADIUS_M));
}

/** Read and fit one point's local ground fall through Atlas's elevation proxy. */
export async function fetchTerrainSlope(
  origin: string,
  at: LatLng,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<TerrainSlope | null> {
  const res = await (opts.fetchImpl ?? fetch)(`${origin}/api/elevation/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: terrainSlopeRing(at) }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as ElevationProfileResponse;
  const samples = STAND_SLOPE_BEARINGS.map((bearingDeg, index) => ({
    bearingDeg,
    elevationM: body.samples[index]?.elevationM ?? null,
  }));
  return slopeFromRing(samples, STAND_SLOPE_RADIUS_M);
}

/** Fetch local slope only while a point-specific hunting surface needs it. */
export function useTerrainSlope(
  origin: string,
  at: LatLng | null,
  enabled: boolean,
): TerrainSlopeState {
  const [state, setState] = useState<TerrainSlopeState>(IDLE);
  const lat = at?.lat;
  const lng = at?.lng;

  useEffect(() => {
    if (!enabled || lat === undefined || lng === undefined) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading', fit: null });
    void fetchTerrainSlope(origin, { lat, lng }, { signal: controller.signal })
      .then((fit) => setState({ status: 'ready', fit }))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError') {
          setState({ status: 'error', fit: null });
        }
      });
    return () => controller.abort();
  }, [origin, lat, lng, enabled]);

  return state;
}
