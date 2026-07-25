import type { RegionPackManifest } from '@atlas/core';

import {
  cancelPackDownload,
  enqueuePackDownload,
  forgetPackDownload,
  packDownloadJobs,
  packDownloadSupported,
} from '../../modules/packdownload';
import { closeEngine } from '../routing/offlineRouting';
import {
  downloadPack,
  pendingPackFiles,
  pendingStagingPacks,
  prepareStaging,
  stagingDir,
  uriToPath,
  validatePackManifest,
} from './packs';

/**
 * `waiting` — queued, held back by its network requirement (typically Wi-Fi).
 * `downloading` — the native worker is fetching bytes, app in the foreground or not.
 * `installing` — bytes are in; verifying digests, unpacking and swapping into place.
 * `paused` — a staging directory with no live job behind it: cancelled, or the
 *   system gave up on the work. Resumable, but only when the user says so.
 * `failed` — the download or the install failed; staging is kept for a retry.
 */
export type PackJobPhase = 'waiting' | 'downloading' | 'installing' | 'paused' | 'failed';

export interface PackJob {
  id: string;
  name: string;
  phase: PackJobPhase;
  /** Progress within the phase, 0..1. */
  fraction: number;
  /** Bytes of this download session (not of the whole pack — resumed files are skipped). */
  bytesDone: number;
  bytesTotal: number;
  error: string | null;
  /** Known only for jobs this app run started; a restart forgets the reason for waiting. */
  wifiOnly: boolean;
}

/** How often the native job list is re-read while something is in flight. */
const POLL_MS = 1_500;

/** One line saying what a pack download is doing, for the region row. */
export function packJobLabel(job: PackJob): string {
  const percent = Math.round(job.fraction * 100);
  switch (job.phase) {
    case 'waiting':
      return job.wifiOnly ? 'Waiting for Wi-Fi…' : 'Queued…';
    case 'downloading':
      return `Downloading ${percent}%`;
    case 'installing':
      return `Installing ${percent}%`;
    case 'paused':
      return 'Paused — tap Resume to continue';
    case 'failed':
      return job.error ?? 'Download failed';
  }
}

