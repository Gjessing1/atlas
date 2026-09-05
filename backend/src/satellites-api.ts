import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { SATELLITES_ID, STARLINK_ID, type LayerMeta } from '@atlas/core';
import { parseOmmRecords, type SatelliteElementSet, type SatelliteGroup } from '@atlas/satellites';
import type { FastifyInstance } from 'fastify';

import type { StatusRegistry } from './status.js';

/**
 * Orbital elements from CelesTrak's public GP API, cached and re-served.
 *
 * This route exists to be a *cache*, not a convenience. CelesTrak publishes
 * without a key or an account and asks in return that a consumer download each
 * file at most once per two-hour update cycle, stop on any non-200, and — in
 * so many words — that an organisation behind one address run its own proxy
 * rather than letting every client hit theirs. A self-hosted Atlas is exactly
 * that shape: one fetch here serves every phone and browser on the instance,
 * whether that is one device or a hundred, and the count upstream sees does not
 * grow with users.
 *
 * There is no TLE anywhere in this path. CelesTrak stopped publishing TLEs for
 * newly catalogued objects in mid-July 2026, when catalog numbers outgrew the
 * format's five digits; OMM has no such ceiling, and a tracker built on TLE
 * would quietly go blind to everything launched since.
 */

const GP_URL = 'https://celestrak.org/NORAD/elements/gp.php';

/** CelesTrak's own update cadence, and the floor on how often we may ask. */
const REFRESH_MS = 2 * 60 * 60_000;

/**
 * How long a failing upstream may keep us on the last good set before the
 * status page calls the layer degraded. Elements stay perfectly usable well
 * past this — it is the operator's cue, not the client's.
 */
const STALE_WARN_MS = 12 * 60 * 60_000;

const PROBE = 'celestrak';

/** Which CelesTrak groups each catalog row is built from. */
const LAYER_GROUPS: Record<string, SatelliteGroup[]> = {
  [SATELLITES_ID]: ['stations', 'visual'],
  [STARLINK_ID]: ['starlink'],
};

export interface SatellitesApiOptions {
  fetchImpl?: typeof fetch;
  status?: StatusRegistry;
  /** Where the last good element sets are kept across restarts. */
  dataDir?: string;
  /** Test seam. */
  now?: () => number;
}

/**
 * The stations-and-visual row.
 *
 * `visual` is the half that matters north of about 62°N, and not for a reason
 * anyone guesses: the ISS is inclined 51.6°, so from Tromsø it never climbs
 * more than about three degrees above the horizon — a graze, never a sighting.
 * Ninety-three of the visual set's objects are in near-polar orbits and do
 * cross that sky nightly. Shipping the ISS alone would have made the layer
 * useless in exactly the half of Norway with the darkest skies.
 */
export function satellitesLayerMeta(): LayerMeta {
  return {
    id: SATELLITES_ID,
    rev: 1,
    title: 'Satellites & ISS',
    description:
      'Live positions and ground tracks for the space stations and the naked-eye satellites, ' +
      'propagated on the device from CelesTrak orbital elements.',
    group: 'Sky',
    attribution: 'Orbital elements © CelesTrak',
    metadataUrl: 'https://celestrak.org/NORAD/elements/',
    maxzoom: 22,
    defaultOpacity: 1,
    identify: false,
    coverageNote:
      'Positions are computed on the device, so the layer keeps working offline — accuracy ' +
      'decays with the age of the elements, shown on the layer. The ISS never rises far above ' +
      'the horizon north of about 62°N; the polar-orbit objects do.',
    profiles: ['curiosities'],
    vector: true,
  };
}

/**
 * Starlink as its own row: thousands of objects, opt-in on purpose.
 *
 * Worth a toggle rather than a footnote because a batch launched in the last
 * few days is still flying in formation, and a Starlink train is the most
 * arresting thing most people will ever see cross the sky.
 */
export function starlinkLayerMeta(): LayerMeta {
  return {
    id: STARLINK_ID,
    rev: 1,
    title: 'Starlink',
    description:
      'The Starlink constellation — thousands of objects. A batch launched within the last few ' +
      'days still flies as a train.',
    group: 'Sky',
    attribution: 'Orbital elements © CelesTrak',
    metadataUrl: 'https://celestrak.org/NORAD/elements/',
    maxzoom: 22,
    defaultOpacity: 1,
    identify: false,
    coverageNote:
      'Thousands of objects: expect a crowded map at low zoom. Positions are computed on the ' +
      'device and keep working offline.',
    profiles: ['curiosities'],
    vector: true,
  };
}

interface CachedSet {
  at: number;
  data: SatelliteElementSet;
  /** Serialised once per refresh, not once per request. */
  json: string;
  /**
   * The same payload gzipped, held because it is worth it exactly here: the
   * full Starlink set is 4.6 MB of JSON that compresses to about 620 KB, and it
   * changes once every two hours. Compressing per request would repeat that
   * work for every client; compressing per refresh does it once a cycle. (The
   * backend has no global compression, and adding it for one route would have
   * touched every other.)
   */
  gzip: Buffer;
}

