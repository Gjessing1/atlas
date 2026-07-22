/**
 * Sharing a place with people who do not use Atlas.
 *
 * An Atlas link is the *richest* share — it carries zoom, the pin, and later a
 * route plan — but it only ever opens our own instance, so on its own it hands
 * a Google Maps or OsmAnd user a page they cannot route from. Everything here
 * exists so the same point can also travel in forms every device understands:
 * a `geo:` URI (the universal handoff on Android) and a plain "lat, lng" line
 * that pastes into any maps search box on earth.
 */

import { fmtCoords } from './format.js';
import type { LatLng } from './geo.js';
import { encodeMapHash } from './maphash.js';

/** An Atlas share link for a point: the map centred there, with the pin set. */
export function atlasShareUrl(origin: string, point: LatLng, zoom: number): string {
  return `${origin}${encodeMapHash({ center: point, zoom, pin: point })}`;
}

/**
 * A `geo:` URI. `q=` drops a labelled pin in the apps that honour it, and the
 * bare coordinate in the path is what the ones that don't fall back to.
 */
export function geoUri(point: LatLng, label?: string): string {
  const base = `geo:${point.lat},${point.lng}`;
  if (!label) return base;
  return `${base}?q=${point.lat},${point.lng}(${encodeURIComponent(label)})`;
}

/**
 * The message body for a shared place: name, plain coordinates, then the Atlas
 * link. The coordinate line comes before the link deliberately — it is the part
 * a recipient without Atlas can act on, and putting it first means they never
 * have to open a link on an instance they have no account for to find it.
 */
export function shareMessage(point: LatLng, name: string | undefined, url?: string): string {
  const lines: string[] = [];
  if (name?.trim()) lines.push(name.trim());
  lines.push(fmtCoords(point));
  if (url) lines.push(url);
  return lines.join('\n');
}
