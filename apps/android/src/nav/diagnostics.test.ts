import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An in-memory stand-in for the two file APIs this module uses. Real enough to
 * exercise what the tests are about — that a trip becomes its own file, that a
 * trip ended short of the destination is still closed, summarised and sent,
 * and that a failed upload leaves the trip pending rather than losing it.
 */
const fs = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    reset() {
      files.clear();
      dirs.clear();
    },
    makeDirectoryAsync: vi.fn(async (uri: string) => {
      dirs.add(uri);
    }),
    readAsStringAsync: vi.fn(async (uri: string) => {
      const value = files.get(uri);
      if (value === undefined) throw new Error(`no such file: ${uri}`);
      return value;
    }),
    writeAsStringAsync: vi.fn(async (uri: string, body: string, options?: { append?: boolean }) => {
      files.set(uri, options?.append ? `${files.get(uri) ?? ''}${body}` : body);
    }),
    readDirectoryAsync: vi.fn(async (uri: string) =>
      [...files.keys()].filter((f) => f.startsWith(uri)).map((f) => f.slice(uri.length)),
    ),
    getInfoAsync: vi.fn(async (uri: string) => {
      const value = files.get(uri);
      return value === undefined
        ? { exists: false }
        : { exists: true, size: value.length, modificationTime: 1_700_000_000 };
    }),
    deleteAsync: vi.fn(async (uri: string) => {
      files.delete(uri);
      for (const key of [...files.keys()]) if (key.startsWith(uri)) files.delete(key);
    }),
    moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const value = files.get(from);
      if (value === undefined) throw new Error('missing');
      files.set(to, value);
      files.delete(from);
    }),
  };
});

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: fs.makeDirectoryAsync,
  getInfoAsync: fs.getInfoAsync,
  readAsStringAsync: fs.readAsStringAsync,
  writeAsStringAsync: fs.writeAsStringAsync,
  readDirectoryAsync: fs.readDirectoryAsync,
  deleteAsync: fs.deleteAsync,
  moveAsync: fs.moveAsync,
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => undefined),
}));
vi.mock('../serverOrigin', () => ({ getServerOrigin: () => 'https://atlas.example' }));

import type * as DiagnosticsModule from './diagnostics';

type Diagnostics = typeof DiagnosticsModule;

const uploaded = vi.fn();

/** The module instance the current test is driving, so the next can drain it. */
let live: Diagnostics | null = null;

/** A fresh copy of the module — its trip state is deliberately module-level. */
async function load(): Promise<Diagnostics> {
  // Writes are queued and fire-and-forget by design, so let the previous
  // test's drain before clearing the disk under it.
  await live?.listNavigationDiagnosticTrips();
  fs.reset();
  return reload();
}

/** The next app launch: a new module instance over the same stored files. */
async function reload(): Promise<Diagnostics> {
  await live?.listNavigationDiagnosticTrips();
  vi.resetModules();
  const module = await import('./diagnostics');
  module.configureNavigationDiagnostics(true, 'driver@example.com');
  live = module;
  return module;
}

/** A trip long enough to clear the "nothing to diagnose" floor. */
function driveFor(diagnostics: Diagnostics, samples: number): void {
  for (let i = 0; i < samples; i++) {
    diagnostics.navigationDiagnosticsSink({
      event: 'navigation-state',
      state: { status: 'navigating', fix: 'live', road: 'E18', traveledM: i * 20 },
    });
  }
}

function tripFiles(): string[] {
  return [...fs.files.keys()].filter((name) => name.endsWith('.jsonl'));
}

