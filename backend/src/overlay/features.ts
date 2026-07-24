import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply } from 'fastify';
import type { ArcGisVectorUpstream } from './catalog.js';
import type { OverlayContext } from './context.js';

/**
 * Vector overlays sourced from ArcGIS REST (`arcgis-vector`, §4.7a): the whole
 * coverage pulled once as GeoJSON, disk-cached, and served at
 * `/api/overlay/:id/features`. The client renders + hit-tests it directly (the
 * speed-camera pattern, generalized). The speed-camera layer keeps its own
 * `/features` route on the NVDB data; this handles every catalog layer whose
 * upstream is `arcgis-vector`, and 404s for anything else.
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

  // De-dupe concurrent cold fetches: a national pull is slow, and the first
  // load of an on-by-default layer fans out from every open client at once.
  const inflight = new Map<string, Promise<string>>();

  app.get<{ Params: { id: string } }>('/api/overlay/:id/features', async (request, reply) => {
    const layer = byId.get(request.params.id);
    const up = layer?.upstream.kind === 'arcgis-vector' ? layer.upstream : undefined;
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
      const fc = await fetchArcGisVector(up, fetchImpl);
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
