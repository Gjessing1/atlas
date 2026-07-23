import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OverlayContext } from './context.js';
import { substituteEnv, wmsBaseParams } from './wms.js';

/**
 * The raster tile proxy: /api/overlay/:id/:z/:x/:y.png converts z/x/y to a WMS
 * GetMap request in EPSG:3857 (or fills in an XYZ template) and caches the
 * result on disk. The cache dir is disposable — government topo data changes on
 * the order of months, so tiles are cached indefinitely and the directory can
 * be wiped freely.
 */

/** 1×1 fully transparent PNG — the "blank ≠ broken" fallback tile. */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);

const TILE_MAX_AGE_S = 7 * 24 * 3600; // upstream data changes on the order of months

export function registerTileRoute(ctx: OverlayContext): void {
  const { app, byId, env, fetchImpl } = ctx;

  const cachePath = (id: string, rev: number, z: number, x: number, y: number) =>
    path.join(ctx.cacheDir, id, `v${rev}`, String(z), String(x), `${y}.png`);

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

  app.get<{ Params: { id: string; z: string; x: string; y: string } }>(
    '/api/overlay/:id/:z/:x/:y.png',
    async (request, reply) => {
      const layer = byId.get(request.params.id);
      if (!layer) return reply.code(404).send({ error: 'unknown layer' });
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

      const servePng = (data: Buffer, maxAge = TILE_MAX_AGE_S) =>
        reply
          .header('content-type', 'image/png')
          .header('cache-control', `public, max-age=${maxAge}`)
          .send(data);

      const file = cachePath(layer.meta.id, layer.meta.rev, z, x, y);
      const cached = await readFile(file).catch(() => null);
      if (cached) return servePng(cached);

      const upstream =
        layer.upstream.kind === 'wms'
          ? wmsBaseParams(
              layer.upstream,
              z,
              x,
              y,
              256 * Math.max(1, Math.round(layer.upstream.renderScale ?? 1)),
            )
          : new URL(
              substituteEnv(layer.upstream.template, env)
                .replace('{z}', String(z))
                .replace('{x}', String(x))
                .replace('{y}', String(y)),
            );
      if (layer.upstream.kind === 'wms') upstream.searchParams.set('REQUEST', 'GetMap');

      try {
        const res = await fetchImpl(upstream, { signal: AbortSignal.timeout(15_000) });
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
          return servePng(TRANSPARENT_PNG, 60);
        }
        const data = Buffer.from(await res.arrayBuffer());
        await writeCache(file, data);
        return servePng(data);
      } catch (err) {
        request.log.error({ err, layer: layer.meta.id }, 'overlay upstream unreachable');
        ctx.record(layer.meta.id, false, 'unreachable');
        return reply.code(502).send({ error: 'overlay unavailable' });
      }
    },
  );
}
