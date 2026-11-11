/**
 * Reading the links *other* apps use to hand a place to a map app.
 *
 * Android has no "default maps app" switch. What it has is the `geo:` URI: a
 * contact's address, a calendar location, a "show on map" button all fire one,
 * and the system offers every app that registered for the scheme — with
 * "Always" making one of them the default. Being a default map app is therefore
 * exactly two things: claiming the scheme in the manifest, and understanding
 * what arrives. This is the second half; it is shared code because the formats
 * are a fact about the world, not about one client.
 *
 * Two schemes are read:
 *
 * - `geo:` (RFC 5870 plus the de-facto Android extensions `?z=` and `?q=`).
 * - `google.navigation:q=…` — what "navigate" buttons fire. Nothing
 *   standardised it, but apps hard-code it, and a map app that ignores it is
 *   simply not offered for those buttons.
 */

import type { LatLng } from './geo.js';

export interface GeoLink {
  /** The place the link points at, when it names one by coordinate. */
  point?: LatLng;
  /** Requested zoom (`?z=`), when given and sane. */
  zoom?: number;
  /** A name for `point`, from `q=lat,lng(Name)`. */
  label?: string;
  /**
   * Free text to search for (`geo:0,0?q=Storgata 1, Oslo`). Present only when
   * the link carries no usable coordinate: an address is something to look up,
   * and only the caller has a geocoder.
   */
  query?: string;
}

function validPoint(lat: number, lng: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

const NUMBER = String.raw`[+-]?\d+(?:\.\d+)?`;
const PAIR_PREFIX = new RegExp(String.raw`^\s*(${NUMBER})\s*,\s*(${NUMBER})`);
/** `lat,lng` alone, or followed by a parenthesised label. */
const QUERY_POINT = new RegExp(
  String.raw`^\s*(${NUMBER})\s*,\s*(${NUMBER})\s*(?:\((.*)\))?\s*$`,
  's',
);

/** Decode one query value; senders disagree about `+`, so both mean a space. */
function decodeValue(raw: string): string {
  const spaced = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    // A stray `%` from a sender that did not encode at all: the text is still
    // a perfectly good search, so use it as it came.
    return spaced;
  }
}

/** Split `a=1&b=2`, keeping only the first occurrence of each key. */
function queryParams(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    if (!params.has(key)) params.set(key, eq < 0 ? '' : decodeValue(part.slice(eq + 1)));
  }
  return params;
}

/** A `q=` value is either a coordinate (optionally named) or text to search. */
function readQuery(q: string | undefined, into: GeoLink): void {
  const text = q?.trim();
  if (!text) return;
  const match = QUERY_POINT.exec(text);
  const point = match ? validPoint(Number(match[1]), Number(match[2])) : null;
  if (point) {
    into.point = point;
    const label = match![3]?.trim();
    if (label) into.label = label;
    return;
  }
  into.query = text;
}

/**
 * Parse a `geo:` or `google.navigation:` URI. Null for any other URL, and for
 * one of these that says nothing usable.
 */
export function decodeGeoLink(url: string): GeoLink | null {
  const scheme = /^\s*(geo|google\.navigation):/i.exec(url);
  if (!scheme) return null;
  const rest = url.slice(scheme[0].length).trim();
  const link: GeoLink = {};

  if (scheme[1]!.toLowerCase() === 'geo') {
    const queryAt = rest.indexOf('?');
    const path = queryAt < 0 ? rest : rest.slice(0, queryAt);
    const params = queryParams(queryAt < 0 ? '' : rest.slice(queryAt + 1));

    readQuery(params.get('q'), link);
    if (!link.point) {
      // The path coordinate — but `0,0` is the convention for "no position,
      // see q=", not a request to look at the Gulf of Guinea.
      const pair = PAIR_PREFIX.exec(path.replace(/^\/+/, ''));
      const point = pair ? validPoint(Number(pair[1]), Number(pair[2])) : null;
      if (point && !(point.lat === 0 && point.lng === 0)) {
        link.point = point;
        // A coordinate wins over text: the sender knew where, and the text was
        // only ever its description.
        if (link.query) {
          link.label = link.query;
          delete link.query;
        }
      }
    }
    const zoom = Number(params.get('z'));
    if (params.has('z') && Number.isFinite(zoom) && zoom >= 1 && zoom <= 22) link.zoom = zoom;
  } else {
    // `google.navigation:q=…&mode=d`, sometimes written `google.navigation:///?q=…`.
    readQuery(queryParams(rest.replace(/^\/*\??/, '')).get('q'), link);
  }

  return link.point || link.query ? link : null;
}
