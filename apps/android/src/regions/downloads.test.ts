import type { RegionPackManifest } from '@atlas/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The manager's job is to decide, from the native job list plus what is on disk,
 * what each pack is doing and what still has to happen — so the pack filesystem
 * and the native worker are both mocked and scripted per test.
 */
const h = vi.hoisted(() => ({
  native: {
    jobs: [] as {
      packId: string;
      state: string;
      bytesDone: number;
      bytesTotal: number;
      error: string | null;
    }[],
    enqueued: [] as { packId: string; spec: unknown; wifiOnly: boolean }[],
    cancelled: [] as string[],
    forgotten: [] as string[],
  },
  disk: {
    staging: [] as RegionPackManifest[],
    /** Files still to fetch, per pack id (absent = nothing missing). */
    missing: new Map<string, { url: string; path: string; bytes: number }[]>(),
    installFails: null as string | null,
    installed: [] as string[],
    /** Set to hold an install open, so a reconcile can be raced against it. */
    gate: null as Promise<void> | null,
  },
}));

vi.mock('../../modules/packdownload', () => ({
  packDownloadSupported: true,
  enqueuePackDownload: (packId: string, spec: unknown, wifiOnly: boolean) => {
    h.native.enqueued.push({ packId, spec, wifiOnly });
  },
  packDownloadJobs: async () => h.native.jobs,
  cancelPackDownload: (packId: string) => h.native.cancelled.push(packId),
  forgetPackDownload: (packId: string) => h.native.forgotten.push(packId),
}));

vi.mock('../routing/offlineRouting', () => ({ closeEngine: async () => undefined }));

