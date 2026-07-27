import type { LngLatBbox } from '@atlas/core';
import { thinSpots, type PotentialSpot } from '@atlas/potential';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { StatusRegistry } from '../status.js';
import {
  CELL_MAX_TILE_ZOOM,
  CELL_ZOOM,
  cellAt,
  cellForTile,
  cellId,
  cellsForBbox,
  inNorway,
  parseCellId,
  type Cell,
} from './cells.js';
import { readManifest, tilePath } from './derive.js';
import { explainSample, loadSignals, sampleIndexAt } from './explain.js';
import type { PotentialContext } from './inputs.js';
import { DERIVE_MODELS, deriveModel, resolveTarget, type DeriveModel } from './models.js';
import { DeriveQueue, type CellState } from './jobs.js';
import { cellCandidates, describeCandidate, spotsNote, walkAccess, SPOT_LIMIT } from './spots.js';

/**
 * The derived-potential HTTP surface (ROADMAP § N5 → E2, E3).
 *
 * Six routes, and the shape of them is the design:
 *
 * - `GET  /api/potential/layers` — which models this build can derive, and what
 *   each can be tuned for. A client never invents a target.
 * - `POST /api/potential/prepare` — "I am looking here": queue the cells under a
 *   viewport and answer with each one's state. This is what the preparation pill
 *   renders, and it is a POST because it starts work.
 * - `GET  /api/potential/:layer/:target/:z/:x/:y.png` — a derived tile.
 * - `GET  /api/potential/:layer/:target/cell/:x/:y.json` — a cell's manifest:
 *   the coverage verdict and the provenance of every input behind it.
 * - `GET  /api/potential/:layer/:target/explain?lat=&lng=` — why *this point*
 *   scores what it does, in the same factor shape the weather card renders.
 * - `GET  /api/potential/:layer/:target/spots?bbox=` — the numbered shortlist
 *   for what is on screen, each with its reason and its walk in from the road.
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
  /**
   * Valhalla base URL, for the walk in from the nearest road on a spot.
   *
   * Optional on purpose: without it the shortlist still lists spots and simply
   * says nothing about access, which is the same degradation an unreachable
   * router gets. A missing walk time must never cost the feature.
   */
  valhallaUrl?: string;
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
        // `working` must count only what is still *going to* change, because a
        // client polls while it is above zero. A failed cell is terminal until
        // something asks for it again, so counting it here left the preparation
        // pill announcing "1 of 2 areas" forever and re-asking every couple of
        // seconds — found by driving the real map, not by a test.
        working: states.filter((s) => s.status === 'queued' || s.status === 'running').length,
        failed: states.filter((s) => s.status === 'failed').length,
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

  /**
   * "Why is this water good?" — D4's *nothing scores without saying why*, at one
   * point.
   *
   * The answer is assembled from the signal planes the derive persisted, not
   * recomputed: re-running the model here would be both slow and a second
   * implementation that could drift from the one that drew the pixels. The
   * headline number is the **rank within this cell**, never a fake absolute —
   * "top 4 % of this area" is the only claim the model can honestly make.
   */
  app.get<{
    Params: { layer: string; target: string };
    Querystring: { lat?: string; lng?: string };
  }>('/api/potential/:layer/:target/explain', async (request, reply) => {
    const model = byLayer(request.params.layer);
    if (!model) return reply.code(404).send({ error: 'unknown layer' });
    const lat = Number(request.query.lat);
    const lng = Number(request.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85) {
      return reply.code(400).send({ error: 'invalid point' });
    }
    const target = resolveTarget(model, request.params.target);
    const cell = cellAt(lat, lng);
    const manifest = await readManifest(opts.dataDir, model, target, cell);
    if (!manifest) {
      const state = await stateOf(model, target, cell, false);
      return reply.code(404).send({ error: 'cell not derived', state });
    }

    const { sx, sy } = sampleIndexAt(manifest, { lat, lng });

    const shared = {
      cell: manifest.cell,
      layer: model.layer,
      target,
      vocabulary: model.vocabulary,
      tier: manifest.tier,
      // The gate's verdict travels with every answer: on a surface with no
      // standout, "top 3 %" means nothing and the client must be able to say so.
      standout: manifest.contrast.standout,
      contrast: manifest.contrast.reason,
      notes: manifest.notes,
      inputs: manifest.inputs,
    };

    const blob = await loadSignals(opts.dataDir, model, target, cell, manifest);
    if (!blob) {
      return reply.header('cache-control', 'no-cache').send({
        ...shared,
        score: null,
        factors: [],
        missing: [],
        summary: manifest.contrast.reason,
      });
    }
    const explanation = explainSample(model, target, manifest, blob, sx, sy);
    return reply.header('cache-control', 'no-cache').send({ ...shared, ...explanation });
  });

  /**
   * "Where do I go tonight?" — the numbered shortlist for what is on screen
   * (E6). Read-only over the cells `/prepare` already built: a viewport with
   * nothing derived answers `pending`, never a queue of fresh derives, because
   * panning with the list open would otherwise be a load generator.
   */
  app.get<{
    Params: { layer: string; target: string };
    Querystring: { bbox?: string; limit?: string };
  }>(
    '/api/potential/:layer/:target/spots',
    // Each answer can cost two router calls, so it is capped like /prepare.
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const model = byLayer(request.params.layer);
      if (!model) return reply.code(404).send({ error: 'unknown layer' });
      const bbox = parseBbox(request.query.bbox?.split(','));
      if (!bbox) return reply.code(400).send({ error: 'invalid bbox' });
      const target = resolveTarget(model, request.params.target);
      const requested = Number(request.query.limit);
      const limit = Number.isInteger(requested)
        ? Math.max(1, Math.min(SPOT_LIMIT, requested))
        : SPOT_LIMIT;

      const cells = cellsForBbox(bbox);
      const manifests = await Promise.all(
        cells.map(async (cell) => ({
          cell,
          manifest: await readManifest(opts.dataDir, model, target, cell),
        })),
      );
      const derived = manifests.filter((entry) => entry.manifest !== null);
      const flat = derived.filter((entry) => !entry.manifest!.contrast.standout).length;

      // Candidates from every standout cell, then one geographic merge: cells
      // are derived independently, so a lake straddling two of them offers the
      // same bay twice until they are compared in metres.
      const candidates = (
        await Promise.all(
          derived.map(async (entry) => {
            const manifest = entry.manifest!;
            const blob = await loadSignals(opts.dataDir, model, target, entry.cell, manifest);
            if (!blob) return [];
            return cellCandidates(manifest, blob, entry.cell, bbox, limit).map((candidate) => ({
              candidate,
              manifest,
              blob,
            }));
          }),
        )
      ).flat();

      const chosen = thinSpots(
        candidates.map((c) => ({ ...c, position: c.candidate.position, rank: c.candidate.rank })),
        { limit },
      );
      const spots: PotentialSpot[] = chosen.map((c) =>
        describeCandidate(c.candidate, c.manifest, c.blob, model, target),
      );

      // Walk-in times last, and never fatal: a shortlist without them is still
      // the feature, and the router is a separate service that can be down.
      const access = opts.valhallaUrl
        ? await walkAccess(
            spots.map((spot) => spot.position),
            { valhallaUrl: opts.valhallaUrl, fetchImpl: ctx.fetchImpl, log: ctx.log },
          )
        : null;
      const withAccess = spots.map((spot, i) => ({ ...spot, access: access?.[i] ?? null }));

      const pending = cells.length - derived.length;
      return reply.header('cache-control', 'no-cache').send({
        layer: model.layer,
        target,
        vocabulary: model.vocabulary,
        spots: withAccess,
        pending,
        flat,
        accessAvailable: access !== null,
        note: spotsNote({
          spots: withAccess.length,
          pending,
          flat,
          derived: derived.length,
          hunt: model.vocabulary === 'hunt',
        }),
      });
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
