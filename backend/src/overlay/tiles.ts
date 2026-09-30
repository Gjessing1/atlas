import { layerOptionSignature } from '@atlas/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Jimp from 'jimp-compact';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  rasterBandAtZoom,
  type CompositeRasterUpstream,
  type OverlayLayer,
  type RasterUpstream,
} from './catalog.js';
import type { OverlayContext } from './context.js';
import { optionGetMapParams, resolveOptions } from './options.js';
import { substituteEnv, wmsBaseParams } from './wms.js';

/**
 * The raster tile proxy: /api/overlay/:id/:z/:x/:y.png converts z/x/y to a WMS
 * GetMap request in EPSG:3857 (or fills in an XYZ template). Government layers
 * are cached on disk; sources marked `cache: upstream` remain streaming and
 * only pass through the cache lifetime their HTTP response permits.
 */

/** 1×1 fully transparent PNG — the "blank ≠ broken" fallback tile. */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);

const TILE_MAX_AGE_S = 7 * 24 * 3600; // upstream data changes on the order of months

/** Content type for a cached image whose upstream headers are no longer present. */
function imageContentType(data: Buffer): string {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

/** Classic dark-sky map progression, sampled by the VIIRS tile's luminance. */
const LIGHT_PALETTE = [
  [0, 0, 0, 0, 0],
  [8, 40, 18, 92, 82],
  [24, 18, 64, 156, 125],
  [56, 0, 151, 190, 155],
  [96, 55, 190, 82, 180],
  [144, 241, 218, 48, 205],
  [192, 245, 116, 24, 225],
  [232, 204, 28, 44, 240],
  [255, 255, 255, 255, 248],
] as const;

/**
 * Turn GIBS' black/white radiance image into a readable overlay. Black becomes
 * transparent so the base map remains legible; increasing radiance follows the
 * familiar World-Atlas/Lorenz blue → green → yellow → red → white sequence.
 * It remains a radiance proxy — colour does not invent Bortle classes.
 */
export async function colorizeLightPollutionTile(data: Buffer): Promise<Buffer> {
  const image = await Jimp.read(data);
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, (_x, _y, offset) => {
    const pixels = image.bitmap.data;
    const sourceAlpha = pixels[offset + 3] ?? 255;
    const value = Math.round(
      pixels[offset]! * 0.2126 + pixels[offset + 1]! * 0.7152 + pixels[offset + 2]! * 0.0722,
    );
    let upper = LIGHT_PALETTE.findIndex((stop) => stop[0] >= value);
    if (upper <= 0) upper = 1;
    const low = LIGHT_PALETTE[upper - 1]!;
    const high = LIGHT_PALETTE[Math.min(upper, LIGHT_PALETTE.length - 1)]!;
    const mix = high[0] === low[0] ? 0 : (value - low[0]) / (high[0] - low[0]);
    for (let channel = 1; channel <= 4; channel += 1) {
      pixels[offset + channel - 1] = Math.round(
        low[channel]! + (high[channel]! - low[channel]!) * mix,
      );
    }
    // Preserve upstream transparency (normally opaque, but part of the source contract).
    pixels[offset + 3] = Math.round((pixels[offset + 3]! * sourceAlpha) / 255);
  });
  return image.getBufferAsync(Jimp.MIME_PNG);
}

async function overzoomParentTile(
  parent: Buffer,
  z: number,
  x: number,
  y: number,
  parentZoom: number,
): Promise<{ data: Buffer; contentType: string }> {
  const divisions = 2 ** (z - parentZoom);
  const cropSize = 256 / divisions;
  if (!Number.isInteger(cropSize) || cropSize < 1) throw new Error('unsupported overzoom depth');
  const image = await Jimp.read(parent);
  if (image.bitmap.width !== 256 || image.bitmap.height !== 256) {
    throw new Error('unexpected parent tile dimensions');
  }
  const contentType = image.getMIME();
  const cropped = image
    .crop((x % divisions) * cropSize, (y % divisions) * cropSize, cropSize, cropSize)
    .resize(256, 256, Jimp.RESIZE_BILINEAR);
  if (contentType === Jimp.MIME_JPEG) cropped.quality(90);
  return { data: await cropped.getBufferAsync(contentType), contentType };
}

/**
 * Whether a small image is entirely transparent.
 *
 * Kartverket answers requests outside Norway with a valid 334-byte transparent
 * PNG, not a ServiceException. Only composite sources with a declared fallback
 * call this, and the size guard means ordinary photographic tiles never pay a
 * decode cost. A tiny but genuinely inked image remains the primary result.
 */
