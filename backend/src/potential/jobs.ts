import type { PotentialCellState } from '@atlas/potential';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cellId, parseCellId, type Cell } from './cells.js';
import { deriveCell, readManifest } from './derive.js';
import type { PotentialContext } from './inputs.js';
import type { DeriveModel } from './models.js';

/**
 * The derive queue: persisted, small, and deliberately slow.
 *
 * Modelled on `RegionJobManager` — jobs are JSON files under the data dir, so a
 * deploy resumes queued work instead of dropping it mid-cell. Concurrency is 2:
 * a cell is four upstream requests and a second of arithmetic, and these are
 * public services on someone else's budget (the DATA-SOURCES ground rules), so
 * the throughput knob is turned down on purpose.
 */

const MAX_QUEUE = 40;
/**
 * Repairs may only fill part of the queue. A country's worth of cells can go
 * degraded in one outage, and every viewport that opens afterwards offers a few
 * more of them; leaving room means a user who pans somewhere new never waits
 * behind maintenance.
 */
const MAX_REPAIR_QUEUE = 8;
/**
 * How long a finished job record lingers. Short, because the *manifest* is the
 * durable artefact — this record only exists to answer "is it being worked on?".
 * A failure lingers as long, so a client learns why instead of silently
 * re-queueing the same broken cell in a loop.
 */
const RECORD_TTL_MS = 10 * 60_000;

export type DeriveJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface DeriveJob {
  /** `<layer>:<target>:<z>/<x>/<y>` — one job per cell per target. */
  readonly key: string;
  readonly layer: string;
  readonly target: string;
  readonly cell: string;
  status: DeriveJobStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  /**
   * A re-derive of a cell that already exists, because an upstream it was built
   * without is answering again (ROADMAP N7 → health.ts). Two consequences: it
   * must **not** take the "already derived" short-circuit, and it waits behind
   * every fresh cell — someone staring at a blank viewport outranks the quiet
   * improvement of a surface already on their screen.
   */
  repair?: boolean;
}

export interface DeriveQueueOptions {
  concurrency?: number;
  now?: () => number;
}

const jobKey = (layer: string, target: string, cell: Cell): string =>
  `${layer}:${target}:${cellId(cell)}`;

/** Job keys carry slashes and colons; the file name must not. */
const fileNameFor = (key: string): string => `${key.replace(/[^a-z0-9]+/gi, '_')}.json`;

