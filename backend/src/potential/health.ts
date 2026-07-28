import type { UpstreamHealth } from '@atlas/core';
import type { PotentialCellManifest } from '@atlas/potential';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { StatusRegistry } from '../status.js';
import { cellDir } from './derive.js';
import { inputProbeId } from './inputs.js';
import { DERIVE_MODELS, type DeriveModel } from './models.js';

/**
 * The derived cells' own health (ROADMAP § N7 → "probe the derived cells, not
 * just their inputs").
 *
 * A cell is derived once and then served forever. That is right for the
 * arithmetic — it does not change — but wrong for the *inputs*: a cell built
 * during an upstream outage records "the surveyed-areas layer did not answer"
 * and keeps that gap for good, because nothing re-derives a cell on its own.
 * It happened the day the hunt surface shipped, minutes after the deploy, and
 * the surface it left behind is indistinguishable from a correct one.
 *
 * Two mechanisms here, doing two different jobs:
 *
 * - **`repairVerdict`** decides when to re-derive one degraded cell. The
 *   question it must get right is *not* "how long has it been?" but "is the
 *   upstream this cell missed answering again?" — and the thing that knows that
 *   is the N7 sweep, not the cell. So the gate is the status registry (fast
 *   recovery: a cell degraded for a week repairs minutes after the source
 *   returns) and the backoff is only there for the case the gate cannot see —
 *   an upstream that is healthy for the probe's reference request and still
 *   fails for this particular cell. Each does one job; neither is a substitute
 *   for the other.
 * - **`cellCensus`** counts what is on disk for the status page, so the gaps
 *   are *visible* rather than inferred from a map that looks fine.
 *
 * Repairs are queued where someone is looking (`/prepare`), never by a
 * background sweep over the whole country: a cell nobody opens costs nothing by
 * staying degraded, and re-deriving Norway the moment an upstream recovers is
 * exactly the stampede the derive queue's concurrency of 2 exists to prevent.
 */

/**
 * Shortest gap between two derives of the same cell. Chosen against the outage
 * that prompted this: `kart.miljodirektoratet.no` refused connections for
 * several minutes, so half an hour is comfortably past the blip while still
 * being the same session for whoever is looking at the map.
 */
export const REPAIR_FLOOR_MS = 30 * 60_000;

/**
 * The backoff's ceiling. A daily retry of a cell that keeps coming back
 * incomplete is not hammering anyone, and giving up entirely would mean a cell
 * that can never heal — the exact failure this whole file exists to end.
 */
export const REPAIR_MAX_BACKOFF_MS = 24 * 60 * 60_000;

/**
 * How many failed repairs make a cell *stuck* rather than merely unlucky.
 *
 * Two, because one can be an outage that ended between the sweep and the
 * derive. Past that, the upstream has been reported healthy twice and this cell
 * still cannot read it — which is a real "someone should look", and the only
 * thing the census is willing to raise a warning about.
 */
export const STUCK_REPAIRS = 2;

export function repairBackoffMs(repairs: number): number {
  return Math.min(REPAIR_MAX_BACKOFF_MS, REPAIR_FLOOR_MS * 2 ** Math.max(0, repairs));
}

/** The inputs this cell was built without. */
export function failedInputs(manifest: PotentialCellManifest): readonly string[] {
  return manifest.inputs.filter((r) => !r.ok).map((r) => r.id);
}

export interface RepairVerdict {
  readonly repair: boolean;
  /** One line for the log: why this cell is, or is not, being re-derived. */
  readonly reason: string;
}

/**
 * Should this ready cell be derived again?
 *
 * `healthOf` is the N7 registry's verdict for one source id. Only `ok` opens the
 * gate: `down` and `unknown` are the states where a retry would just re-record
 * the same gap, and **`degraded` is deliberately refused too** — a degraded
 * source is one whose answers are not to be trusted, and replacing an
 * incomplete surface with a wrong one is a worse trade than waiting.
 */
export function repairVerdict(
  manifest: PotentialCellManifest,
  healthOf: (probeId: string) => UpstreamHealth,
  now: number,
): RepairVerdict {
  const failed = failedInputs(manifest);
  if (failed.length === 0) return { repair: false, reason: 'whole' };

  const waited = Math.max(0, now - manifest.derivedAt);
  const backoff = repairBackoffMs(manifest.repairs ?? 0);
  if (waited < backoff) {
    return {
      repair: false,
      reason: `backing off (${Math.round((backoff - waited) / 60_000)} min)`,
    };
  }

  for (const input of failed) {
    const probe = inputProbeId(input);
    // An input the sweep does not cover can never be declared healthy, so its
    // cells would repair on the backoff alone. probes.test.ts asserts this
    // cannot happen; the guard is here so it degrades to "leave it alone".
    if (!probe) return { repair: false, reason: `${input} has no probe` };
    const health = healthOf(probe);
    if (health !== 'ok') return { repair: false, reason: `${probe} is ${health}` };
  }
  return { repair: true, reason: `${failed.join(', ')} answering again` };
}