vi.mock('./packs', () => ({
  validatePackManifest: () => undefined,
  prepareStaging: async () => undefined,
  stagingDir: (id: string) => `file:///doc/packs/${id}.staging`,
  uriToPath: (uri: string) => uri.replace(/^file:\/\//, ''),
  pendingStagingPacks: async () => h.disk.staging,
  pendingPackFiles: async (manifest: RegionPackManifest) => h.disk.missing.get(manifest.id) ?? [],
  downloadPack: async (manifest: RegionPackManifest, onProgress: (f: number) => void) => {
    onProgress(0.5);
    if (h.disk.gate) await h.disk.gate;
    if (h.disk.installFails) throw new Error(h.disk.installFails);
    h.disk.installed.push(manifest.id);
    // The real install swaps staging into place, so the directory is gone.
    h.disk.staging = h.disk.staging.filter((entry) => entry.id !== manifest.id);
    onProgress(1);
    return { manifest, dir: `file:///doc/packs/${manifest.id}` };
  },
}));

import { PackDownloadManager, packJobAction, packJobLabel } from './downloads';

const oslo: RegionPackManifest = {
  id: 'oslo',
  name: 'Oslo',
  version: 3,
  builtAt: 1000,
  bbox: { sw: { lat: 59, lng: 10 }, ne: { lat: 60, lng: 11 } },
  files: { basemap: { path: 'tiles/oslo.pmtiles', bytes: 1000 } },
};

const file = {
  url: 'http://test/packs/oslo/tiles/oslo.pmtiles',
  path: 'tiles/oslo.pmtiles',
  bytes: 1000,
};

beforeEach(() => {
  h.native.jobs = [];
  h.native.enqueued = [];
  h.native.cancelled = [];
  h.native.forgotten = [];
  h.disk.staging = [];
  h.disk.missing = new Map();
  h.disk.installFails = null;
  h.disk.installed = [];
});

describe('starting a download', () => {
  it('hands the missing files to the native worker and shows a queued job', async () => {
    vi.useFakeTimers();
    const manager = new PackDownloadManager();
    h.disk.missing.set('oslo', [file]);
    h.disk.staging = [oslo];
    h.native.jobs = [
      { packId: 'oslo', state: 'enqueued', bytesDone: 0, bytesTotal: 1000, error: null },
    ];

    await manager.start(oslo, true);

    expect(h.native.enqueued).toEqual([
      {
        packId: 'oslo',
        spec: { name: 'Oslo', dir: '/doc/packs/oslo.staging', files: [file] },
        wifiOnly: true,
      },
    ]);
    expect(manager.job('oslo')?.phase).toBe('waiting');
    expect(h.disk.installed).toEqual([]);
    vi.useRealTimers();
  });

  it('installs straight away when every file is already on disk', async () => {
    const manager = new PackDownloadManager();
    const installed = vi.fn();
    manager.onInstalled(installed);

    await manager.start(oslo);

    expect(h.native.enqueued).toEqual([]);
    expect(h.disk.installed).toEqual(['oslo']);
    expect(installed).toHaveBeenCalledOnce();
    // Nothing left to report once the pack is in place.
    expect(manager.snapshot()).toEqual([]);
  });
});

describe('reconciling on return to the app', () => {
  it('installs a download that finished in the background', async () => {
    const manager = new PackDownloadManager();
    h.disk.staging = [oslo];
    h.native.jobs = [
      { packId: 'oslo', state: 'succeeded', bytesDone: 1000, bytesTotal: 1000, error: null },
    ];

    await manager.refresh();
    await vi.waitFor(() => expect(h.disk.installed).toEqual(['oslo']));
    expect(h.native.forgotten).toContain('oslo');
  });

  it('installs a complete staging directory whose job record is gone', async () => {
    const manager = new PackDownloadManager();
    h.disk.staging = [oslo];

    await manager.refresh();
    await vi.waitFor(() => expect(h.disk.installed).toEqual(['oslo']));
  });

  it('leaves an incomplete download paused instead of downloading it in the app', async () => {
    const manager = new PackDownloadManager();
    h.disk.staging = [oslo];
    h.disk.missing.set('oslo', [file]);

    await manager.refresh();

    expect(manager.job('oslo')?.phase).toBe('paused');
    expect(h.disk.installed).toEqual([]);
    expect(h.native.enqueued).toEqual([]);
  });

  it('does not install the same pack twice when it reconciles again mid-install', async () => {
    const manager = new PackDownloadManager();
    h.disk.staging = [oslo];
    let open = () => {};
    h.disk.gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    await manager.refresh();
    expect(manager.job('oslo')?.phase).toBe('installing');
    // A second return to the app while the first install is still verifying.
    await manager.refresh();
    open();
    h.disk.gate = null;
    await vi.waitFor(() => expect(h.disk.installed).toEqual(['oslo']));
    await manager.refresh();
    expect(h.disk.installed).toEqual(['oslo']);
  });

  it('reports a failed download and keeps it retryable', async () => {
    vi.useFakeTimers();
    const manager = new PackDownloadManager();
    h.disk.staging = [oslo];
    h.disk.missing.set('oslo', [file]);
    h.native.jobs = [
      {
        packId: 'oslo',
        state: 'failed',
        bytesDone: 400,
        bytesTotal: 1000,
        error: 'tiles/oslo.pmtiles: HTTP 502',
      },
    ];

    await manager.refresh();
    const job = manager.job('oslo');
    expect(job?.phase).toBe('failed');
    expect(packJobLabel(job!)).toBe('tiles/oslo.pmtiles: HTTP 502');
    expect(packJobAction(job!)).toBe('retry');

    await manager.start(oslo);
    expect(h.native.enqueued.map((entry) => entry.packId)).toEqual(['oslo']);
    vi.useRealTimers();
  });

  it('forgets job records for packs that are no longer staged', async () => {
    const manager = new PackDownloadManager();
    h.native.jobs = [
      { packId: 'bergen', state: 'succeeded', bytesDone: 1, bytesTotal: 1, error: null },
    ];

    await manager.refresh();

    expect(h.native.forgotten).toEqual(['bergen']);
    expect(manager.snapshot()).toEqual([]);
  });

  it('marks the job failed when the install fails, leaving staging for a retry', async () => {
    const manager = new PackDownloadManager();
    h.disk.staging = [oslo];
    h.disk.installFails = 'checksum mismatch';

    await manager.refresh();

    await vi.waitFor(() => expect(manager.job('oslo')?.phase).toBe('failed'));
    expect(manager.job('oslo')?.error).toBe('checksum mismatch');
  });
});

describe('cancelling', () => {
  it('stops the native work and keeps the pack resumable', async () => {
    vi.useFakeTimers();
    const manager = new PackDownloadManager();
    h.disk.staging = [oslo];
    h.disk.missing.set('oslo', [file]);
    h.native.jobs = [
      { packId: 'oslo', state: 'running', bytesDone: 400, bytesTotal: 1000, error: null },
    ];
    await manager.refresh();
    expect(packJobLabel(manager.job('oslo')!)).toBe('Downloading 40%');

    h.native.jobs = [
      { packId: 'oslo', state: 'cancelled', bytesDone: 400, bytesTotal: 1000, error: null },
    ];
    manager.cancel('oslo');
    await vi.waitFor(() => expect(manager.job('oslo')?.phase).toBe('paused'));

    expect(h.native.cancelled).toEqual(['oslo']);
    expect(packJobAction(manager.job('oslo')!)).toBe('resume');
    vi.useRealTimers();
  });
});
