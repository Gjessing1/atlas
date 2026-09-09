import { open, readFile, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import { coverageIntersectsTile, parsePolyFile, type CoveragePolygon } from '@atlas/core';

/**
 * Merged z/x/y tile endpoint: `/api/tiles/<area>/{z}/{x}/{y}.pbf`.
 *
 * Tiles inside a self-built regional archive (`<dataDir>/tiles/<area>.pmtiles`)
 * are served locally; everything else streams from an upstream world tile
 * source at view time (proxied, with a bounded in-memory cache) — world
 * coverage is never bulk-downloaded onto the server. Low zooms prefer the
 * upstream even where local tiles exist: the regional archive's low-zoom tiles
 * are clipped to the region, so a z4 tile of Scandinavia rendered from it
 * would show Norway floating next to blank neighbours.
 *
 * The upstream (WORLD_TILES_URL) is either a `{z}/{x}/{y}` URL template or a
 * TileJSON URL to resolve one from; the default is OpenFreeMap's planet
 * TileJSON, whose tile URLs are versioned — hence the hourly re-resolve.
 *
 * Overlay archives (`OVERLAY_AREAS`) are the exception to both rules: they are
 * our own schema, so an upstream basemap tile is not a substitute for a missing
 * one — it is a different map. They are served local-only, at every zoom.
 *
 * **Bytes are not coverage.** Planetiler fills every tile in the *bounding box*
 * of its extract from global sources (water polygons, Natural Earth), so
 * norway.pmtiles answered for Stockholm and Helsinki with tiles holding nothing
 * but `water`. Treating that as coverage put a grey hole over every coastal
 * area Norway's box overhangs, because the world upstream was never consulted.
 * So an archive answers only where `<area>.poly` (published beside it by
 * infrastructure/tiles/build-basemap.sh) says the region actually is. An
 * archive with no polygon keeps the old presence-is-coverage behaviour — the
 * clip is a promotion of coverage information, never a way to lose an archive.
 */

const DEFAULT_WORLD_TILES_URL = 'https://tiles.openfreemap.org/planet';
/** Below this zoom the (region-clipped) local tiles look broken; use upstream. */
const LOCAL_PREFERRED_MIN_ZOOM = 10;

/**
 * Areas that are Atlas-built overlays rather than basemap coverage.
 *
 * `outdoor` carries the outdoor POIs and barriers the OpenMapTiles basemap
 * drops or hides until z14 (infrastructure/tiles/outdoor-schema.yml). Its layer
 * and attribute names are ours, so the world upstream can never stand in for
 * it: proxying would answer with basemap tiles the outdoor layers cannot read,
 * and would hammer the upstream for every tile of an archive we may not have
 * built yet. A missing overlay tile is simply empty — which is exactly how a
 * client without the archive is meant to degrade.
 */
const OVERLAY_AREAS = new Set(['outdoor']);
const TILEJSON_TTL_MS = 60 * 60 * 1000;
const TILEJSON_RETRY_MS = 60 * 1000;
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/** Reads a tile from a local archive; null = archive or tile absent. */
export type LocalTileReader = (
  area: string,
  z: number,
  x: number,
  y: number,
) => Promise<Uint8Array | null>;

export interface TilesApiOptions {
  /** Directory holding `<area>.pmtiles` archives and their `<area>.poly` coverage. */
  tilesDir: string;
  /** Upstream world source: `{z}/{x}/{y}` template or TileJSON URL. */
  worldTilesUrl?: string;
  /** Test seam: replaces the pmtiles-backed local reader. */
  localTiles?: LocalTileReader;
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
}

/**
 * pmtiles Source over a plain file path (the lib's FileSource wants a browser File).
 *
 * The handle is opened once and held for the source's lifetime — serving one
 * tile costs several range reads (header, directory, then the tile itself), and
 * open/close per read was the dominant syscall cost. Sources are discarded when
 * the archive is rebuilt, so `dispose()` closes the handle once any reads that
 * were already in flight have finished.
 */
export class NodeFileSource implements Source {
  private handle: Promise<FileHandle> | null = null;
  private inFlight = 0;
  private disposed = false;

  constructor(
    private filePath: string,
    private cacheKey: string,
  ) {}

  getKey(): string {
    return this.cacheKey;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    // A failed open must not be cached — the next request should retry.
    this.handle ??= open(this.filePath, 'r').catch((err: unknown) => {
      this.handle = null;
      throw err;
    });
    const handle = await this.handle;
    this.inFlight++;
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
      return { data };
    } finally {
      this.inFlight--;
      if (this.disposed && this.inFlight === 0) await handle.close().catch(() => {});
    }
  }

  /** Release the handle. Safe to call while reads are outstanding. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.inFlight > 0 || !this.handle) return;
    const handle = await this.handle.catch(() => null);
    await handle?.close().catch(() => {});
  }
}

/**
 * Lazily opened PMTiles readers per area. Archives are rebuilt in place on a
 * schedule, so each reader is keyed to the file's mtime+size and replaced
 * (fresh directory cache and all) when the file changes.
 */
function createPmtilesReader(tilesDir: string): LocalTileReader {
  const readers = new Map<string, { key: string; pmtiles: PMTiles; source: NodeFileSource }>();
  return async (area, z, x, y) => {
    const filePath = path.join(tilesDir, `${area}.pmtiles`);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return null; // no local archive for this area
    }
    const key = `${filePath}:${fileStat.mtimeMs}:${fileStat.size}`;
    let reader = readers.get(area);
    if (!reader || reader.key !== key) {
      // Hand the superseded source back its handle before dropping it.
      void reader?.source.dispose();
      const source = new NodeFileSource(filePath, key);
      reader = { key, pmtiles: new PMTiles(source), source };
      readers.set(area, reader);
    }
    const tile = await reader.pmtiles.getZxy(z, x, y);
    return tile ? new Uint8Array(tile.data) : null;
  };
}