/** Serialise and pre-compress a set for serving. */
function cacheEntry(at: number, data: SatelliteElementSet): CachedSet {
  const json = JSON.stringify(data);
  return { at, data, json, gzip: gzipSync(json) };
}

export function registerSatellitesApi(app: FastifyInstance, opts: SatellitesApiOptions = {}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const status = opts.status;
  const cacheDir = opts.dataDir ? path.join(opts.dataDir, 'satellites') : null;

  status?.register(PROBE, 'CelesTrak orbital elements', 'Overlays');

  const memory = new Map<string, CachedSet>();
  const inFlight = new Map<string, Promise<SatelliteElementSet | null>>();

  const diskPath = (layerId: string) => (cacheDir ? path.join(cacheDir, `${layerId}.json`) : null);

  /** Last good set from disk, so a restart does not cost an upstream fetch. */
  const readDisk = async (layerId: string): Promise<CachedSet | null> => {
    const file = diskPath(layerId);
    if (!file) return null;
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as SatelliteElementSet;
      if (!Array.isArray(data.satellites) || data.satellites.length === 0) return null;
      const at = Date.parse(data.fetchedAt);
      return Number.isFinite(at) ? cacheEntry(at, data) : null;
    } catch {
      return null;
    }
  };

  const writeDisk = async (layerId: string, data: SatelliteElementSet): Promise<void> => {
    const file = diskPath(layerId);
    if (!file) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data));
    } catch (err) {
      app.log.warn({ err, layerId }, 'could not persist satellite elements');
    }
  };

  const fetchGroup = async (group: SatelliteGroup) => {
    const url = `${GP_URL}?GROUP=${encodeURIComponent(group)}&FORMAT=json`;
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    // CelesTrak's usage policy is explicit that a machine consumer must stop on
    // a non-200 and surface it, rather than retry into a firewall rule. The
    // throw propagates to the caller, which falls back to the last good set.
    if (!res.ok) throw new Error(`CelesTrak ${group} responded ${res.status}`);
    return parseOmmRecords(await res.json(), group);
  };

  const refresh = async (layerId: string): Promise<SatelliteElementSet | null> => {
    const groups = LAYER_GROUPS[layerId]!;
    const satellites = [];
    for (const group of groups) satellites.push(...(await fetchGroup(group)));
    // Re-run the whole merged list through the parser so an object present in
    // two groups (the ISS is in both `stations` and `visual`) is de-duplicated
    // once, here, rather than by every client. Group order in LAYER_GROUPS
    // decides which tag survives — `stations` is listed first precisely so the
    // ISS keeps the tag that earns it a label and a track.
    const merged = parseOmmRecords(satellites);
    if (merged.length === 0)
      throw new Error(`CelesTrak returned no usable elements for ${layerId}`);
    return { fetchedAt: new Date(now()).toISOString(), groups, satellites: merged };
  };

  /** Cached set for a layer, refreshing only when the cycle has turned over. */
  const load = async (layerId: string): Promise<CachedSet | null> => {
    const cached = memory.get(layerId) ?? (await readDisk(layerId));
    if (cached) memory.set(layerId, cached);
    if (cached && now() - cached.at < REFRESH_MS) return cached;

    // One upstream request at a time per layer, however many clients ask —
    // the difference between one fetch per cycle and one per cold client.
    let pending = inFlight.get(layerId);
    if (!pending) {
      pending = refresh(layerId)
        .then(async (data) => {
          if (data) {
            memory.set(layerId, cacheEntry(now(), data));
            await writeDisk(layerId, data);
          }
          status?.record(PROBE, true);
          return data;
        })
        .catch((err: unknown) => {
          app.log.warn({ err, layerId }, 'CelesTrak element refresh failed');
          status?.record(
            PROBE,
            // Elements that are merely a few hours old are still fine to fly
            // on; only a long outage is worth a red row.
            Boolean(cached) && now() - cached!.at < STALE_WARN_MS,
            'unreachable',
          );
          return null;
        })
        .finally(() => inFlight.delete(layerId));
      inFlight.set(layerId, pending);
    }
    const fresh = await pending;
    if (fresh) return memory.get(layerId) ?? cacheEntry(now(), fresh);
    return cached;
  };

  app.get<{ Params: { id: string } }>('/api/overlay/:id/elements', async (request, reply) => {
    const layerId = request.params.id;
    if (!LAYER_GROUPS[layerId]) {
      return reply.code(404).send({ error: 'unknown satellite layer' });
    }
    const cached = await load(layerId);
    if (!cached) {
      return reply.code(502).send({ error: 'orbital elements are unavailable right now' });
    }
    const ageMs = now() - cached.at;
    const remaining = Math.max(60, Math.round((REFRESH_MS - ageMs) / 1000));
    reply
      .header('cache-control', `public, max-age=${remaining}, stale-if-error=604800`)
      .header('content-type', 'application/json; charset=utf-8')
      .header('vary', 'accept-encoding');

    const acceptsGzip = /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
    if (!acceptsGzip) return reply.send(cached.json);
    return reply.header('content-encoding', 'gzip').send(cached.gzip);
  });
}
