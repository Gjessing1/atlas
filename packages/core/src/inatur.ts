/**
 * iNatur offer-boundary resolver: turn an iNatur hunting/fishing *offer* — the
 * one a hunter actually bought — into its exact on-map area.
 *
 * iNatur sells access "offers" (tilbud); each is a 24-hex Mongo ObjectId in its
 * inatur.no URL. Geodata's open ArcGIS service publishes the same id as
 * `tilbudsid` on the offer's delområde ("sub-area") boundary polygons, so a
 * pasted offer URL (or bare id) resolves to the precise boundary the permit
 * covers — far better than tracing it by hand. The backend does the ArcGIS
 * fan-out (`/api/inatur/resolve`); this module is the shared contract + the id
 * parser both the client and the route use.
 */

import type { LatLng } from './geo.js';

/** Pull a 24-hex iNatur offer id out of a raw id or a pasted offer URL. */
export function parseOfferId(input: string): string | undefined {
  const m = input.match(/[0-9a-f]{24}/i);
  return m ? m[0].toLowerCase() : undefined;
}

/** One resolved offer boundary, ready for a client to draw and save. */
export interface InaturArea {
  /** The offer id we resolved (lower-cased 24-hex). */
  offerId: string;
  /** Suggested name from the boundary's own attributes (the user can rename). */
  name?: string;
  /** [w,s,e,n] spanning every sub-area. */
  bbox: [number, number, number, number];
  /**
   * The actual polygon topology: sub-area → ring → [lng,lat]. Ring zero is the
   * exterior and later rings are holes. This is what a persisted map overlay
   * draws; unlike the flattened `rings` compatibility view it cannot fill an
   * excluded island by mistake.
   */
  polygons: [number, number][][][];
  /**
   * All boundary rings across the offer's sub-areas, as [lng,lat] pairs — the
   * exterior outline of each polygon *and* any interior rings (holes: ground the
   * permit excludes). Each ring is closed; a client draws each as its own loop.
   * Kept alongside `polygons` because GPX export is line-based.
   */
  rings: [number, number][][];
  /** How many delområde polygons the offer resolved to. */
  subAreas: number;
}

/** GET /api/inatur/resolve?offer=<id|url> — an InaturArea, or 404 when unknown. */
export function inaturResolveUrl(origin: string, offer: string): string {
  return `${origin}/api/inatur/resolve?offer=${encodeURIComponent(offer)}`;
}

/** The three ways a resolve can fail, phrased for the person who pasted a link. */
export const INATUR_BAD_INPUT = 'Paste an iNatur offer link or its 24-character id.';
export const INATUR_NO_BOUNDARY = 'No boundary is published for that offer.';
export const INATUR_UNAVAILABLE = 'iNatur is unavailable right now. Try again later.';

/**
 * Resolve an offer link/id to its boundary, throwing one of the messages above.
 * Shared by both clients so they cannot drift — and so the *cache rule* lives in
 * one place.
 *
 * Resolving is a deliberate user action ("draw me this permit"), so it must
 * never be served from an HTTP cache: a stored body outlives the fix that
 * corrected it, and re-pasting the link — the one thing a user does when an area
 * looks wrong — would hand back the same wrong boundary. That is exactly how
 * v0.86.0's permit-hole fix stayed invisible behind a day-old cached response.
 */
export async function resolveInaturOffer(
  origin: string,
  offer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InaturArea> {
  const raw = offer.trim();
  if (!parseOfferId(raw)) throw new Error(INATUR_BAD_INPUT);
  let res: Response;
  try {
    res = await fetchImpl(inaturResolveUrl(origin, raw), {
      // `cache` covers browsers; React Native's fetch ignores it, so the request
      // header is what makes Android's OkHttp cache stand aside.
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
    });
  } catch {
    throw new Error(INATUR_UNAVAILABLE);
  }
  if (res.status === 404) throw new Error(INATUR_NO_BOUNDARY);
  if (!res.ok) throw new Error(INATUR_UNAVAILABLE);
  return (await res.json()) as InaturArea;
}

/** Track name for a saved permit: its sub-area name, else the offer's tail. */
export function inaturTrackName(area: InaturArea): string {
  return area.name ? `iNatur – ${area.name}` : `iNatur permit ${area.offerId.slice(-6)}`;
}

/** The boundary as track segments — one closed loop per ring, holes included. */
export function inaturSegments(area: InaturArea): LatLng[][] {
  return area.rings.map((ring) => ring.map(([lng, lat]) => ({ lat, lng })));
}