/** Insertion-order LRU of gzipped upstream tiles, bounded by total bytes. */
class TileCache {
  private entries = new Map<string, Buffer>();
  private totalBytes = 0;

  get(key: string): Buffer | undefined {
    const value = this.entries.get(key);
    if (value) {
      // refresh recency
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: Buffer): void {
    if (this.entries.has(key)) return;
    this.entries.set(key, value);
    this.totalBytes += value.byteLength;
    for (const [oldKey, oldValue] of this.entries) {
      if (this.totalBytes <= CACHE_BUDGET_BYTES) break;
      this.entries.delete(oldKey);
      this.totalBytes -= oldValue.byteLength;
    }
  }
}

type UpstreamResult = { kind: 'hit'; gzipped: Buffer } | { kind: 'miss' } | { kind: 'error' };

export function registerTilesApi(app: FastifyInstance, opts: TilesApiOptions): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const localTiles = opts.localTiles ?? createPmtilesReader(opts.tilesDir);
  const worldTilesUrl = opts.worldTilesUrl ?? DEFAULT_WORLD_TILES_URL;
  const cache = new TileCache();

  // Coverage polygons, read once per area. A missing or unparseable file is a
  // permanent "unknown", which reads as covered — see the header.
  const coverageByArea = new Map<string, Promise<CoveragePolygon | null>>();
  function coverageFor(area: string): Promise<CoveragePolygon | null> {
    let entry = coverageByArea.get(area);
    if (!entry) {
      entry = readFile(path.join(opts.tilesDir, `${area}.poly`), 'utf8')
        .then((text) => parsePolyFile(text))
        .catch(() => null);
      coverageByArea.set(area, entry);
    }
    return entry;
  }

  // Point-in-polygon over a coastline as long as Norway's is far too much work
  // to repeat per request, and a map pans over the same tiles constantly.
  const coveredTiles = new Map<string, boolean>();
  const COVERED_TILES_MAX = 50_000;
  async function archiveCovers(area: string, z: number, x: number, y: number): Promise<boolean> {
    const coverage = await coverageFor(area);
    if (!coverage) return true;
    const key = `${area}/${z}/${x}/${y}`;
    const cached = coveredTiles.get(key);
    if (cached !== undefined) return cached;
    const covered = coverageIntersectsTile(coverage, z, x, y);
    if (coveredTiles.size >= COVERED_TILES_MAX) coveredTiles.clear();
    coveredTiles.set(key, covered);
    return covered;
  }

