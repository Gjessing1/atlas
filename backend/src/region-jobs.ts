import { constants as fsConstants, createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  BBox,
  CreateRegionPackJobRequest,
  RegionPackJob,
  RegionPackManifest,
} from '@atlas/core';
import type { FastifyBaseLogger } from 'fastify';

const MAX_AREA_KM2 = 30_000;
const MIN_AREA_KM2 = 1;
const MAX_ACTIVE_JOBS = 5;
const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RegionJobOptions {
  /** Test/deployment seam; production uses the go-pmtiles binary in the image. */
  extract?: (input: string, output: string, bbox: BBox, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export class RegionJobError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function finitePoint(value: unknown): value is { lat: number; lng: number } {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['lat'] === 'number' &&
    Number.isFinite(p['lat']) &&
    typeof p['lng'] === 'number' &&
    Number.isFinite(p['lng'])
  );
}

function validBbox(value: unknown): value is BBox {
  if (!value || typeof value !== 'object') return false;
  const bbox = value as { sw?: unknown; ne?: unknown };
  return (
    finitePoint(bbox.sw) &&
    finitePoint(bbox.ne) &&
    bbox.sw.lat >= -85 &&
    bbox.ne.lat <= 85 &&
    bbox.sw.lng >= -180 &&
    bbox.ne.lng <= 180 &&
    bbox.sw.lat < bbox.ne.lat &&
    bbox.sw.lng < bbox.ne.lng
  );
}

function bboxAreaKm2(bbox: BBox): number {
  const earthKm = 6371.0088;
  const dLng = ((bbox.ne.lng - bbox.sw.lng) * Math.PI) / 180;
  const south = (bbox.sw.lat * Math.PI) / 180;
  const north = (bbox.ne.lat * Math.PI) / 180;
  return earthKm * earthKm * Math.abs(Math.sin(north) - Math.sin(south)) * dLng;
}

/** Streamed lowercase-hex SHA-256 of a file (never loads the whole file). */
function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function contains(outer: BBox, inner: BBox): boolean {
  return (
    outer.sw.lat <= inner.sw.lat &&
    outer.sw.lng <= inner.sw.lng &&
    outer.ne.lat >= inner.ne.lat &&
    outer.ne.lng >= inner.ne.lng
  );
}

async function defaultExtract(
  input: string,
  output: string,
  bbox: BBox,
  signal: AbortSignal,
): Promise<void> {
  const bboxArg = `${bbox.sw.lng},${bbox.sw.lat},${bbox.ne.lng},${bbox.ne.lat}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pmtiles', ['extract', input, output, `--bbox=${bboxArg}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal,
    });
    let error = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      error = (error + chunk).slice(-4000);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`pmtiles extract exited ${code ?? 'without a status'}: ${error.trim()}`));
    });
  });
}

/**
 * One-process, persistent region queue. Jobs are JSON files under ATLAS_DATA_DIR,
 * so a deploy resumes queued/running work instead of losing it. Concurrency is
 * deliberately one: PMTiles extraction is light, but copying a routing pack is
 * disk-heavy and this host has other services to protect.
 */
export class RegionJobManager {
  private readonly jobs = new Map<string, RegionPackJob>();
  private running = false;
  private closing = false;
  private queueTask: Promise<void> | undefined;
  private extractionController: AbortController | undefined;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly extract: NonNullable<RegionJobOptions['extract']>;
  readonly jobsDir: string;
  readonly artifactsDir: string;

  constructor(
    private readonly dataDir: string,
    private readonly log: FastifyBaseLogger,
    options: RegionJobOptions = {},
  ) {
    this.jobsDir = path.join(dataDir, 'pack-jobs', 'jobs');
    this.artifactsDir = path.join(dataDir, 'pack-jobs', 'artifacts');
    this.now = options.now ?? Date.now;
    this.extract = options.extract ?? defaultExtract;
  }

  async init(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
    for (const name of await readdir(this.jobsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const job = JSON.parse(
          await readFile(path.join(this.jobsDir, name), 'utf8'),
        ) as RegionPackJob;
        if (!job.id || job.id !== name.slice(0, -5)) continue;
        if (
          (job.status === 'done' || job.status === 'failed') &&
          this.now() - job.updatedAt > ARTIFACT_TTL_MS
        ) {
          await rm(path.join(this.artifactsDir, job.id), { recursive: true, force: true });
          await rm(path.join(this.jobsDir, name), { force: true });
          continue;
        }
        if (job.status === 'extracting' || job.status === 'assembling') {
          job.status = 'queued';
          job.progress = 0;
          job.detail = 'Queued again after a server restart';
        }
        this.jobs.set(job.id, job);
      } catch (error) {
        this.log.warn({ error, name }, 'unreadable region job');
      }
    }
    this.schedule();
    this.cleanupTimer = setInterval(() => void this.expireOld(), 60_000);
    this.cleanupTimer.unref();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.extractionController?.abort();
    await this.queueTask;
  }

