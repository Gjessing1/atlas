import { createGrid } from '@atlas/potential';
import type { PotentialCellManifest, PotentialInputRecord } from '@atlas/potential';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from './cells.js';
import { deriveCell, manifestPath, readManifest, type CellManifest } from './derive.js';
import {
  cellCensus,
  recordCellCensus,
  repairBackoffMs,
  repairVerdict,
  REPAIR_FLOOR_MS,
  REPAIR_MAX_BACKOFF_MS,
  CELL_CENSUS_ID,
} from './health.js';
import { registerPotentialApi } from './index.js';
import type { PotentialContext } from './inputs.js';
import type { DeriveModel } from './models.js';
import { StatusRegistry } from '../status.js';

/**
 * A cell derived through an outage keeps the gap for good — unless something
 * notices (ROADMAP § N7). These tests pin the two halves of that: when one
 * degraded cell is worth deriving again, and what the status page is told about
 * all of them.
 */

const CELL: Cell = { z: 11, x: 1083, y: 596 };
/** A viewport well inside that one cell, so a prepare queues exactly it. */
const VIEW = [10.42, 59.855, 10.425, 59.858];

const log = { warn: () => {} };

/** The lake register's answer, and the one input the model below reads. */
const LAKE = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [10.418, 59.856],
        [10.424, 59.856],
        [10.424, 59.861],
        [10.418, 59.861],
        [10.418, 59.856],
      ],
    ],
  },
  properties: { vatnlnr: 5504, navn: 'Semsvannet', hoyde: 148, objekttype: 'Innsjø' },
};

/** Set to make the next derive throw — a pipeline failure, not a missing input. */
let modelThrows = false;

/**
 * One input, one blob, no terrain: the surface these tests draw is irrelevant —
 * what matters is whether the *record* of the input says it answered.
 */
const model: DeriveModel = {
  layer: 'repairable',
  label: 'Repairable',
  targets: [{ value: 'only', label: 'Only' }],
  catalog: false,
  rev: 1,
  inputs: { lakes: true },
  vocabulary: 'fishing',
  run: (inputs) => {
    if (modelThrows) throw new Error('boom');
    const { size, cellSizeM } = inputs.raster;
    const score = createGrid(size, size, cellSizeM, Number.NaN);
    for (let y = 400; y < 700; y++) {
      for (let x = 400; x < 700; x++) {
        score.data[y * size + x] = x < 550 ? 0.2 : 0.9;
      }
    }
    return { score, notes: [], absolute: 0.6 };
  },
};

const record = (over: Partial<PotentialInputRecord> = {}): PotentialInputRecord => ({
  id: 'lakes',
  label: 'Lake register',
  source: 'NVE Innsjødatabase2 layer 5',
  ok: true,
  detail: '1 lake',
  cached: false,
  fetchedAt: 1,
  ...over,
});

const manifestWith = (over: Partial<CellManifest> = {}): CellManifest =>
  ({
    cell: '11/1083/596',
    layer: 'repairable',
    target: 'only',
    rev: 1,
    engineRev: 2,
    derivedAt: 0,
    cellSizeM: 9.6,
    bounds: [10.4, 59.8, 10.6, 59.9],
    inputs: [record()],
    contrast: { standout: true, validCells: 100, spread: 0.4, reason: 'ok' },
    tier: null,
    notes: [],
    coverage: 0.5,
    etag: 'abc',
    vocabulary: 'fishing',
    signals: null,
    ...over,
  }) as CellManifest;

const HOUR = 60 * 60_000;