async function isTransparentTile(data: Buffer): Promise<boolean> {
  if (data.length > 4096) return false;
  try {
    const image = await Jimp.read(data);
    let transparent = true;
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, (_x, _y, offset) => {
      if (image.bitmap.data[offset + 3] !== 0) transparent = false;
    });
    return transparent;
  } catch {
    return false;
  }
}

/**
 * How far up the pyramid a missing tile may look for real imagery. Eight is
 * the geometric limit — a z(n+8) tile is a single pixel of its z(n) ancestor —
 * and what open sea needs: Esri stops at z13 offshore, and z19 is six levels on.
 */
const MAX_ANCESTOR_DEPTH = 8;

export function registerTileRoute(ctx: OverlayContext): void {
  const { app, byId, env, fetchImpl } = ctx;
  const arcgisMissingEtags = new Map<string, Promise<string | null>>();

  const xyzUrl = (template: string, z: number, x: number, y: number) =>
    new URL(
      substituteEnv(template, env)
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y)),
    );

  /**
   * ArcGIS cached map services answer a missing tile with an opaque JPEG and
   * HTTP 200. The service documents level -1 / row 0 / column 0 as a guaranteed
   * miss whose ETag can be used in If-None-Match requests; learn it once per
   * process instead of hard-coding Esri's current sentinel value.
   */
  function arcgisMissingEtag(id: string, template: string): Promise<string | null> {
    const existing = arcgisMissingEtags.get(id);
    if (existing) return existing;
    const pending = (async () => {
      const url = xyzUrl(template, -1, 0, 0);
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
        return response.ok ? response.headers.get('etag') : null;
      } catch (err) {
        app.log.warn({ err, layer: id }, 'could not learn ArcGIS missing-tile ETag');
        return null;
      }
    })();
    arcgisMissingEtags.set(id, pending);
    return pending;
  }

  // `variant` is a layer-option signature, empty for the layers that have none
  // (so their paths are byte-identical to before), or `offline` for the pack
  // source — which no signature can spell, since every one contains a dash. It
  // is only ever built from values `resolveOptions` has already reduced to the
  // catalog's own choices — raw query input must never reach a path segment.
  const cachePath = (id: string, rev: number, variant: string, z: number, x: number, y: number) =>
    path.join(
      ctx.cacheDir,
      id,
      `v${rev}`,
      ...(variant ? [variant] : []),
      String(z),
      String(x),
      `${y}.png`,
    );

  async function writeCache(file: string, data: Buffer): Promise<void> {
    // Temp-file + rename so a concurrent reader never sees a half tile; cache
    // failures only cost a re-fetch, so they log instead of failing the request.
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch (err) {
      app.log.warn({ err, file }, 'overlay tile cache write failed');
    }
  }

  type TileParams = { id: string; z: string; x: string; y: string };
  type TileRequest = FastifyRequest<{
    Params: TileParams;
    Querystring: Record<string, string | undefined>;
  }>;

  /** Parsed coordinates, or null for anything outside `0..maxzoom`. */
  function tileCoordinates(params: TileParams, maxzoom: number) {
    const z = Number(params.z);
    const x = Number(params.x);
    const y = Number(params.y);
    const valid =
      Number.isInteger(z) &&
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      z >= 0 &&
      z <= maxzoom &&
      x >= 0 &&
      y >= 0 &&
      x < 2 ** z &&
      y < 2 ** z;
    return valid ? { z, x, y } : null;
  }

  /**
   * One raster tile of `upstream` for `layer`, through the disk cache when every
   * source the zoom can reach allows it. Shared by the live route and the
   * offline-pack route, which differ only in which sources they read and where
   * their cache lives.
   */
  async function serveRaster(
    request: TileRequest,
    reply: FastifyReply,
    layer: OverlayLayer,
    upstream: RasterUpstream | CompositeRasterUpstream,
    variant: (chosen: Record<string, string>) => string,
    tile: { z: number; x: number; y: number },
    opaque = false,
  ) {
    const { z, x, y } = tile;
    const serveImage = (
      data: Buffer,
      contentType = 'image/png',
      cacheControl = `public, max-age=${TILE_MAX_AGE_S}`,
    ) => reply.header('content-type', contentType).header('cache-control', cacheControl).send(data);

    const band = rasterBandAtZoom(upstream, z);
    if (!band) return reply.code(404).send({ error: 'layer has no raster tiles at this zoom' });

    const chosen = resolveOptions(layer, request.query);
    const file = cachePath(layer.meta.id, layer.meta.rev, variant(chosen), z, x, y);
    const sources = [band.primary, ...(band.fallback ? [band.fallback] : [])];
    const diskCache = sources.every(
      (source) => source.kind !== 'xyz' || source.cache !== 'upstream',
    );
    const cached = diskCache ? await readFile(file).catch(() => null) : null;
    if (cached) return serveImage(cached, imageContentType(cached));

    const upstreamUrl = (source: RasterUpstream, at = tile): URL => {
      const url =
        source.kind === 'wms'
          ? wmsBaseParams(
              source,
              at.z,
              at.x,
              at.y,
              256 * Math.max(1, Math.round(source.renderScale ?? 1)),
            )
          : xyzUrl(source.template, at.z, at.x, at.y);
      if (source.kind === 'wms') {
        url.searchParams.set('REQUEST', 'GetMap');
        for (const [key, value] of Object.entries(source.getMapParams ?? {})) {
          url.searchParams.set(key, value);
        }
        for (const [key, value] of Object.entries(optionGetMapParams(layer, chosen))) {
          url.searchParams.set(key, value);
        }
        if (opaque) {
          url.searchParams.set('FORMAT', 'image/jpeg');
          url.searchParams.set('TRANSPARENT', 'FALSE');
        }
      }
      return url;
    };

    const fetchSource = async (source: RasterUpstream, at = tile) => {
      const missingEtag =
        source.kind === 'xyz' && source.missingTile === 'arcgis-etag'
          ? await arcgisMissingEtag(layer.meta.id, source.template)
          : null;
      return fetchImpl(upstreamUrl(source, at), {
        signal: AbortSignal.timeout(15_000),
        ...(missingEtag ? { headers: { 'if-none-match': missingEtag } } : {}),
      });
    };

    try {
      let active = band.primary;
      let res: Response;
      try {
        res = await fetchSource(active);
      } catch (err) {
        if (!band.fallback) throw err;
        request.log.warn(
          { err, layer: layer.meta.id },
          'overlay primary unreachable, trying its fallback',
        );
        active = band.fallback;
        res = await fetchSource(active);
      }

      let contentType = res.headers.get('content-type') ?? '';
      let prefetched: Buffer | null = null;
      if (band.fallback && active === band.primary && res.ok && contentType.startsWith('image/')) {
        prefetched = Buffer.from(await res.arrayBuffer());
      }
      // A 304 is the primary saying "no tile at this depth", which its own
      // ancestors answer better than a different source would (below).
      const useFallback =
        band.fallback &&
        active === band.primary &&
        res.status !== 304 &&
        (!res.ok ||
          !contentType.startsWith('image/') ||
          (prefetched !== null && (await isTransparentTile(prefetched))));
      if (useFallback && band.fallback) {
        // Kartverket answers outside Norway with a fully transparent PNG rather
        // than a WMS ServiceException, and an upstream error is no picture
        // either: try the declared fallback before ordinary error/blank
        // handling below.
        if (!prefetched) await res.body?.cancel();
        active = band.fallback;
        res = await fetchSource(active);
        contentType = res.headers.get('content-type') ?? '';
        prefetched = null;
      }

      if (res.status === 304) {
        // Esri has no tile at this depth here. Walk up to the nearest ancestor
        // that exists and serve the aligned part of it, enlarged — genuine
        // detail still wins wherever it exists, and a gap behaves like
        // MapLibre overzooming the last real level instead of a blank square.
        ctx.record(layer.meta.id, true);
        if (active.kind === 'xyz') {
          for (let depth = 1; depth <= Math.min(MAX_ANCESTOR_DEPTH, z); depth++) {
            const divisions = 2 ** depth;
            const at = {
              z: z - depth,
              x: Math.floor(x / divisions),
              y: Math.floor(y / divisions),
            };
            const parent = await fetchSource(active, at);
            if (parent.status === 304) continue;
            const parentType = parent.headers.get('content-type') ?? '';
            if (!parent.ok || !parentType.startsWith('image/')) {
              await parent.body?.cancel();
              break;
            }
            const overzoomed = await overzoomParentTile(
              Buffer.from(await parent.arrayBuffer()),
              z,
              x,
              y,
              at.z,
            );
            return serveImage(
              overzoomed.data,
              overzoomed.contentType,
              res.headers.get('cache-control') ?? parent.headers.get('cache-control') ?? 'no-store',
            );
          }
        }
        return serveImage(TRANSPARENT_PNG, 'image/png', 'public, max-age=60');
      }
      if (!res.ok) {
        request.log.error({ layer: layer.meta.id, status: res.status }, 'overlay upstream error');
        ctx.record(layer.meta.id, false, `HTTP ${res.status}`);
        return reply.code(502).send({ error: 'overlay unavailable' });
      }
      if (!contentType.startsWith('image/')) {
        // A 200 with XML is a ServiceException (out of coverage, bad layer,
        // …): serve a transparent tile so the map shows blank, not broken —
        // short-lived so recovery isn't cached away.
        //
        // Deliberately records *nothing*. From here the two readings are
        // indistinguishable: panning past the edge of a healthy layer's
        // coverage looks exactly like a layer that has been withdrawn, because
        // the same ServiceException carries both. The probe can tell them
        // apart — it asks at a point the layer is known to draw
        // (`probes.ts`) — so this path must not overwrite its verdict.
        // It used to record `true` here, which meant one map pan over a dead
        // layer silently repainted the status row green and kept it there:
        // last writer wins, and ordinary traffic always writes last.
        const body = (await res.text()).slice(0, 300);
        request.log.warn({ layer: layer.meta.id, contentType, body }, 'overlay non-image reply');
        return serveImage(TRANSPARENT_PNG, 'image/png', 'public, max-age=60');
      }
      // A real image is unambiguous: the upstream is serving this layer.
      ctx.record(layer.meta.id, true);
      let data: Buffer<ArrayBufferLike> = prefetched ?? Buffer.from(await res.arrayBuffer());
      let servedType = contentType;
      if (active.kind === 'xyz' && active.transform === 'light-pollution-palette') {
        data = await colorizeLightPollutionTile(data);
        servedType = 'image/png';
      }
      if (diskCache) {
        await writeCache(file, data);
        return serveImage(data, servedType);
      }
      // Preserve only the cache behaviour the imagery provider granted. An
      // absent header becomes no-store rather than Atlas inventing permission.
      const cacheControl = res.headers.get('cache-control') ?? 'no-store';
      return serveImage(data, servedType, cacheControl);
    } catch (err) {
      request.log.error({ err, layer: layer.meta.id }, 'overlay upstream unreachable');
      ctx.record(layer.meta.id, false, 'unreachable');
      return reply.code(502).send({ error: 'overlay unavailable' });
    }
  }

  app.get<{
    Params: TileParams;
    Querystring: Record<string, string | undefined>;
  }>('/api/overlay/:id/:z/:x/:y.png', async (request, reply) => {
    const layer = byId.get(request.params.id);
    if (!layer) return reply.code(404).send({ error: 'unknown layer' });
    // Vector layers (arcgis-vector, point-feed) have no raster tiles — they answer at
    // `/features`. Clients that honour `LayerMeta.vector` never ask here; this
    // just refuses a hand-typed tile URL rather than mis-reading the upstream.
    const upstream = layer.upstream;
    if (upstream.kind === 'arcgis-vector' || upstream.kind === 'point-feed') {
      return reply.code(404).send({ error: 'layer has no raster tiles' });
    }
    const tile = tileCoordinates(request.params, layer.meta.maxzoom);
    if (!tile) return reply.code(400).send({ error: 'invalid tile coordinates' });
    return serveRaster(request, reply, layer, upstream, layerOptionSignature, tile);
  });

  /**
   * The source an offline imagery pack is cut from (`OverlayLayer.offline`),
   * for `infrastructure/packs/build-imagery-pack.mjs`. Not a client route:
   * the app draws a downloaded pack, never these tiles. It exists so the
   * producer reads the mosaic through the same proxy, composition and disk
   * cache as everything else — a rebuild, or a resumed one, costs Kartverket
   * nothing it has already answered.
   */
  app.get<{
    Params: TileParams;
    Querystring: Record<string, string | undefined>;
  }>('/api/overlay/:id/offline/:z/:x/:y.png', async (request, reply) => {
    const layer = byId.get(request.params.id);
    if (!layer?.offline || !layer.meta.offlinePack) {
      return reply.code(404).send({ error: 'layer has no offline source' });
    }
    const tile = tileCoordinates(request.params, layer.meta.offlinePack.maxzoom);
    if (!tile) return reply.code(400).send({ error: 'invalid tile coordinates' });
    // `opaque=1` is the producer saying it already knows this tile lies wholly
    // inside the source's coverage (its parent had no transparent pixel there),
    // so a WMS may answer in JPEG. That is most of a pack, and the upstream's
    // encoder is several times faster than re-encoding PNGs here — the
    // difference between minutes and hours for a country. Cached apart from
    // the transparent PNGs, which remain the answer to everything else.
    const opaque = request.query['opaque'] === '1';
    return serveRaster(
      request,
      reply,
      layer,
      layer.offline,
      () => (opaque ? 'offline-opaque' : 'offline'),
      tile,
      opaque,
    );
  });
}
