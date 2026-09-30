import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseKmlPlacemarks } from '@atlas/gpx';
import type { FastifyReply } from 'fastify';
import type {
  ArcGisVectorUpstream,
  NvdbPointSource,
  PointFeedSource,
  PointFeedUpstream,
  SourceDating,
} from './catalog.js';
import type { OverlayContext } from './context.js';

/**
 * Vector overlays sourced from ArcGIS REST (`arcgis-vector`) or merged from
 * several registers (`point-feed`): the whole coverage pulled once as GeoJSON,
 * disk-cached, and served at `/api/overlay/:id/features`. The client renders +
 * hit-tests it directly (the speed-camera pattern, generalized). The
 * speed-camera layer keeps its own `/features` route on the NVDB data; this
 * handles every catalog layer with one of these two upstreams, and 404s for
 * anything else.
 *
 * The upstream is asked to generalize server-side (`maxAllowableOffset`) so a
 * national polygon set arrives at a few MB instead of tens; the merged result
 * is cached to disk for a day (these datasets change seasonally, not by the
 * minute) and re-served verbatim, so the parse+page cost is paid once.
 */

/** Datasets change seasonally; a day between refetches is plenty. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FEATURES_MAX_AGE_S = 3600;
/**
 * One query page. ArcGIS caps a request at the layer's `maxRecordCount`
 * (Statskog: 2000); we page under that with `resultOffset` until a short page
 * ends it, so a set that outgrows one page (a future river network) still
 * arrives whole rather than silently truncated at the cap.
 */
const PAGE_SIZE = 1000;
/** Refuse a runaway pull (a mis-scoped `where`) rather than fill the disk. */
const MAX_PAGES = 60;

interface GeoJsonFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
  /** ArcGIS sets this when more features remain than the page returned. */
  exceededTransferLimit?: boolean;
  error?: { message?: string };
}

function pageUrl(up: ArcGisVectorUpstream, offset: number): URL {
  const url = new URL(up.url);
  const p = url.searchParams;
  p.set('where', up.where ?? '1=1');
  p.set('outFields', up.outFields);
  p.set('returnGeometry', 'true');
  p.set('outSR', '4326');
  p.set('maxAllowableOffset', String(up.simplifyDeg));
  p.set('resultOffset', String(offset));
  p.set('resultRecordCount', String(PAGE_SIZE));
  p.set('f', 'geojson');
  return url;
}

/**
 * Pull the whole layer as one FeatureCollection, paging until a short (or
 * unflagged) page ends it. Throws on any upstream/transport failure so the
 * caller can fall back to a stale cache instead of caching an empty answer.
 */
export async function fetchArcGisVector(
  up: ArcGisVectorUpstream,
  fetchImpl: typeof fetch,
): Promise<FeatureCollection> {
  const features: GeoJsonFeature[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(pageUrl(up, page * PAGE_SIZE), {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`arcgis-vector upstream ${res.status}`);
    const body = (await res.json()) as FeatureCollection;
    if (body.error) throw new Error(body.error.message ?? 'arcgis-vector upstream error');
    if (body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
      throw new Error('arcgis-vector: unexpected payload');
    }
    for (const f of body.features) if (f.geometry) features.push(f);
    // A full page with the more-remaining flag means keep going; anything else
    // (short page, or a page that didn't set the flag) is the last one.
    if (!body.exceededTransferLimit || body.features.length < PAGE_SIZE) break;
  }
  return { type: 'FeatureCollection', features };
}

const NVDB_API = 'https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter';
/** NVDB's page cap; a type bigger than MAX_PAGES of these is not a point overlay. */
const NVDB_PAGE_SIZE = 1000;

interface NvdbObject {
  egenskaper?: { navn?: string; verdi?: unknown }[];
  geometri?: { wkt?: string };
  lokasjon?: {
    geometri?: { wkt?: string };
    adresser?: { navn?: string }[];
    vegsystemreferanser?: { vegsystem?: { vegkategori?: string; nummer?: number } }[];
  };
}

/**
 * `POINT Z (lat lng z)` → `[lng, lat]`. NVDB writes srid=4326 WKT in the CRS's
 * *axis* order, latitude first — the opposite of GeoJSON, and of what every
 * other WKT source here does. Anything outside a generous Norway box is
 * treated as unparseable rather than drawn in the sea off Africa.
 */
export function nvdbPoint(wkt: string | undefined): [number, number] | null {
  const m = /^POINT(?: Z)?\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/.exec(wkt ?? '');
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!(lat >= 57 && lat <= 81.5 && lng >= 3 && lng <= 34)) return null;
  return [lng, lat];
}