/** What the row's button offers for a job in this phase, if anything. */
export function packJobAction(job: PackJob): 'cancel' | 'resume' | 'retry' | null {
  switch (job.phase) {
    case 'waiting':
    case 'downloading':
      return 'cancel';
    case 'paused':
      return 'resume';
    case 'failed':
      return 'retry';
    case 'installing':
      return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether two snapshots say the same thing (jobs are flat records, in order). */
function sameJobs(a: readonly PackJob[], b: readonly PackJob[]): boolean {
  return (
    a.length === b.length &&
    a.every((job, index) => {
      const other = b[index]!;
      return (
        job.id === other.id &&
        job.phase === other.phase &&
        job.fraction === other.fraction &&
        job.bytesDone === other.bytesDone &&
        job.bytesTotal === other.bytesTotal &&
        job.error === other.error &&
        job.wifiOnly === other.wifiOnly
      );
    })
  );
}

/**
 * The app's view of the pack downloads the system is running for it.
 *
 * Deliberately a module-level singleton rather than component state: a download
 * outlives the Settings sheet that started it, the screen that sheet was on, and
 * — because the bytes are fetched by a WorkManager foreground service — the app
 * process itself. So this holds no truth of its own. It reads the native job
 * list plus the staging directories on disk, and from those two facts decides
 * what each pack is doing and what still has to happen: a download that finished
 * while Atlas was away is verified, unpacked and swapped into place the next time
 * the app is opened.
 */
export class PackDownloadManager {
  private jobs = new Map<string, PackJob>();
  private listeners = new Set<() => void>();
  private installed = new Set<() => void>();
  /** Packs whose install is running right now — reconciling must not restart it. */
  private installing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  /** Snapshot handed to React: one array per change, so its identity is a signal. */
  private cache: PackJob[] = [];

  /** Whether background downloads exist in this build at all. */
  readonly supported = packDownloadSupported;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fires after a pack has been swapped into place, so the app can reload its packs. */
  onInstalled(listener: () => void): () => void {
    this.installed.add(listener);
    return () => this.installed.delete(listener);
  }

  snapshot(): PackJob[] {
    return this.cache;
  }

  job(id: string): PackJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Start (or resume) a pack download. Files already on disk at the right size
   * are skipped, so this is also the retry path; when everything is already
   * downloaded it goes straight to installing.
   */
  async start(manifest: RegionPackManifest, wifiOnly = false): Promise<void> {
    validatePackManifest(manifest);
    // Already in flight: re-enqueueing would replace a worker that is mid-file
    // and could leave two of them appending to it.
    const running = this.jobs.get(manifest.id)?.phase;
    if (running === 'downloading' || running === 'waiting' || running === 'installing') return;
    this.put({
      id: manifest.id,
      name: manifest.name,
      phase: 'waiting',
      fraction: 0,
      bytesDone: 0,
      bytesTotal: 0,
      error: null,
      wifiOnly,
    });
    try {
      await prepareStaging(stagingDir(manifest.id), manifest);
      const files = await pendingPackFiles(manifest);
      if (files.length === 0) {
        await this.install(manifest);
        return;
      }
      if (!this.supported) {
        // No native worker (a build predating it): fall back to downloading in
        // the app, which is what Atlas always did — it just stops when Android
        // freezes the process.
        await this.install(manifest);
        return;
      }
      enqueuePackDownload(
        manifest.id,
        {
          name: manifest.name,
          dir: uriToPath(stagingDir(manifest.id)),
          files,
        },
        wifiOnly,
      );
      this.poll();
      void this.refresh();
    } catch (err) {
      this.patch(manifest.id, { phase: 'failed', error: message(err) });
    }
  }

  /** Stop a download. What has landed stays on disk for a later resume. */
  cancel(id: string): void {
    cancelPackDownload(id);
    this.patch(id, { phase: 'paused', error: null });
    void this.refresh();
  }

  /** Forget a finished/failed job record (a pack delete, or dismissing an error). */
  forget(id: string): void {
    forgetPackDownload(id);
    if (this.jobs.delete(id)) this.emit();
  }

  /**
   * Re-read the native jobs and the staging directories, and act on what they
   * say together: install what has finished downloading, keep showing what is
   * still going, and report what failed.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const [pending, native] = await Promise.all([pendingStagingPacks(), packDownloadJobs()]);
      const byId = new Map(native.map((job) => [job.packId, job]));
      const next = new Map<string, PackJob>();
      // Installs are started only once the new job map is published, so their
      // own progress and failure reports cannot be overwritten by this pass.
      const owed: RegionPackManifest[] = [];
      for (const manifest of pending) {
        const previous = this.jobs.get(manifest.id);
        if (this.installing.has(manifest.id)) {
          if (previous) next.set(manifest.id, previous);
          continue;
        }
        const job = byId.get(manifest.id);
        const base: PackJob = {
          id: manifest.id,
          name: manifest.name,
          phase: 'paused',
          fraction: 0,
          bytesDone: job?.bytesDone ?? 0,
          bytesTotal: job?.bytesTotal ?? 0,
          error: null,
          wifiOnly: previous?.wifiOnly ?? false,
        };
        const fraction =
          job && job.bytesTotal > 0 ? Math.min(1, job.bytesDone / job.bytesTotal) : 0;
        switch (job?.state) {
          case 'running':
            next.set(manifest.id, { ...base, phase: 'downloading', fraction });
            break;
          case 'enqueued':
          case 'blocked':
            next.set(manifest.id, { ...base, phase: 'waiting', fraction });
            break;
          case 'failed':
            next.set(manifest.id, {
              ...base,
              phase: 'failed',
              error: job.error ?? 'Download failed',
            });
            break;
          case 'succeeded':
            next.set(manifest.id, { ...base, phase: 'installing', fraction: 0 });
            owed.push(manifest);
            break;
          default: {
            // Cancelled, or no record left at all. Everything downloaded means
            // the install is simply owed; otherwise it is a resumable stop, and
            // any error we already knew about is worth keeping on screen.
            const remaining = await pendingPackFiles(manifest);
            if (remaining.length === 0) {
              next.set(manifest.id, { ...base, phase: 'installing', fraction: 0 });
              owed.push(manifest);
            } else {
              next.set(manifest.id, { ...base, error: previous?.error ?? null });
            }
          }
        }
      }
      // A job whose staging directory is gone is already installed or deleted.
      for (const job of native) {
        if (!next.has(job.packId) && !this.installing.has(job.packId)) {
          forgetPackDownload(job.packId);
        }
      }
      this.jobs = next;
      this.emit();
      this.poll();
      for (const manifest of owed) void this.install(manifest);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Verify, unpack and swap a fully downloaded staging directory into place.
   * `downloadPack` does all of it and re-downloads nothing (every file is
   * already there at the right size), which keeps one implementation of the
   * digest checks and the atomic swap for both paths.
   */
  private async install(manifest: RegionPackManifest): Promise<void> {
    if (this.installing.has(manifest.id)) return;
    this.installing.add(manifest.id);
    this.put({
      id: manifest.id,
      name: manifest.name,
      phase: 'installing',
      fraction: 0,
      bytesDone: 0,
      bytesTotal: 0,
      error: null,
      wifiOnly: this.jobs.get(manifest.id)?.wifiOnly ?? false,
    });
    try {
      // Replacing an installed pack overwrites files the routing engine may
      // hold open (mmap) — release it first, same as on delete.
      await closeEngine();
      await downloadPack(manifest, (fraction) => this.patch(manifest.id, { fraction }));
      forgetPackDownload(manifest.id);
      this.jobs.delete(manifest.id);
      this.emit();
      for (const listener of this.installed) listener();
    } catch (err) {
      this.patch(manifest.id, { phase: 'failed', error: message(err) });
    } finally {
      this.installing.delete(manifest.id);
    }
  }

  private put(job: PackJob): void {
    this.jobs.set(job.id, job);
    this.emit();
  }

  private patch(id: string, patch: Partial<PackJob>): void {
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, ...patch });
    this.emit();
  }

  /** Poll while anything is in flight; stop as soon as nothing is. */
  private poll(): void {
    const active = [...this.jobs.values()].some(
      (job) => job.phase === 'waiting' || job.phase === 'downloading',
    );
    if (active && this.timer === null) {
      this.timer = setInterval(() => void this.refresh(), POLL_MS);
    } else if (!active && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Publish a new snapshot — but only when something actually changed. The job
   * list is re-read every couple of seconds while a download runs, and handing
   * React a fresh array each time would re-render the whole app (map scene
   * included) for a percentage that has not moved.
   */
  private emit(): void {
    const next = [...this.jobs.values()];
    if (sameJobs(this.cache, next)) return;
    this.cache = next;
    for (const listener of this.listeners) listener();
  }
}

export const packDownloads = new PackDownloadManager();
