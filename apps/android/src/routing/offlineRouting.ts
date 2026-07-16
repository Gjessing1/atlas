import { bboxContains, type LatLng } from '@atlas/core';
import {
  httpRouteProvider,
  roundTripLocations,
  valhallaRouteProvider,
  type RouteProvider,
  type RouteQuery,
} from '@atlas/routing';

import { Valhalla } from '../../modules/valhalla';
import { listLocalPacks, type LocalPack } from '../regions/packs';
import { makeValhallaConfig } from './valhallaConfig';

/**
 * Offline-first routing (architecture rule 3: local → remote). Every route
 * request first looks for a downloaded region pack whose bbox covers all the
 * query's points and that ships Valhalla tiles; if one exists, the embedded
 * engine answers — no network, and byte-compatible with the server because
 * it's the same engine over the same data pipeline. Anything else (no pack,
 * old app build without the native module, engine error near a pack's edge)
 * falls back to the server's /api/route.
 */

/** The points a query will actually route through — round trips synthesize vias. */
function queryPoints(query: RouteQuery): LatLng[] {
  return query.roundTrip
    ? roundTripLocations(query.points[0]!, query.roundTrip.distanceM, query.roundTrip.seed ?? 0)
    : query.points;
}

/** The downloaded pack that can answer this query offline, if any. */
export function offlinePackFor(packs: LocalPack[], query: RouteQuery): LocalPack | null {
  const points = queryPoints(query);
  return (
    packs.find(
      (pack) =>
        pack.manifest.files.routing &&
        points.every((point) => bboxContains(pack.manifest.bbox, point)),
    ) ?? null
  );
}

/** Plain filesystem path of a pack's Valhalla tile extract. */
function tileExtractPath(pack: LocalPack): string {
  return `${pack.dir}/${pack.manifest.files.routing!.path}`.replace(/^file:\/\//, '');
}

// The engine holds one tile extract at a time; reopening is cheap but not
// free, so remember which one is loaded. (Failed opens leave this null.)
let openExtract: string | null = null;

async function ensureEngine(extract: string): Promise<void> {
  if (openExtract === extract) return;
  openExtract = null;
  await Valhalla!.open(makeValhallaConfig(extract));
  openExtract = extract;
}

/** Forget the open engine state, e.g. after deleting a pack. */
export async function closeEngine(): Promise<void> {
  openExtract = null;
  await Valhalla?.close();
}

/**
 * The app's RouteProvider: embedded Valhalla when a downloaded pack covers the
 * query, otherwise the server. Route planning and navigation both use this.
 */
export function makeRouteProvider(serverOrigin: string): RouteProvider {
  const online = httpRouteProvider({ baseUrl: serverOrigin });
  const offline = valhallaRouteProvider(async (request) => {
    return JSON.parse(await Valhalla!.route(JSON.stringify(request))) as unknown;
  });
  return {
    async route(query, signal) {
      if (Valhalla) {
        try {
          const pack = offlinePackFor(await listLocalPacks(), query);
          if (pack) {
            await ensureEngine(tileExtractPath(pack));
            return await offline.route(query, signal);
          }
        } catch (error) {
          // Offline was a fast path, not the only path — let the server try.
          console.warn('offline routing failed, falling back to server:', error);
        }
      }
      return online.route(query, signal);
    },
  };
}