  get(id: string): RegionPackJob | undefined {
    const job = this.jobs.get(id);
    if (job && this.isExpired(job)) {
      this.jobs.delete(id);
      void this.removeJobFiles(id);
      return undefined;
    }
    return job;
  }

  async create(body: CreateRegionPackJobRequest): Promise<RegionPackJob> {
    const name = typeof body?.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 60) {
      throw new RegionJobError(400, 'name must be between 1 and 60 characters');
    }
    if (!validBbox(body?.bbox)) throw new RegionJobError(400, 'invalid bounding box');
    const area = bboxAreaKm2(body.bbox);
    if (area < MIN_AREA_KM2) {
      throw new RegionJobError(400, `region must cover at least ${MIN_AREA_KM2} km²`);
    }
    if (area > MAX_AREA_KM2) {
      throw new RegionJobError(400, `region is too large (maximum ${MAX_AREA_KM2} km²)`);
    }
    const active = [...this.jobs.values()].filter((job) =>
      ['queued', 'extracting', 'assembling'].includes(job.status),
    ).length;
    if (active >= MAX_ACTIVE_JOBS) {
      throw new RegionJobError(429, 'the region queue is full — try again later');
    }
    await this.enclosingPack(body.bbox);
    await stat(path.join(this.dataDir, 'tiles', 'norway.pmtiles')).catch(() => {
      throw new RegionJobError(503, 'the master basemap is not available');
    });
    const timestamp = this.now();
    const job: RegionPackJob = {
      id: `custom-${randomUUID()}`,
      name,
      bbox: body.bbox,
      status: 'queued',
      progress: 0,
      detail: 'Waiting for the region worker',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.jobs.set(job.id, job);
    await this.persist(job);
    this.schedule();
    return job;
  }

  private schedule(): void {
    if (this.queueTask || this.closing) return;
    this.queueTask = Promise.resolve()
      .then(() => this.runQueue())
      .catch((error: unknown) => {
        this.log.error({ error }, 'custom region queue failed');
      })
      .finally(() => {
        this.queueTask = undefined;
        if (!this.closing && [...this.jobs.values()].some((job) => job.status === 'queued')) {
          this.schedule();
        }
      });
  }

  private isExpired(job: RegionPackJob): boolean {
    return (
      (job.status === 'done' || job.status === 'failed') &&
      this.now() - job.updatedAt > ARTIFACT_TTL_MS
    );
  }

  private async removeJobFiles(id: string): Promise<void> {
    await Promise.all([
      rm(path.join(this.artifactsDir, id), { recursive: true, force: true }),
      rm(path.join(this.jobsDir, `${id}.json`), { force: true }),
    ]);
  }

