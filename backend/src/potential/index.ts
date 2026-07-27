import type { LngLatBbox } from '@atlas/core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from '../status.js';
import {
  CELL_MAX_TILE_ZOOM,
  CELL_ZOOM,
  cellForTile,
  cellId,
  cellsForBbox,
  inNorway,
  parseCellId,
  type Cell,
} from './cells.js';
import { readManifest, tilePath } from './derive.js';
import type { PotentialContext } from './inputs.js';
import { DERIVE_MODELS, deriveModel, resolveTarget, type DeriveModel } from './models.js';
import { DeriveQueue, type CellState } from './jobs.js';

/**
 * The derived-potential HTTP surface (ROADMAP § N5 → E2).
 *
 * Four routes, and the shape of them is the design:
 *
 * - `GET  /api/potential/layers` — which models this build can derive, and what
 *   each can be tuned for. A client never invents a target.
 * - `POST /api/potential/prepare` — "I am looking here": queue the cells under a
 *   viewport and answer with each one's state. This is what the preparation pill
 *   renders, and it is a POST because it starts work.
 * - `GET  /api/potential/:layer/:target/:z/:x/:y.png` — a derived tile.
 * - `GET  /api/potential/:layer/:target/cell/:x/:y.json` — a cell's manifest:
 *   the coverage verdict and the provenance of every input behind it.
 *
 * **Caching is revalidating, not long-lived**, and that is the one thing here
 * that was learned the hard way rather than designed: a re-derive rewrites the
 * *same* URL, so the overlay proxy's `max-age=7d` would keep showing the old
 * surface until the TTL lapsed — and a hard reload does not help, because map
 * tiles load lazily after the page. So derived tiles carry a content ETag and
 * `no-cache`: the client still gets a 304 on an unchanged cell, but never a
 * stale surface.
 */

export interface PotentialApiOptions {
  /** Durable root for derived cells (`<dataDir>/potential`). */
  dataDir: string;
  /** Disposable root for cached upstream input responses. */
  cacheDir: string;
  /** Test seam: upstream HTTP. */
  fetchImpl?: typeof fetch;
  /** Identifying UA, as the Norwegian services ask for. */
  userAgent?: string;
  /** N7 status registry: the engine inputs are probed sources. */
  status?: StatusRegistry;
  /** Test seam: replaces the registered models. */
  models?: readonly DeriveModel[];
  /** Cells derived at once. Deliberately low — see DeriveQueue. */
  concurrency?: number;
}

/** 1×1 transparent PNG — a cell that is not ready yet renders as nothing. */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);

/** A bbox from the request body, or null. */
function parseBbox(raw: unknown): LngLatBbox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [w, s, e, n] = raw.map(Number);
  if ([w, s, e, n].some((v) => !Number.isFinite(v))) return null;
  if (w! >= e! || s! >= n!) return null;
  if (w! < -180 || e! > 180 || s! < -85 || n! > 85) return null;
  return [w!, s!, e!, n!];
}

