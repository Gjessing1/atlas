import type { LatLng } from '@atlas/core';

/**
 * Ask the backend what is at a coordinate, so a stop the user placed by hand
 * (map click, marker drag, dropped pin) reads as a place rather than decimals.
 *
 * Best-effort by design: an unreachable geocoder, or a point outside the search
 * index (the Photon import is Norway-only), just leaves the stop showing its
 * coordinates — never an error the user has to deal with.
 */
export async function reverseGeocode(at: LatLng, signal?: AbortSignal): Promise<string | null> {
  const params = new URLSearchParams({ lat: String(at.lat), lon: String(at.lng) });
  try {
    const res = await fetch(`/api/search/reverse?${params}`, signal ? { signal } : {});
    if (!res.ok) return null;
    const body = (await res.json()) as { result: { name?: string } | null };
    return body.result?.name ?? null;
  } catch {
    return null;
  }
}
