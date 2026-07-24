/**
 * iNatur offer-boundary resolver: turn an iNatur hunting/fishing *offer* — the
 * one a hunter actually bought — into its exact on-map area (§4.1 / N5).
 *
 * iNatur sells access "offers" (tilbud); each is a 24-hex Mongo ObjectId in its
 * inatur.no URL. Geodata's open ArcGIS service publishes the same id as
 * `tilbudsid` on the offer's delområde ("sub-area") boundary polygons, so a
 * pasted offer URL (or bare id) resolves to the precise boundary the permit
 * covers — far better than tracing it by hand. The backend does the ArcGIS
 * fan-out (`/api/inatur/resolve`); this module is the shared contract + the id
 * parser both the client and the route use.
 */

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
  /** Exterior boundary rings, one per sub-area polygon, as [lng,lat] pairs. */
  rings: [number, number][][];
  /** How many delområde polygons the offer resolved to. */
  subAreas: number;
}

/** GET /api/inatur/resolve?offer=<id|url> — an InaturArea, or 404 when unknown. */
export function inaturResolveUrl(origin: string, offer: string): string {
  return `${origin}/api/inatur/resolve?offer=${encodeURIComponent(offer)}`;
}
