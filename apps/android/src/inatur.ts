import { inaturResolveUrl, parseOfferId, type InaturArea } from '@atlas/core';
import { buildGpx } from '@atlas/gpx';
import * as FileSystem from 'expo-file-system/legacy';

import type { PickedFile } from './useUserData';

/**
 * Resolve an iNatur hunting/fishing *offer* (a permit link or its 24-hex id) to
 * its exact on-map boundary and hand it back as a GPX file ready for the normal
 * track importer (Android twin of the web Sidebar's iNatur tool). GPX under the
 * hood so the saved permit draws, exports and syncs like any other track —
 * "everything exportable". Each delområde becomes a track segment.
 *
 * Throws a user-facing Error on any failure (bad input, no published boundary,
 * upstream down) so the caller's existing try/catch surfaces the message.
 */
export async function inaturOfferToFile(origin: string, input: string): Promise<PickedFile> {
  const raw = input.trim();
  if (!parseOfferId(raw)) {
    throw new Error('Paste an iNatur offer link or its 24-character id.');
  }
  let res: Response;
  try {
    res = await fetch(inaturResolveUrl(origin, raw));
  } catch {
    throw new Error('iNatur is unavailable right now. Try again later.');
  }
  if (res.status === 404) throw new Error('No boundary is published for that offer.');
  if (!res.ok) throw new Error('iNatur is unavailable right now. Try again later.');

  const area = (await res.json()) as InaturArea;
  const gpx = buildGpx({
    name: area.name ? `iNatur – ${area.name}` : `iNatur permit ${area.offerId.slice(-6)}`,
    segments: area.rings.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
    waypoints: [],
  });
  const name = `inatur-${area.offerId}.gpx`;
  const uri = `${FileSystem.cacheDirectory ?? ''}${name}`;
  await FileSystem.writeAsStringAsync(uri, gpx);
  return { name, uri };
}
