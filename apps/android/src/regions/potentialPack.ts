import type { BBox, RegionPackManifest } from '@atlas/core';
import type { LngLatBbox } from '@atlas/core';

/**
 * Asking the server to bundle the framed area's derived surface.
 *
 * The build is synchronous on the server — it zips cells that already exist, so
 * there is nothing to queue and nothing to poll. What can come back instead is
 * a *refusal*, and those are the interesting cases: the area is not fully
 * prepared yet, or it is larger than a pack is allowed to be. Both arrive as
 * plain sentences the user can act on, so they are passed through verbatim
 * rather than replaced with a generic failure.
 */

export interface PotentialPackRequest {
  name: string;
  bbox: BBox;
  surfaces: { layer: string; target: string }[];
}

/** The map's viewport as the pack endpoint wants it. */
export function viewBbox(bbox: LngLatBbox): BBox {
  const [west, south, east, north] = bbox;
  return { sw: { lat: south, lng: west }, ne: { lat: north, lng: east } };
}

export async function requestPotentialPack(
  origin: string,
  request: PotentialPackRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RegionPackManifest> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/potential/packs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error('Server unreachable — nothing was kept offline.');
  }
  const body = (await response.json().catch(() => ({}))) as Partial<RegionPackManifest> & {
    error?: string;
  };
  if (!response.ok || typeof body.id !== 'string') {
    // The server's own sentence, when it has one: "let the map finish preparing
    // this area" is advice, and rewording it here would lose that.
    throw new Error(body.error ?? `Could not keep this area offline (${response.status}).`);
  }
  return body as RegionPackManifest;
}
