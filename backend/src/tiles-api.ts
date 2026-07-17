import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';

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
 */

const DEFAULT_WORLD_TILES_URL = 'https://tiles.openfreemap.org/planet';
/** Below this zoom the (region-clipped) local tiles look broken; use upstream. */
const LOCAL_PREFERRED_MIN_ZOOM = 10;
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
  /** Directory holding `<area>.pmtiles` archives. */
  tilesDir: string;
  /** Upstream world source: `{z}/{x}/{y}` template or TileJSON URL. */
  worldTilesUrl?: string;
  /** Test seam: replaces the pmtiles-backed local reader. */
  localTiles?: LocalTileReader;
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
}

/** pmtiles Source over a plain file path (the lib's FileSource wants a browser File). */
class NodeFileSource implements Source {
  constructor(
    private filePath: string,
    private cacheKey: string,
  ) {}

  getKey(): string {
    return this.cacheKey;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const handle = await open(this.filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
      return { data };
    } finally {
      await handle.close();
    }
  }
}

/**
 * Lazily opened PMTiles readers per area. Archives are rebuilt in place on a
 * schedule, so each reader is keyed to the file's mtime+size and replaced
 * (fresh directory cache and all) when the file changes.
 */
function createPmtilesReader(tilesDir: string): LocalTileReader {
  const readers = new Map<string, { key: string; pmtiles: PMTiles }>();
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
      reader = { key, pmtiles: new PMTiles(new NodeFileSource(filePath, key)) };
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

      const localFirst = z >= LOCAL_PREFERRED_MIN_ZOOM;
      let plain: Uint8Array | null = null; // uncompressed MVT (local path)
      let gzipped: Buffer | null = null; // gzipped MVT (upstream path)
      let upstreamFailed = false;

      if (localFirst) plain = await readLocal();
      if (!plain) {
        const upstream = await fetchUpstream(z, x, y);
        if (upstream.kind === 'hit') gzipped = upstream.gzipped;
        else {
          if (upstream.kind === 'error') upstreamFailed = true;
          // Upstream miss/failure: the local archive may still cover this
          // tile (low-zoom tiles inside the region, or an offline upstream).
          if (!localFirst) plain = await readLocal();
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