describe('repairVerdict', () => {
  const ok = () => 'ok' as const;

  it('leaves a whole cell alone', () => {
    expect(repairVerdict(manifestWith(), ok, HOUR).repair).toBe(false);
  });

  it('re-derives a degraded cell once its upstream answers again', () => {
    const manifest = manifestWith({ inputs: [record({ ok: false, detail: 'ECONNREFUSED' })] });
    const verdict = repairVerdict(manifest, ok, HOUR);
    expect(verdict.repair).toBe(true);
    expect(verdict.reason).toContain('lakes');
  });

  /**
   * The gate is the whole design: a cell must not be re-derived against an
   * upstream that is still down, because the retry would only re-record the same
   * gap — and it must not be re-derived against a *degraded* one either, since
   * replacing an incomplete surface with a wrong one is the worse trade.
   */
  it.each(['down', 'unknown', 'degraded'] as const)('waits while its input is %s', (health) => {
    const manifest = manifestWith({ inputs: [record({ ok: false })] });
    const verdict = repairVerdict(manifest, () => health, HOUR);
    expect(verdict.repair).toBe(false);
    expect(verdict.reason).toContain(health);
  });

  it('holds off until the floor has passed, whatever the upstream says', () => {
    const manifest = manifestWith({ derivedAt: HOUR, inputs: [record({ ok: false })] });
    expect(repairVerdict(manifest, ok, HOUR + REPAIR_FLOOR_MS - 1).repair).toBe(false);
    expect(repairVerdict(manifest, ok, HOUR + REPAIR_FLOOR_MS).repair).toBe(true);
  });

  /**
   * The backoff exists for the case the gate cannot see: an upstream healthy for
   * the probe's reference request that still fails for this one cell. Without it
   * every prepare would re-derive the same cell for as long as someone looks at
   * the map.
   */
  it('slows down a cell that keeps coming back incomplete, and never gives up', () => {
    expect(repairBackoffMs(0)).toBe(REPAIR_FLOOR_MS);
    expect(repairBackoffMs(1)).toBe(2 * REPAIR_FLOOR_MS);
    expect(repairBackoffMs(3)).toBe(8 * REPAIR_FLOOR_MS);
    expect(repairBackoffMs(99)).toBe(REPAIR_MAX_BACKOFF_MS);

    const tried = manifestWith({ repairs: 2, inputs: [record({ ok: false })] });
    expect(repairVerdict(tried, ok, 3 * REPAIR_FLOOR_MS).repair).toBe(false);
    expect(repairVerdict(tried, ok, 4 * REPAIR_FLOOR_MS).repair).toBe(true);
  });

  it('leaves an input the sweep does not cover alone rather than retrying blind', () => {
    const manifest = manifestWith({ inputs: [record({ id: 'nonesuch', ok: false })] });
    expect(repairVerdict(manifest, ok, HOUR)).toMatchObject({ repair: false });
  });

  it('needs every missing input back, not just one', () => {
    const manifest = manifestWith({
      inputs: [record({ ok: false }), record({ id: 'terrain', ok: false })],
    });
    const verdict = repairVerdict(manifest, (id) => (id === 'input:dtm' ? 'down' : 'ok'), HOUR);
    expect(verdict).toMatchObject({ repair: false, reason: 'input:dtm is down' });
  });
});

// ---- disk-backed halves ---------------------------------------------------