/** "E6", "Fv5724", "Rv3" — the vegkategori letter is E/R/F/K/P/S. */
function roadRef(obj: NvdbObject): string | undefined {
  const vs = obj.lokasjon?.vegsystemreferanser?.[0]?.vegsystem;
  if (!vs?.vegkategori || typeof vs.nummer !== 'number') return undefined;
  return vs.vegkategori === 'E' ? `E${vs.nummer}` : `${vs.vegkategori}v${vs.nummer}`;
}

/** The flattened record a `PointFeedSource.properties` receives for an NVDB object. */
export function nvdbRecord(obj: NvdbObject): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of obj.egenskaper ?? []) if (e.navn) out[e.navn] = e.verdi;
  const road = roadRef(obj);
  if (road) out['vegsystem'] = road;
  const street = obj.lokasjon?.adresser?.[0]?.navn;
  if (street) out['adresse'] = street;
  return out;
}

/**
 * Every object of one NVDB type as `[lng, lat]` + flattened record. Objects
 * placed only by reference to the road network carry no `geometri` of their
 * own (99 of 721 toilets), so the location's derived point stands in.
 */
async function fetchNvdbPoints(
  src: NvdbPointSource,
  fetchImpl: typeof fetch,
): Promise<{ at: [number, number]; record: Record<string, unknown> }[]> {
  const out: { at: [number, number]; record: Record<string, unknown> }[] = [];
  let start: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${NVDB_API}/${src.typeId}`);
    url.searchParams.set('inkluder', 'egenskaper,lokasjon,geometri');
    url.searchParams.set('srid', '4326');
    url.searchParams.set('antall', String(NVDB_PAGE_SIZE));
    if (start) url.searchParams.set('start', start);
    const res = await fetchImpl(url, {
      headers: { 'X-Client': 'atlas', Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`nvdb upstream ${res.status}`);
    const body = (await res.json()) as {
      objekter?: NvdbObject[];
      metadata?: { returnert?: number; neste?: { start?: string } };
    };
    if (!Array.isArray(body.objekter)) throw new Error('nvdb: unexpected payload');
    for (const obj of body.objekter) {
      const at = nvdbPoint(obj.geometri?.wkt) ?? nvdbPoint(obj.lokasjon?.geometri?.wkt);
      if (at) out.push({ at, record: nvdbRecord(obj) });
    }
    // NVDB always offers a `neste` cursor, even past the end; a short page is
    // what actually says there is no more.
    start = body.metadata?.neste?.start;
    if (!start || body.objekter.length < NVDB_PAGE_SIZE) break;
  }
  return out;
}

/** A generous Norway box, as `nvdbPoint` uses: anything outside is a data error. */
function inNorway(lng: number, lat: number): boolean {
  return lat >= 57 && lat <= 81.5 && lng >= 3 && lng <= 34;
}

async function fetchText(url: string, fetchImpl: typeof fetch, what: string): Promise<string> {
  const res = await fetchImpl(new URL(url), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${what} upstream ${res.status}`);
  return res.text();
}

/**
 * Every placemark of a KML source as `[lng, lat]` + record. A placemark
 * imported into My Maps from a spreadsheet can keep its position only in
 * `latitude`/`longitude` columns, with no `<Point>` (9 of Bergen's 58); one
 * with neither is not on the map, and is skipped.
 */
async function fetchKmlPoints(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ coordinates: unknown; record: Record<string, unknown> }[]> {
  const placemarks = parseKmlPlacemarks(await fetchText(url, fetchImpl, 'kml'));
  const out: { coordinates: unknown; record: Record<string, unknown> }[] = [];
  for (const pm of placemarks) {
    const lng = pm.point?.lng ?? Number(pm.data['longitude']);
    const lat = pm.point?.lat ?? Number(pm.data['latitude']);
    if (!inNorway(lng, lat)) continue;
    out.push({
      coordinates: [lng, lat],
      record: { ...pm.data, placemark: pm.name, folder: pm.folder },
    });
  }
  return out;
}