describe('navigation diagnostics storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        uploaded(init.body);
        return new Response(JSON.stringify({ reference: 'ABCDE-12345' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });

  it('gives each trip its own file, so the next drive cannot overwrite the last', async () => {
    const diagnostics = await load();
    for (const trip of ['trip-a', 'trip-b']) {
      diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip, profile: 'car' });
      driveFor(diagnostics, 200);
      diagnostics.navigationDiagnosticsSink({
        event: 'trip-end',
        trip,
        outcome: 'arrived',
        report: { samples: 200, distanceM: 4000, durationMs: 200_000, routeChanges: 0 },
      });
    }
    const trips = await diagnostics.listNavigationDiagnosticTrips();
    expect(trips.map((trip) => trip.id).sort()).toEqual(['trip-a', 'trip-b']);
    expect(tripFiles()).toHaveLength(2);
    // Newest first, and each carries the summary the trip ended with.
    expect(trips[0]?.distanceM).toBe(4000);
    expect(trips.every((trip) => trip.outcome === 'arrived')).toBe(true);
  });

  it('closes, summarises and uploads a trip ended before the destination', async () => {
    const diagnostics = await load();
    diagnostics.configureNavigationDiagnosticsAutoUpload(true);
    diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip: 'partial', profile: 'car' });
    driveFor(diagnostics, 300);
    diagnostics.navigationDiagnosticsSink({
      event: 'trip-end',
      trip: 'partial',
      outcome: 'ended-early',
      report: { samples: 300, distanceM: 6000, durationMs: 300_000, routeChanges: 1 },
    });
    await diagnostics.flushNavigationDiagnosticUploads();

    const [trip] = await diagnostics.listNavigationDiagnosticTrips();
    expect(trip?.outcome).toBe('ended-early');
    expect(trip?.uploaded).toBe('ABCDE-12345');
    expect(trip?.routeChanges).toBe(1);
    expect(uploaded).toHaveBeenCalledTimes(1);
    expect(uploaded.mock.calls[0]?.[0]).toContain('"event":"trip-end"');
  });

  it('keeps a trip pending when the upload fails, and sends it on the next flush', async () => {
    const diagnostics = await load();
    diagnostics.configureNavigationDiagnosticsAutoUpload(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Network request failed');
      }),
    );
    diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip: 'offline', profile: 'car' });
    driveFor(diagnostics, 300);
    diagnostics.navigationDiagnosticsSink({
      event: 'trip-end',
      trip: 'offline',
      outcome: 'arrived',
      report: { samples: 300, distanceM: 900, durationMs: 300_000, routeChanges: 0 },
    });
    await diagnostics.flushNavigationDiagnosticUploads();

    let [trip] = await diagnostics.listNavigationDiagnosticTrips();
    expect(trip?.uploaded).toBeNull();
    expect(trip?.uploadError).toContain('Network request failed');

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ reference: 'LATER-00001' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await diagnostics.flushNavigationDiagnosticUploads();
    [trip] = await diagnostics.listNavigationDiagnosticTrips();
    expect(trip?.uploaded).toBe('LATER-00001');
  });

  it('never uploads anything while auto-upload is off', async () => {
    const diagnostics = await load();
    diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip: 'private', profile: 'car' });
    driveFor(diagnostics, 300);
    diagnostics.navigationDiagnosticsSink({
      event: 'trip-end',
      trip: 'private',
      outcome: 'arrived',
      report: { samples: 300, distanceM: 900, durationMs: 300_000, routeChanges: 0 },
    });
    await diagnostics.flushNavigationDiagnosticUploads();
    expect(uploaded).not.toHaveBeenCalled();
    const [trip] = await diagnostics.listNavigationDiagnosticTrips();
    expect(trip?.uploaded).toBeNull();
  });

  it('drops a trip too small to diagnose, but keeps one that failed to start', async () => {
    const diagnostics = await load();
    diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip: 'cancelled' });
    diagnostics.navigationDiagnosticsSink({
      event: 'trip-end',
      trip: 'cancelled',
      outcome: 'ended-early',
      report: { samples: 0, distanceM: 0, durationMs: 0, routeChanges: 0 },
    });
    diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip: 'nofix' });
    diagnostics.navigationDiagnosticsSink({
      event: 'trip-end',
      trip: 'nofix',
      outcome: 'failed',
      report: { samples: 0, distanceM: 0, durationMs: 0, routeChanges: 0 },
    });
    const trips = await diagnostics.listNavigationDiagnosticTrips();
    expect(trips.map((trip) => trip.id)).toEqual(['nofix']);
  });

  it('surfaces the server error instead of claiming the trip was uploaded', async () => {
    const diagnostics = await load();
    diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip: 'rejected' });
    driveFor(diagnostics, 300);
    diagnostics.navigationDiagnosticsSink({
      event: 'trip-end',
      trip: 'rejected',
      outcome: 'arrived',
      report: { samples: 300, distanceM: 900, durationMs: 300_000, routeChanges: 0 },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'upload disabled' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(diagnostics.uploadNavigationDiagnosticTrip('rejected')).rejects.toThrow(
      'upload disabled',
    );
  });

  it('marks the moment on the running trip', async () => {
    const diagnostics = await load();
    diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip: 'marked' });
    await diagnostics.markNavigationDiagnostic('roundabout was wrong');
    driveFor(diagnostics, 300);
    diagnostics.navigationDiagnosticsSink({
      event: 'trip-end',
      trip: 'marked',
      outcome: 'ended-early',
      report: { samples: 300, distanceM: 900, durationMs: 300_000, routeChanges: 0 },
    });
    await diagnostics.listNavigationDiagnosticTrips();
    const [file] = tripFiles();
    expect(fs.files.get(file!)).toContain('"note":"roundabout was wrong"');
  });

  it('does not let the stub each launch opens eat the retention budget', async () => {
    const diagnostics = await load();
    // Turning recording on opens a file at once, so a switch flipped mid-drive
    // still records the rest of that drive — but an empty one is not a trip.
    expect(await diagnostics.listNavigationDiagnosticTrips()).toHaveLength(0);
    expect(tripFiles()).toHaveLength(1);

    const relaunched = await reload();
    expect(await relaunched.listNavigationDiagnosticTrips()).toHaveLength(0);
    // The previous launch's stub is gone from disk; only this launch's remains.
    expect(tripFiles()).toHaveLength(1);
  });

  it('keeps a trip the process died inside, and calls it interrupted', async () => {
    const diagnostics = await load();
    diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip: 'crashed', profile: 'car' });
    driveFor(diagnostics, 300);
    await diagnostics.listNavigationDiagnosticTrips();

    const relaunched = await reload();
    const [trip] = await relaunched.listNavigationDiagnosticTrips();
    expect(trip?.id).toBe('crashed');
    expect(trip?.outcome).toBe('interrupted');
  });

  it('records nothing at all while the switch is off', async () => {
    const diagnostics = await load();
    diagnostics.configureNavigationDiagnostics(false, null);
    await diagnostics.clearNavigationDiagnostics();
    diagnostics.navigationDiagnosticsSink({ event: 'trip-start', trip: 'ignored' });
    driveFor(diagnostics, 300);
    expect(tripFiles()).toHaveLength(0);
  });
});