describe('the derived cells on disk', () => {
  let dataDir: string;
  let cacheDir: string;
  let ctx: PotentialContext;
  let status: StatusRegistry;
  let broken = false;

  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
    if (broken) {
      const err = new Error('fetch failed');
      (err as Error & { cause?: unknown }).cause = { code: 'ECONNRESET' };
      return Promise.reject(err);
    }
    return Promise.resolve(
      new Response(JSON.stringify({ type: 'FeatureCollection', features: [LAKE] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-repair-'));
    cacheDir = await mkdtemp(path.join(tmpdir(), 'atlas-repair-cache-'));
    status = new StatusRegistry();
    broken = false;
    modelThrows = false;
    fetchImpl.mockClear();
    ctx = {
      fetchImpl,
      cacheDir,
      userAgent: 'atlas-test',
      record: (id, ok, message) => status.record(id, ok, message),
      log,
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });

  /** Age a cell past its backoff without waiting half an hour. */
  const age = async (target = 'only', by = REPAIR_FLOOR_MS + 1000): Promise<void> => {
    const file = manifestPath(dataDir, model, target, CELL);
    const manifest = JSON.parse(await readFile(file, 'utf8')) as PotentialCellManifest;
    await writeFile(
      file,
      JSON.stringify({ ...manifest, derivedAt: manifest.derivedAt - by }, null, 2),
    );
  };

  describe('census', () => {
    it('counts what is derived, what has a gap, and what is stuck', async () => {
      broken = true;
      await deriveCell(dataDir, model, 'only', CELL, ctx);
      const degraded = await cellCensus(dataDir, [model]);
      expect(degraded).toMatchObject({ cells: 1, degraded: 1, stuck: 0 });
      expect(degraded.missing).toEqual(['Lake register']);

      // Two failed repairs later, the same cell is a "someone should look".
      await deriveCell(dataDir, model, 'only', CELL, ctx, { repairAttempt: 2 });
      expect(await cellCensus(dataDir, [model])).toMatchObject({ degraded: 1, stuck: 1 });

      broken = false;
      await deriveCell(dataDir, model, 'only', CELL, ctx, { repairAttempt: 3 });
      expect(await cellCensus(dataDir, [model])).toMatchObject({
        cells: 1,
        degraded: 0,
        stuck: 0,
        missing: [],
      });
    });

    it('ignores cells left behind by an older revision', async () => {
      // The stale one first: the input cache is shared across revisions, so a
      // successful derive would hand its copy to the "broken" one.
      const stale = { ...model, rev: model.rev - 1 };
      broken = true;
      await deriveCell(dataDir, stale, 'only', CELL, ctx);
      broken = false;
      await deriveCell(dataDir, model, 'only', CELL, ctx);
      // Both are on disk; only the current revision is served, so only it counts.
      expect(await cellCensus(dataDir, [model])).toMatchObject({ cells: 1, degraded: 0 });
      expect(await cellCensus(dataDir, [stale])).toMatchObject({ cells: 1, degraded: 1 });
    });

    /**
     * The cry-wolf rule, applied to our own artefacts: an ordinary outage leaves
     * degraded cells and its upstream's row is already red, so warning about them
     * too would paint the instance yellow for something nobody can act on. Only a
     * cell that survived repairs against a *healthy* upstream earns a warning.
     */
    it('states the gap in the detail line but only warns about a stuck cell', () => {
      const row = () => status.toStatus().find((s) => s.id === CELL_CENSUS_ID)!;

      recordCellCensus(status, { cells: 12, degraded: 0, stuck: 0, missing: [] });
      expect(row()).toMatchObject({ health: 'ok', warning: null });
      expect(row().detail).toBe('12 derived, no gaps');

      recordCellCensus(status, { cells: 12, degraded: 3, stuck: 0, missing: ['Land cover'] });
      expect(row()).toMatchObject({ health: 'ok', warning: null });
      expect(row().detail).toContain('3 with a gap (Land cover)');

      recordCellCensus(status, { cells: 12, degraded: 3, stuck: 3, missing: ['Land cover'] });
      expect(row().health).toBe('degraded');
      expect(row().warning).toContain('3 cells still missing Land cover');
    });
  });

  describe('repair through /prepare', () => {
    let app: FastifyInstance;

    const prepare = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/potential/prepare',
          payload: { layer: 'repairable', target: 'only', bbox: VIEW },
        })
      ).json() as {
        cells: { cell: string; status: string; repairing?: boolean }[];
        ready: number;
        working: number;
        repairing: number;
      };

    const settle = async (): Promise<PotentialCellManifest> => {
      let manifest: PotentialCellManifest | null = null;
      await vi.waitFor(
        async () => {
          const job = queue.get('repairable', 'only', CELL);
          expect(job?.status === 'done' || job?.status === 'failed').toBe(true);
          manifest = await readManifest(dataDir, model, 'only', CELL);
          expect(manifest).not.toBeNull();
        },
        { timeout: 20_000, interval: 50 },
      );
      return manifest!;
    };

    let queue: Awaited<ReturnType<typeof registerPotentialApi>>;

    beforeEach(async () => {
      app = Fastify({ logger: false });
      queue = await registerPotentialApi(app, {
        dataDir,
        cacheDir,
        fetchImpl,
        status,
        models: [model],
        concurrency: 1,
      });
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    /** The whole point, end to end: outage → gap on disk → recovery → whole cell. */
    it('heals a cell once the upstream it missed is answering again', async () => {
      broken = true;
      await prepare();
      const first = await settle();
      expect(first.inputs.every((r) => r.ok)).toBe(false);

      // Still down: the map is looked at again and nothing is re-derived.
      await age();
      expect((await prepare()).repairing).toBe(0);

      // The N7 sweep finds the source back. Now the gap is worth another ask.
      broken = false;
      status.record('input:lake-register', true);
      const asked = await prepare();
      expect(asked.repairing).toBe(1);
      // A repair is not "not ready": the surface it already has stays on screen.
      expect(asked.cells[0]).toMatchObject({ status: 'ready', repairing: true });
      expect(asked.working).toBe(0);
      expect(asked.ready).toBe(1);

      const healed = await settle();
      expect(healed.inputs.every((r) => r.ok)).toBe(true);
      expect(healed.repairs).toBeUndefined();
      // The re-derive really replaced the artefacts, rather than short-circuiting
      // on the manifest that was already there.
      expect(healed.derivedAt).toBeGreaterThan(first.derivedAt);
    });

    it('counts a repair that failed again, and then backs off', async () => {
      broken = true;
      await prepare();
      await settle();
      await age();

      // The sweep says the source is fine; this cell still cannot read it.
      status.record('input:lake-register', true);
      expect((await prepare()).repairing).toBe(1);
      const retried = await settle();
      expect(retried.repairs).toBe(1);

      // Asking again immediately must not queue a third derive: the cell was
      // just tried, and the floor is what stops a viewport becoming a loop.
      status.record('input:lake-register', true);
      expect((await prepare()).repairing).toBe(0);
      expect(queue.get('repairable', 'only', CELL)?.status).toBe('done');
    });

    /**
     * The poll loop this would otherwise be: a repair that throws rewrites
     * nothing, so the manifest still looks due, and the client is polling every
     * 2.5 s *because* a repair is in flight.
     */
    it('does not queue another repair while a failed one is remembered', async () => {
      broken = true;
      await prepare();
      await settle();
      await age();

      status.record('input:lake-register', true);
      modelThrows = true;
      expect((await prepare()).repairing).toBe(1);
      await vi.waitFor(() => expect(queue.get('repairable', 'only', CELL)?.status).toBe('failed'), {
        timeout: 20_000,
        interval: 50,
      });

      // Three more looks at the same map: the cell is left alone and the client
      // is told nothing is coming, so it stops asking.
      for (let i = 0; i < 3; i++) {
        const body = await prepare();
        expect(body.repairing).toBe(0);
        expect(body.cells[0]!.status).toBe('ready');
      }
      expect(queue.get('repairable', 'only', CELL)?.status).toBe('failed');
    });

    it('never repairs a cell that is whole', async () => {
      await prepare();
      const first = await settle();
      expect(first.inputs.every((r) => r.ok)).toBe(true);
      await age();
      const aged = (await readManifest(dataDir, model, 'only', CELL))!.derivedAt;
      status.record('input:lake-register', true);
      expect((await prepare()).repairing).toBe(0);
      // Untouched: nothing re-derived it, so the aged stamp is still there.
      expect((await readManifest(dataDir, model, 'only', CELL))!.derivedAt).toBe(aged);
    });
  });
});