async function fetchGeoJsonPoints(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ coordinates: unknown; record: Record<string, unknown> }[]> {
  const body = JSON.parse(await fetchText(url, fetchImpl, 'geojson')) as FeatureCollection;
  if (body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
    throw new Error('geojson: unexpected payload');
  }
  return body.features
    .filter((f) => f.geometry?.type === 'Point')
    .map((f) => ({ coordinates: f.geometry!.coordinates, record: f.properties ?? {} }));
}

async function sourcePoints(
  source: PointFeedSource,
  fetchImpl: typeof fetch,
): Promise<{ coordinates: unknown; record: Record<string, unknown> }[]> {
  const from = source.from;
  switch (from.kind) {
    case 'nvdb':
      return (await fetchNvdbPoints(from, fetchImpl)).map(({ at, record }) => ({
        coordinates: at,
        record,
      }));
    case 'kml':
      return fetchKmlPoints(from.url, fetchImpl);
    case 'geojson':
      return fetchGeoJsonPoints(from.url, fetchImpl);
    case 'arcgis-vector':
      return (await fetchArcGisVector(from, fetchImpl)).features
        .filter((f) => f.geometry?.type === 'Point')
        .map((f) => ({ coordinates: f.geometry!.coordinates, record: f.properties ?? {} }));
  }
}

/**
 * Where a `content`-dated source's last-change day is remembered between
 * pulls: source URL → fingerprint of its translated features + the day that
 * fingerprint was first seen. Without one (the health probe), such a source
 * gets no `asOf` at all rather than a made-up one.
 */
export interface ContentDates {
  read(): Promise<Record<string, { fingerprint: string; since: string }>>;
  write(state: Record<string, { fingerprint: string; since: string }>): Promise<void>;
}

/** A `ContentDates` kept as one JSON file, written temp-file + rename. */
export function fileContentDates(file: string): ContentDates {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as Record<
          string,
          { fingerprint: string; since: string }
        >;
      } catch {
        return {};
      }
    },
    async write(state) {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 1));
      await rename(tmp, file);
    },
  };
}

/** A CKAN resource's `last_modified` (the publisher's upload date) as `YYYY-MM-DD`. */
async function ckanResourceDate(url: string, fetchImpl: typeof fetch): Promise<string> {
  const body = JSON.parse(await fetchText(url, fetchImpl, 'ckan')) as {
    result?: { last_modified?: string | null; metadata_modified?: string | null };
  };
  const stamp = body.result?.last_modified ?? body.result?.metadata_modified;
  const day = /^\d{4}-\d{2}-\d{2}/.exec(stamp ?? '')?.[0];
  if (!day) throw new Error('ckan: resource has no modification date');
  return day;
}

/**
 * Pull every source of a `point-feed` layer and merge them into one
 * FeatureCollection of points in the layer's shared property set. Also returns
 * how many points each source contributed, which is what the health probe
 * checks: a source collapsing to zero is invisible in the merged total.
 *
 * A source with `dating` gets `asOf` stamped on each of its features. For
 * `content` dating the fingerprint covers the *translated* features — a
 * source's raw bytes can churn with nothing changed (My Maps re-signs its
 * photo URLs on every export), and churn would make a dead list look fresh.
 */
