import { layerOptionSignature } from '@atlas/core';
import Jimp from 'jimp-compact';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  // (so their paths are byte-identical to before). It is only ever built from
  // values `resolveOptions` has already reduced to the catalog's own choices —
  // raw query input must never reach a path segment.
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

  app.get<{
    Params: { id: string; z: string; x: string; y: string };
    Querystring: Record<string, string | undefined>;
  }>('/api/overlay/:id/:z/:x/:y.png', async (request, reply) => {
    const layer = byId.get(request.params.id);
    if (!layer) return reply.code(404).send({ error: 'unknown layer' });
    // Vector layers (arcgis-vector) have no raster tiles — they answer at
    // `/features`. Clients that honour `LayerMeta.vector` never ask here; this
    // just refuses a hand-typed tile URL rather than mis-reading the upstream.
    if (layer.upstream.kind !== 'wms' && layer.upstream.kind !== 'xyz') {
      return reply.code(404).send({ error: 'layer has no raster tiles' });
    }
    const z = Number(request.params.z);
    const x = Number(request.params.x);
    const y = Number(request.params.y);
    const valid =
      Number.isInteger(z) &&
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      z >= 0 &&
      z <= layer.meta.maxzoom &&
      x >= 0 &&
      y >= 0 &&
      x < 2 ** z &&
      y < 2 ** z;
    if (!valid) return reply.code(400).send({ error: 'invalid tile coordinates' });

    const serveImage = (
      data: Buffer,
      contentType = 'image/png',
      cacheControl = `public, max-age=${TILE_MAX_AGE_S}`,
    ) => reply.header('content-type', contentType).header('cache-control', cacheControl).send(data);

    const chosen = resolveOptions(layer, request.query);
    const file = cachePath(layer.meta.id, layer.meta.rev, layerOptionSignature(chosen), z, x, y);
    const diskCache = layer.upstream.kind !== 'xyz' || layer.upstream.cache !== 'upstream';
    const cached = diskCache ? await readFile(file).catch(() => null) : null;
    if (cached) return serveImage(cached);

    const upstream =
      layer.upstream.kind === 'wms'
        ? wmsBaseParams(
            layer.upstream,
            z,
            x,
            y,
            256 * Math.max(1, Math.round(layer.upstream.renderScale ?? 1)),
          )
        : xyzUrl(layer.upstream.template, z, x, y);
    if (layer.upstream.kind === 'wms') {
      upstream.searchParams.set('REQUEST', 'GetMap');
      for (const [key, value] of Object.entries(layer.upstream.getMapParams ?? {})) {
        upstream.searchParams.set(key, value);
      }
      for (const [key, value] of Object.entries(optionGetMapParams(layer, chosen))) {
        upstream.searchParams.set(key, value);
      }
    }

    try {
      const missingEtag =
        layer.upstream.kind === 'xyz' && layer.upstream.missingTile === 'arcgis-etag'
          ? await arcgisMissingEtag(layer.meta.id, layer.upstream.template)
          : null;
      const res = await fetchImpl(upstream, {
        signal: AbortSignal.timeout(15_000),
        ...(missingEtag ? { headers: { 'if-none-match': missingEtag } } : {}),
      });
      if (res.status === 304) {
        // Esri has no tile at this detail level. Synthesize the correctly
        // aligned child from its real parent so the client keeps one raster
        // source: genuine z19 imagery still wins where it exists, while gaps
        // behave exactly like MapLibre overzooming z18.
        ctx.record(layer.meta.id, true);
        const xyzLayer = layer.upstream.kind === 'xyz' ? layer.upstream : null;
        const fallbackZoom = xyzLayer?.fallbackMaxzoom;
        if (xyzLayer && fallbackZoom !== undefined && fallbackZoom >= 0 && fallbackZoom < z) {
          const divisions = 2 ** (z - fallbackZoom);
          const parentUrl = xyzUrl(
            xyzLayer.template,
            fallbackZoom,
            Math.floor(x / divisions),
            Math.floor(y / divisions),
          );
          const parent = await fetchImpl(parentUrl, {
            signal: AbortSignal.timeout(15_000),
            ...(missingEtag ? { headers: { 'if-none-match': missingEtag } } : {}),
          });
          const parentType = parent.headers.get('content-type') ?? '';
          if (parent.ok && parentType.startsWith('image/')) {
            const overzoomed = await overzoomParentTile(
              Buffer.from(await parent.arrayBuffer()),
              z,
              x,
              y,
              fallbackZoom,
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
      const contentType = res.headers.get('content-type') ?? '';
      // The upstream answered either way — a non-image ServiceException means
      // "no data here", not "service down", so both count as reachable.
      ctx.record(layer.meta.id, true);
      if (!contentType.startsWith('image/')) {
        // A 200 with XML is a ServiceException (out of coverage, bad layer,
        // …): serve a transparent tile so the map shows blank, not broken —
        // short-lived so recovery isn't cached away.
        const body = (await res.text()).slice(0, 300);
        request.log.warn({ layer: layer.meta.id, contentType, body }, 'overlay non-image reply');
        return serveImage(TRANSPARENT_PNG, 'image/png', 'public, max-age=60');
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (diskCache) {
        await writeCache(file, data);
        return serveImage(data, contentType);
      }
      // Preserve only the cache behaviour the imagery provider granted. An
      // absent header becomes no-store rather than Atlas inventing permission.
      const cacheControl = res.headers.get('cache-control') ?? 'no-store';
      return serveImage(data, contentType, cacheControl);
    } catch (err) {
      request.log.error({ err, layer: layer.meta.id }, 'overlay upstream unreachable');
      ctx.record(layer.meta.id, false, 'unreachable');
      return reply.code(502).send({ error: 'overlay unavailable' });
    }
  });
}