export async function registerPotentialApi(
  app: FastifyInstance,
  opts: PotentialApiOptions,
): Promise<DeriveQueue> {
  const models = opts.models ?? DERIVE_MODELS;
  const status = opts.status;
  const ctx: PotentialContext = {
    fetchImpl: opts.fetchImpl ?? fetch,
    cacheDir: opts.cacheDir,
    userAgent:
      opts.userAgent ??
      process.env.GEONORGE_USER_AGENT ??
      'atlas-maps/1.0 git.gjessing.io/gjessing1/atlas lars@gjessing.io',
    record: (id, ok, message) => status?.record(id, ok, message),
    log: { warn: (obj, msg) => app.log.warn(obj, msg) },
  };
  const queue = new DeriveQueue(opts.dataDir, models, ctx, { concurrency: opts.concurrency });
  await queue.init();
  app.addHook('onClose', () => queue.close());

  const byLayer = (layer: string): DeriveModel | undefined =>
    opts.models ? opts.models.find((m) => m.layer === layer) : deriveModel(layer);

  app.get('/api/potential/layers', () => ({
    /** The pyramid a client may request; above it, overzoom the z13 tile. */
    cellZoom: CELL_ZOOM,
    maxTileZoom: CELL_MAX_TILE_ZOOM,
    layers: models.map((m) => ({
      layer: m.layer,
      label: m.label,
      rev: m.rev,
      targets: m.targets,
      vocabulary: m.vocabulary,
    })),
  }));

  /** State of one cell: ready (with its manifest), or whatever the queue says. */
  const stateOf = async (
    model: DeriveModel,
    target: string,
    cell: Cell,
    queueIt: boolean,
  ): Promise<CellState> => {
    const manifest = await readManifest(opts.dataDir, model, target, cell);
    if (manifest) return { cell: cellId(cell), status: 'ready', manifest };
    const existing = queue.get(model.layer, target, cell);
    if (existing) {
      return {
        cell: cellId(cell),
        status: existing.status,
        ...(existing.error ? { error: existing.error } : {}),
      };
    }
    if (!queueIt) return { cell: cellId(cell), status: 'queued' };
    const job = queue.request(model.layer, target, cell);
    // A full queue reads as "still queued": the client asks again, and nothing
    // about the answer is a failure the user needs to see.
    return { cell: cellId(cell), status: job?.status ?? 'queued' };
  };

  app.post<{ Body: { layer?: string; target?: string; bbox?: unknown } }>(
    '/api/potential/prepare',
    // Each call can queue work against public services, so it is capped well
    // below the global limit — a client polling the pill must not be able to
    // turn a pan into a hundred derives.
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const model = byLayer(request.body?.layer ?? '');
      if (!model) return reply.code(404).send({ error: 'unknown layer' });
      const bbox = parseBbox(request.body?.bbox);
      if (!bbox) return reply.code(400).send({ error: 'invalid bbox' });
      const target = resolveTarget(model, request.body?.target);
      const cells = cellsForBbox(bbox);
      // Outside Norway there is nothing to derive, and per the Norway-only
      // precedent that is an *absence*, not an error: an empty cell list with
      // the reason stated, so the client can say so plainly.
      const states = await Promise.all(cells.map((cell) => stateOf(model, target, cell, true)));
      return {
        layer: model.layer,
        target,
        cellZoom: CELL_ZOOM,
        cells: states,
        ready: states.filter((s) => s.status === 'ready').length,
        working: states.filter((s) => s.status !== 'ready').length,
        outsideCoverage: cells.length === 0,
      };
    },
  );

  app.get<{ Params: { layer: string; target: string; x: string; y: string } }>(
    '/api/potential/:layer/:target/cell/:x/:y.json',
    async (request, reply) => {
      const model = byLayer(request.params.layer);
      if (!model) return reply.code(404).send({ error: 'unknown layer' });
      const cell = parseCellId(`${CELL_ZOOM}/${request.params.x}/${request.params.y}`);
      if (!cell) return reply.code(400).send({ error: 'invalid cell' });
      const target = resolveTarget(model, request.params.target);
      const manifest = await readManifest(opts.dataDir, model, target, cell);
      if (!manifest) {
        const state = await stateOf(model, target, cell, false);
        return reply.code(404).send({ error: 'cell not derived', state });
      }
      return reply.header('cache-control', 'no-cache').send(manifest);
    },
  );

  app.get<{ Params: { layer: string; target: string; z: string; x: string; y: string } }>(
    '/api/potential/:layer/:target/:z/:x/:y.png',
    async (request, reply) => {
      const model = byLayer(request.params.layer);
      if (!model) return reply.code(404).send({ error: 'unknown layer' });
      const z = Number(request.params.z);
      const x = Number(request.params.x);
      const y = Number(request.params.y);
      const located = Number.isInteger(x) && Number.isInteger(y) ? cellForTile(z, x, y) : null;
      if (!located) return reply.code(400).send({ error: 'invalid tile coordinates' });
      const target = resolveTarget(model, request.params.target);

      /** Not derived (or outside Norway): draw nothing, and do not cache that. */
      const blank = () =>
        reply
          .header('content-type', 'image/png')
          .header('cache-control', 'no-store')
          .send(TRANSPARENT_PNG);

      if (!inNorway(located.cell)) return blank();
      const manifest = await readManifest(opts.dataDir, model, target, located.cell);
      if (!manifest) return blank();

      // Content ETag + no-cache: the client revalidates every time (cheap, a 304
      // is empty) and can therefore never be shown a surface that has since been
      // re-derived under the same URL.
      const etag = `"${manifest.etag}-${z}-${x}-${y}"`;
      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).header('etag', etag).header('cache-control', 'no-cache').send();
      }
      const file = tilePath(opts.dataDir, model, target, z, x, y);
      const png = await readFile(file).catch(() => null);
      if (!png) {
        // The manifest is written last, so this means the artefacts were removed
        // underneath us (a wiped data dir) rather than a half-finished derive.
        app.log.warn({ file }, 'derived tile missing for a manifested cell');
        return blank();
      }
      return reply
        .header('content-type', 'image/png')
        .header('etag', etag)
        .header('cache-control', 'no-cache')
        .send(png);
    },
  );

  return queue;
}

export { cellsForBbox, cellId, CELL_ZOOM } from './cells.js';
export { DERIVE_MODELS } from './models.js';
export const POTENTIAL_TILE_PREFIX = path.posix.join('/api/potential');