export class DeriveQueue {
  private readonly jobs = new Map<string, DeriveJob>();
  private readonly jobsDir: string;
  private readonly concurrency: number;
  private readonly now: () => number;
  private running = 0;
  private closing = false;
  private pumping: Promise<void> | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly models: readonly DeriveModel[],
    private readonly ctx: PotentialContext,
    options: DeriveQueueOptions = {},
  ) {
    this.jobsDir = path.join(dataDir, 'potential', 'jobs');
    this.concurrency = options.concurrency ?? 2;
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    for (const name of await readdir(this.jobsDir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try {
        const job = JSON.parse(await readFile(path.join(this.jobsDir, name), 'utf8')) as DeriveJob;
        if (!job.key) continue;
        // A job that was mid-flight when the process died is queued again: the
        // derive is idempotent (a cell is rewritten whole), so re-running it is
        // always safe and losing the work is not.
        if (job.status === 'running') job.status = 'queued';
        if (this.expired(job)) {
          await rm(path.join(this.jobsDir, name), { force: true });
          continue;
        }
        this.jobs.set(job.key, job);
      } catch {
        await rm(path.join(this.jobsDir, name), { force: true });
      }
    }
    this.pump();
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.pumping;
  }

  private expired(job: DeriveJob): boolean {
    return (
      (job.status === 'done' || job.status === 'failed') &&
      this.now() - job.updatedAt > RECORD_TTL_MS
    );
  }

  get(layer: string, target: string, cell: Cell): DeriveJob | undefined {
    const job = this.jobs.get(jobKey(layer, target, cell));
    if (job && this.expired(job)) {
      this.jobs.delete(job.key);
      void rm(path.join(this.jobsDir, fileNameFor(job.key)), { force: true });
      return undefined;
    }
    return job;
  }

  get pending(): number {
    return this.active().length;
  }

  /** Queued or running — everything that is still going to change. */
  private active(): DeriveJob[] {
    return [...this.jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running');
  }

  /**
   * Ask for a cell. Returns the job now responsible for it, or null when the
   * queue is full — a full queue is a normal answer ("try again shortly"), not
   * an error, and the client's pill already has a place to say so.
   */
  request(
    layer: string,
    target: string,
    cell: Cell,
    options: { repair?: boolean } = {},
  ): DeriveJob | null {
    const key = jobKey(layer, target, cell);
    const existing = this.get(layer, target, cell);
    if (existing) {
      const busy = existing.status === 'queued' || existing.status === 'running';
      // A failed job is retried on a fresh request: the usual cause is an
      // upstream blip, and the user asking again is exactly the signal to try
      // once more. A **repair** also re-queues over a `done` record — that
      // record describes the derive it exists to replace, and mistaking it for
      // work in progress is how a repair would silently never run for the ten
      // minutes a finished job lingers.
      if (busy || (existing.status === 'done' && !options.repair)) return existing;
    }
    const active = this.active();
    if (active.length >= MAX_QUEUE) return null;
    if (options.repair && active.filter((j) => j.repair).length >= MAX_REPAIR_QUEUE) return null;
    const at = this.now();
    const job: DeriveJob = {
      key,
      layer,
      target,
      cell: cellId(cell),
      status: 'queued',
      createdAt: at,
      updatedAt: at,
      ...(options.repair ? { repair: true } : {}),
    };
    this.jobs.set(key, job);
    void this.persist(job);
    this.pump();
    return job;
  }

  private async persist(job: DeriveJob): Promise<void> {
    const file = path.join(this.jobsDir, fileNameFor(job.key));
    try {
      await mkdir(this.jobsDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(job, null, 2));
      await rename(tmp, file);
    } catch (err) {
      this.ctx.log.warn({ err, job: job.key }, 'derive job persist failed');
    }
  }

  /**
   * Start working, on the next turn rather than this one.
   *
   * The deferral is the contract, not an optimisation: `request()` answers with
   * the job it just created, and draining inline meant that job came back
   * already `running` — before a single byte had been fetched — purely because
   * the caller happened to arrive when no pump was in flight. So the state a
   * client saw for a brand-new cell depended on event-loop timing. One
   * microtask makes it always `queued`, which is both true and stable.
   * `this.pumping` is still assigned synchronously, so `close()` waits for the
   * deferred drain the same as before, and `worker()` re-checks `closing`.
   */
  private pump(): void {
    if (this.closing) return;
    this.pumping ??= Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.pumping = undefined;
        if (!this.closing && [...this.jobs.values()].some((j) => j.status === 'queued'))
          this.pump();
      });
  }

  private async drain(): Promise<void> {
    const workers: Promise<void>[] = [];
    for (let i = this.running; i < this.concurrency; i++) workers.push(this.worker());
    await Promise.all(workers);
  }

  private async worker(): Promise<void> {
    this.running++;
    try {
      for (;;) {
        if (this.closing) return;
        const next = [...this.jobs.values()]
          .filter((j) => j.status === 'queued')
          // Fresh cells first, oldest of them first. A repair improves a surface
          // that is already drawn; a fresh cell is someone looking at nothing.
          .sort(
            (a, b) =>
              Number(a.repair ?? false) - Number(b.repair ?? false) || a.createdAt - b.createdAt,
          )[0];
        if (!next) return;
        await this.run(next);
      }
    } finally {
      this.running--;
    }
  }

  private async run(job: DeriveJob): Promise<void> {
    const model = this.models.find((m) => m.layer === job.layer);
    const cell = parseCellId(job.cell);
    if (!model || !cell) {
      await this.finish(job, 'failed', 'unknown layer or cell');
      return;
    }
    job.status = 'running';
    job.updatedAt = this.now();
    await this.persist(job);
    try {
      // Another worker (or an earlier run) may have finished this cell while the
      // job sat in the queue. A repair is the one case that must derive anyway:
      // its whole purpose is to replace the manifest that is already there.
      const already = await readManifest(this.dataDir, model, job.target, cell);
      if (!already || job.repair) {
        await deriveCell(this.dataDir, model, job.target, cell, this.ctx, {
          ...(job.repair ? { repairAttempt: (already?.repairs ?? 0) + 1 } : {}),
        });
      }
      await this.finish(job, 'done');
    } catch (err) {
      this.ctx.log.warn({ err, job: job.key }, 'derive failed');
      await this.finish(job, 'failed', err instanceof Error ? err.message : String(err));
    }
  }

  private async finish(job: DeriveJob, status: DeriveJobStatus, error?: string): Promise<void> {
    job.status = status;
    job.updatedAt = this.now();
    if (error) job.error = error.slice(0, 200);
    await this.persist(job);
  }
}

/**
 * What a client needs to know about one cell of a requested area. **The shape is
 * the wire contract** — same as `CellManifest`, it lives in `@atlas/potential`
 * and is only named here, so a field added for one side cannot go missing on the
 * other.
 */
export type CellState = PotentialCellState;