  // Resolved {z}/{x}/{y} template, re-resolved hourly (upstream tile URLs are
  // versioned). On failure the stale value is kept and retried after a minute.
  let template: { value: string | null; at: number } | null = null;
  let templateInflight: Promise<string | null> | null = null;
  async function upstreamTemplate(): Promise<string | null> {
    if (worldTilesUrl.includes('{z}')) return worldTilesUrl;
    if (template && Date.now() - template.at < TILEJSON_TTL_MS) return template.value;
    templateInflight ??= (async () => {
      try {
        const res = await fetchImpl(worldTilesUrl, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`tilejson: HTTP ${res.status}`);
        const tilejson = (await res.json()) as { tiles?: unknown };
        const tiles = Array.isArray(tilejson.tiles) ? tilejson.tiles : [];
        const value = typeof tiles[0] === 'string' && tiles[0].includes('{z}') ? tiles[0] : null;
        if (!value) throw new Error('tilejson: no {z}/{x}/{y} tile template');
        template = { value, at: Date.now() };
      } catch (err) {
        app.log.warn({ err, worldTilesUrl }, 'world tilejson unavailable');
        template = {
          value: template?.value ?? null,
          at: Date.now() - TILEJSON_TTL_MS + TILEJSON_RETRY_MS,
        };
      } finally {
        templateInflight = null;
      }
      return template.value;
    })();
    return templateInflight;
  }

  async function fetchUpstream(z: number, x: number, y: number): Promise<UpstreamResult> {
    const tmpl = await upstreamTemplate();
    if (!tmpl) return { kind: 'error' };
    const url = tmpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const cached = cache.get(url);
    if (cached) return { kind: 'hit', gzipped: cached };
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 204 || res.status === 404) return { kind: 'miss' };
      if (!res.ok) {
        app.log.warn({ url, status: res.status }, 'world tile upstream error');
        return { kind: 'error' };
      }
      // fetch has already undone the transfer Content-Encoding; re-gzip once
      // and keep the compressed form (it's also what gets served).
      const gzipped = gzipSync(Buffer.from(await res.arrayBuffer()));
      cache.set(url, gzipped);
      return { kind: 'hit', gzipped };
    } catch (err) {
      app.log.warn({ err, url }, 'world tile upstream unreachable');
      return { kind: 'error' };
    }
  }

  app.get<{ Params: { area: string; z: string; x: string; y: string } }>(
    '/api/tiles/:area/:z/:x/:y.pbf',
    async (request, reply) => {
      const { area } = request.params;
      const z = Number(request.params.z);
      const x = Number(request.params.x);
      const y = Number(request.params.y);
      const valid =
        /^[a-z0-9_-]+$/i.test(area) &&
        Number.isInteger(z) &&
        Number.isInteger(x) &&
        Number.isInteger(y) &&
        z >= 0 &&
        z <= 16 &&
        x >= 0 &&
        y >= 0 &&
        x < 2 ** z &&
        y < 2 ** z;
      if (!valid) return reply.code(400).send({ error: 'invalid tile coordinates' });

      const readLocal = () =>
        localTiles(area, z, x, y).catch((err: unknown) => {
          request.log.error({ err, area, z, x, y }, 'local tile read failed');
          return null;
        });

      // An overlay archive has no upstream equivalent, so it is read locally at
      // every zoom and never proxied.
      const overlay = OVERLAY_AREAS.has(area.toLowerCase());
      // Outside its own region the archive holds only global-source filler, so
      // it must not stand in for the world upstream at any zoom.
      const covers = overlay || (await archiveCovers(area, z, x, y));
      const localFirst = overlay || (z >= LOCAL_PREFERRED_MIN_ZOOM && covers);
      let plain: Uint8Array | null = null; // uncompressed MVT (local path)
      let gzipped: Buffer | null = null; // gzipped MVT (upstream path)
      let upstreamFailed = false;

      if (localFirst) plain = await readLocal();
      if (!plain && !overlay) {
        const upstream = await fetchUpstream(z, x, y);
        if (upstream.kind === 'hit') gzipped = upstream.gzipped;
        else {
          if (upstream.kind === 'error') upstreamFailed = true;
          // Upstream miss/failure: the local archive may still cover this
          // tile (low-zoom tiles inside the region, or an offline upstream).
          if (!localFirst && covers) plain = await readLocal();
        }
      }

      if (!gzipped && plain) gzipped = gzipSync(Buffer.from(plain));
      if (!gzipped) {
        if (upstreamFailed) return reply.code(502).send({ error: 'world tiles unavailable' });
        return reply.code(204).send();
      }

      void reply
        .header('content-type', 'application/x-protobuf')
        .header('cache-control', 'public, max-age=3600')
        .header('vary', 'accept-encoding');
      const acceptsGzip = /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
      if (acceptsGzip) return reply.header('content-encoding', 'gzip').send(gzipped);
      return reply.send(gunzipSync(gzipped));
    },
  );
}