  private async expireOld(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (!this.isExpired(job)) continue;
      this.jobs.delete(job.id);
      await this.removeJobFiles(job.id);
    }
  }

  private async runQueue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (this.closing) break;
        const next = [...this.jobs.values()]
          .filter((job) => job.status === 'queued')
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) break;
        await this.build(next);
      }
    } finally {
      this.running = false;
    }
  }

  private async setJob(
    job: RegionPackJob,
    patch: Partial<Pick<RegionPackJob, 'status' | 'progress' | 'detail' | 'manifest' | 'error'>>,
  ): Promise<void> {
    Object.assign(job, patch, { updatedAt: this.now() });
    await this.persist(job);
  }

  private async persist(job: RegionPackJob): Promise<void> {
    const file = path.join(this.jobsDir, `${job.id}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(job, null, 2));
    await rename(temp, file);
  }

  private async enclosingPack(bbox: BBox): Promise<{ dir: string; manifest: RegionPackManifest }> {
    const packsDir = path.join(this.dataDir, 'packs');
    const choices: { dir: string; manifest: RegionPackManifest; area: number }[] = [];
    for (const entry of await readdir(packsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      try {
        const dir = path.join(packsDir, entry.name);
        const manifest = JSON.parse(
          await readFile(path.join(dir, 'pack.json'), 'utf8'),
        ) as RegionPackManifest;
        if (
          !manifest.custom &&
          contains(manifest.bbox, bbox) &&
          manifest.files.routing &&
          manifest.files.search &&
          manifest.files.assets
        ) {
          choices.push({ dir, manifest, area: bboxAreaKm2(manifest.bbox) });
        }
      } catch {
        // Incomplete pack: it cannot enclose a custom region.
      }
    }
    choices.sort((a, b) => a.area - b.area);
    const choice = choices[0];
    if (!choice) {
      throw new RegionJobError(400, 'no published offline region fully contains this selection');
    }
    return choice;
  }

  private async build(job: RegionPackJob): Promise<void> {
    const finalDir = path.join(this.artifactsDir, job.id);
    const stagingDir = `${finalDir}.staging`;
    try {
      await rm(stagingDir, { recursive: true, force: true });
      await mkdir(stagingDir, { recursive: true });
      const enclosing = await this.enclosingPack(job.bbox);
      await this.setJob(job, {
        status: 'extracting',
        progress: 0.15,
        detail: 'Extracting map tiles',
      });
      if (this.closing) return;
      const extractionController = new AbortController();
      this.extractionController = extractionController;
      await this.extract(
        path.join(this.dataDir, 'tiles', 'norway.pmtiles'),
        path.join(stagingDir, 'basemap.pmtiles'),
        job.bbox,
        extractionController.signal,
      );
      if (this.extractionController === extractionController) {
        this.extractionController = undefined;
      }
      if (this.closing) return;

      await this.setJob(job, {
        status: 'assembling',
        progress: 0.65,
        detail: `Adding routing and search from ${enclosing.manifest.name}`,
      });
      // The enclosing pack's road-data dataset (ROADMAP §2.1) is optional — it's
      // absent for a region with no NVDB clip and no OSM cameras. When present,
      // reuse it whole: it's clipped to the enclosing region (a superset of this
      // custom bbox), and the on-device conflation bbox-filters it anyway.
      //
      // The outdoor overlay (§4.1) is reused rather than re-extracted for the
      // same reason plus one of its own: the whole national archive is under
      // 7 MB, so a bbox extract would cost a second Docker round-trip to save
      // kilobytes. MapLibre only ever draws the tiles in view.
      const reusedKinds = (['search', 'routing', 'assets', 'nvdb', 'outdoor'] as const).filter(
        (kind) => enclosing.manifest.files[kind],
      );
      for (const kind of reusedKinds) {
        const file = enclosing.manifest.files[kind]!;
        await copyFile(
          path.join(enclosing.dir, file.path),
          path.join(stagingDir, file.path),
          fsConstants.COPYFILE_FICLONE,
        );
      }
      const files: RegionPackManifest['files'] = {};
      for (const [kind, fileName, reusableSha] of [
        ['basemap', 'basemap.pmtiles', undefined],
        ...reusedKinds.map(
          (kind) =>
            [
              kind,
              enclosing.manifest.files[kind]!.path,
              enclosing.manifest.files[kind]!.sha256,
            ] as const,
        ),
      ] as const) {
        const filePath = path.join(stagingDir, fileName);
        files[kind] = {
          path: fileName,
          bytes: (await stat(filePath)).size,
          // basemap is freshly extracted here; the others are byte-for-byte
          // copies, so reuse the enclosing pack's digest when it has one.
          sha256: reusableSha ?? (await sha256File(filePath)),
        };
      }
      const builtAt = this.now();
      const manifest: RegionPackManifest = {
        id: job.id,
        name: job.name,
        bbox: job.bbox,
        version: Math.floor(builtAt / 1000),
        builtAt,
        downloadBase: `/region-jobs/files/${job.id}`,
        custom: true,
        expiresAt: builtAt + ARTIFACT_TTL_MS,
        files,
      };
      await writeFile(path.join(stagingDir, 'pack.json'), JSON.stringify(manifest, null, 2));
      await rm(finalDir, { recursive: true, force: true });
      await rename(stagingDir, finalDir);
      await this.setJob(job, {
        status: 'done',
        progress: 1,
        detail: 'Ready to download',
        manifest,
      });
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      if (this.closing) return;
      this.log.error({ error, job: job.id }, 'custom region build failed');
      await this.setJob(job, {
        status: 'failed',
        progress: 0,
        detail: 'Build failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.extractionController = undefined;
    }
  }
}
