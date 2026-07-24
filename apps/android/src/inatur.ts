import { inaturSegments, inaturTrackName, resolveInaturOffer } from '@atlas/core';
import { buildGpx } from '@atlas/gpx';
import * as FileSystem from 'expo-file-system/legacy';

import type { PickedFile } from './useUserData';

/**
 * Resolve an iNatur hunting/fishing *offer* (a permit link or its 24-hex id) to
 * its exact on-map boundary and hand it back as a GPX file ready for the normal
 * track importer (Android twin of the web Sidebar's iNatur tool). GPX under the
 * hood so the saved permit draws, exports and syncs like any other track —
 * "everything exportable". Each boundary ring becomes a track segment.
 *
 * Throws a user-facing Error on any failure (bad input, no published boundary,
 * upstream down) so the caller's existing try/catch surfaces the message.
 */
export async function inaturOfferToFile(origin: string, input: string): Promise<PickedFile> {
  const area = await resolveInaturOffer(origin, input);
  const gpx = buildGpx({
    name: inaturTrackName(area),
    segments: inaturSegments(area),
    waypoints: [],
  });
  const name = `inatur-${area.offerId}.gpx`;
  const uri = `${FileSystem.cacheDirectory ?? ''}${name}`;
  await FileSystem.writeAsStringAsync(uri, gpx);
  return { name, uri };
}