// ---- the census -----------------------------------------------------------

export interface CellCensus {
  /** Cells on disk at the current model and engine revisions. */
  readonly cells: number;
  /** …of which carry at least one failed input. */
  readonly degraded: number;
  /** …of which have been repaired `STUCK_REPAIRS` times and still have a gap. */
  readonly stuck: number;
  /** The missing inputs, worst first, by label as the manifest recorded them. */
  readonly missing: readonly string[];
}

/** A cell dir holds `cell/<x>/<y>.json`; anything else there is not a manifest. */
async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Count the derived cells and their gaps.
 *
 * Walks the *current* revision of each declared model and target only — an old
 * `v1.2` directory beside `v2.2` is arithmetic nothing serves any more, and
 * counting it would report gaps in surfaces no user can reach.
 */
export async function cellCensus(
  dataDir: string,
  models: readonly DeriveModel[] = DERIVE_MODELS,
): Promise<CellCensus> {
  let cells = 0;
  let degraded = 0;
  let stuck = 0;
  const missing = new Map<string, number>();

  for (const model of models) {
    for (const target of model.targets) {
      const root = path.join(cellDir(dataDir, model, target.value), 'cell');
      for (const x of await subdirs(root)) {
        const entries = await readdir(path.join(root, x)).catch(() => []);
        for (const name of entries) {
          if (!name.endsWith('.json')) continue;
          const raw = await readFile(path.join(root, x, name), 'utf8').catch(() => null);
          if (raw === null) continue;
          let manifest: PotentialCellManifest;
          try {
            manifest = JSON.parse(raw) as PotentialCellManifest;
          } catch {
            continue;
          }
          cells++;
          const failed = manifest.inputs?.filter((r) => !r.ok) ?? [];
          if (failed.length === 0) continue;
          degraded++;
          if ((manifest.repairs ?? 0) >= STUCK_REPAIRS) stuck++;
          for (const record of failed) {
            missing.set(record.label, (missing.get(record.label) ?? 0) + 1);
          }
        }
      }
    }
  }

  return {
    cells,
    degraded,
    stuck,
    missing: [...missing.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label),
  };
}

/** The status-page row the census writes to. */
export const CELL_CENSUS_ID = 'potential-cells';

/**
 * Report the census on the status page.
 *
 * The detail line always states the count; the **warning** is raised only for
 * *stuck* cells, and that restraint is the point. A cell degraded by an ordinary
 * outage adds nothing a human can act on — the upstream's own row is already red
 * — and painting the whole instance yellow for it is the cry-wolf failure N7 has
 * now learned twice. A cell that has been retried against a healthy upstream and
 * still cannot read it is a different animal.
 */
export function recordCellCensus(status: StatusRegistry, census: CellCensus): void {
  if (!status.has(CELL_CENSUS_ID)) {
    status.register(CELL_CENSUS_ID, 'Derived potential cells', 'Map data');
  }
  status.record(CELL_CENSUS_ID, true);
  const gaps =
    census.degraded === 0
      ? 'no gaps'
      : `${census.degraded} with a gap (${census.missing.join(', ')})`;
  status.setDetail(CELL_CENSUS_ID, `${census.cells} derived, ${gaps}`);
  status.warn(
    CELL_CENSUS_ID,
    census.stuck === 0
      ? null
      : `${census.stuck} cell${census.stuck === 1 ? '' : 's'} still missing ${census.missing.join(', ')} after ${STUCK_REPAIRS} repairs`,
  );
}

/**
 * The census as the app's local status refresh uses it: cached briefly, because
 * opening the status page must stay free and the answer only changes when a
 * derive finishes.
 */
export function createCensusReporter(
  dataDir: string,
  options: { maxAgeMs?: number; models?: readonly DeriveModel[] } = {},
): (status: StatusRegistry, now?: number) => Promise<void> {
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  let cached: { at: number; census: CellCensus } | null = null;
  return async (status, now = Date.now()) => {
    if (!cached || now - cached.at >= maxAgeMs) {
      cached = { at: now, census: await cellCensus(dataDir, options.models) };
    }
    recordCellCensus(status, cached.census);
  };
}
