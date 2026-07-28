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

/** What a client does with a chosen share format. */
export type ShareAction =
  /** Hand the text to the OS share sheet (web: `navigator.share`, else copy). */
  | 'send'
  /** Put the text on the clipboard. */
  | 'copy'
  /** Open the payload as a URI and let the OS pick the app. */
  | 'open';

export interface ShareFormat {
  readonly key: 'link' | 'coords' | 'geo';
  readonly title: string;
  /** One line saying what the recipient gets, shown under the title. */
  readonly subtitle: string;
  readonly action: ShareAction;
  /** The text that travels — a message body, clipboard text, or a URI. */
  readonly payload: string;
}

/**
 * The ways one spot can leave the app, in the order a chooser should offer
 * them — the same list, with the same words, on both clients.
 *
 * It exists because the two clients had grown different answers to "share this
 * place": Android offered a three-way chooser, web offered a Share button and a
 * separate Copy coords one, and neither could do what the other did. The list
 * is data rather than UI so each client renders it in its own idiom while the
 * options, their wording and their order stay one thing.
 *
 * `handoff` gates the `geo:` entry, which is Android-only by nature: a desktop
 * browser has no map app to hand the point to, and the entry would be an option
 * that silently does nothing.
 */
export function shareFormats(
  point: LatLng,
  name: string | undefined,
  url: string,
  options?: { readonly handoff?: boolean },
): readonly ShareFormat[] {
  const formats: ShareFormat[] = [
    {
      key: 'link',
      title: 'Atlas link',
      subtitle: 'Opens the map here, in any browser',
      action: 'send',
      // The coordinates ride along inside the message: a recipient without
      // Atlas cannot open our instance usefully, but they can paste the
      // coordinate line into whatever map app they do use.
      payload: shareMessage(point, name, url),
    },
    {
      key: 'coords',
      title: 'Copy coordinates',
      subtitle: fmtCoords(point),
      action: 'copy',
      payload: fmtCoords(point),
    },
  ];
  if (options?.handoff) {
    formats.push({
      key: 'geo',
      title: 'Open in a map app',
      subtitle: 'Google Maps, Organic Maps, OsmAnd…',
      action: 'open',
      payload: geoUri(point, name),
    });
  }
  return formats;
}