export async function fetchPointFeed(
  up: PointFeedUpstream,
  fetchImpl: typeof fetch,
  dates?: { store: ContentDates; today: string },
): Promise<{ collection: FeatureCollection; perSource: number[] }> {
  const state = dates ? await dates.store.read() : {};
  let stateChanged = false;

  const asOf = async (
    dating: SourceDating,
    key: string,
    mine: GeoJsonFeature[],
  ): Promise<string | undefined> => {
    if (dating.kind === 'ckan-resource') return ckanResourceDate(dating.url, fetchImpl);
    if (!dates) return undefined;
    const fingerprint = createHash('sha256').update(JSON.stringify(mine)).digest('hex');
    const known = state[key];
    if (known?.fingerprint === fingerprint) return known.since;
    // A first sighting takes the catalog's `firstSeen`, never today: with the
    // state lost, the honest claim is "at least this old".
    const since = known ? dates.today : dating.firstSeen;
    state[key] = { fingerprint, since };
    stateChanged = true;
    return since;
  };

  const bySource = await Promise.all(
    up.sources.map(async (source) => {
      const mine: GeoJsonFeature[] = [];
      for (const { coordinates, record } of await sourcePoints(source, fetchImpl)) {
        const properties = source.properties(record);
        if (!properties) continue;
        mine.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates },
          properties: properties as Record<string, unknown>,
        });
      }
      if (source.dating && mine.length > 0) {
        const key = source.from.kind === 'nvdb' ? `nvdb:${source.from.typeId}` : source.from.url;
        const day = await asOf(source.dating, key, mine);
        if (day) for (const f of mine) f.properties = { ...f.properties, asOf: day };
      }
      return mine;
    }),
  );
  if (dates && stateChanged) await dates.store.write(state);
  // Flattened in catalog order, not arrival order, so the cached file (and a
  // client's draw order) is the same on every refetch.
  return {
    collection: { type: 'FeatureCollection', features: bySource.flat() },
    perSource: bySource.map((mine) => mine.length),
  };
}

function serve(reply: FastifyReply, body: string) {
  return reply
    .header('content-type', 'application/json; charset=utf-8')
    .header('cache-control', `public, max-age=${FEATURES_MAX_AGE_S}`)
    .send(body);
}

export function registerFeaturesRoute(ctx: OverlayContext): void {
  const { app, byId, fetchImpl } = ctx;
  const cachePath = (id: string, rev: number) =>
    path.join(ctx.cacheDir, 'features', `${id}-v${rev}.geojson`);
  // Not per-rev: when a list last changed outlives a change to how it is drawn.
  const datesPath = (id: string) => path.join(ctx.cacheDir, 'features', `${id}-dates.json`);

  // De-dupe concurrent cold fetches: a national pull is slow, and the first
  // load of an on-by-default layer fans out from every open client at once.
  const inflight = new Map<string, Promise<string>>();

  app.get<{ Params: { id: string } }>('/api/overlay/:id/features', async (request, reply) => {
    const layer = byId.get(request.params.id);
    const up =
      layer?.upstream.kind === 'arcgis-vector' || layer?.upstream.kind === 'point-feed'
        ? layer.upstream
        : undefined;
    if (!layer || !up) return reply.code(404).send({ error: 'layer has no features' });

    const file = cachePath(layer.meta.id, layer.meta.rev);
    const fresh = await stat(file)
      .then((s) => Date.now() - s.mtimeMs < CACHE_TTL_MS)
      .catch(() => false);
    if (fresh) {
      const cached = await readFile(file, 'utf8').catch(() => null);
      if (cached) return serve(reply, cached);
    }

    const load = async (): Promise<string> => {
      const fc =
        up.kind === 'point-feed'
          ? (
              await fetchPointFeed(up, fetchImpl, {
                store: fileContentDates(datesPath(layer.meta.id)),
                today: new Date().toISOString().slice(0, 10),
              })
            ).collection
          : await fetchArcGisVector(up, fetchImpl);
      const json = JSON.stringify(fc);
      // Temp-file + rename so a concurrent reader never sees a half-written file.
      try {
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmp, json);
        await rename(tmp, file);
      } catch (err) {
        app.log.warn({ err, file }, 'overlay features cache write failed');
      }
      return json;
    };

    try {
      const pending = inflight.get(layer.meta.id) ?? load();
      inflight.set(layer.meta.id, pending);
      const json = await pending.finally(() => inflight.delete(layer.meta.id));
      ctx.record(layer.meta.id, true);
      return serve(reply, json);
    } catch (err) {
      request.log.warn({ err, layer: layer.meta.id }, 'overlay features upstream failed');
      ctx.record(layer.meta.id, false, 'unreachable');
      // A stale-but-usable cache beats an error for a whole-coverage layer.
      const stale = await readFile(file, 'utf8').catch(() => null);
      if (stale) return serve(reply, stale);
      return reply.code(502).send({ error: 'overlay unavailable' });
    }
  });
}
