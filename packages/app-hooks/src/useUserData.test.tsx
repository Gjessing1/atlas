// @vitest-environment jsdom
import { DatabaseSync } from 'node:sqlite';
import { AtlasStorage } from '@atlas/storage';
import type { SqlDriver, SqlRow, SqlValue } from '@atlas/storage';
import { act, renderHook, waitFor } from '@testing-library/react';
import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { UserDataPlatform } from './useUserData.js';
import { useUserData } from './useUserData.js';

function createNodeDriver(): SqlDriver {
  const db = new DatabaseSync(':memory:');
  return {
    query: (sql: string, params: SqlValue[] = []) =>
      Promise.resolve(db.prepare(sql).all(...params) as SqlRow[]),
    execScript: (sql: string) => {
      db.exec(sql);
      return Promise.resolve();
    },
  };
}

/** Test file type: name + bytes, handed straight through by readFile. */
interface MemFile {
  name: string;
  bytes: Uint8Array;
}

interface Saved {
  name: string;
  body: string;
  mime: string;
}

function createPlatform(opts?: { zip?: boolean; storage?: AtlasStorage }) {
  const storage = opts?.storage ?? new AtlasStorage(createNodeDriver());
  const savedText: Saved[] = [];
  const savedZips: { name: string; bytes: Uint8Array }[] = [];
  const platform: UserDataPlatform<MemFile> = {
    openStorage: async () => {
      await storage.init();
      return storage;
    },
    readFile: (file) => Promise.resolve(file),
    saveTextFile: (name, body, mime) => {
      savedText.push({ name, body, mime });
      return Promise.resolve();
    },
    ...(opts?.zip
      ? {
          saveZipFile: (name: string, bytes: Uint8Array) => {
            savedZips.push({ name, bytes });
            return Promise.resolve();
          },
        }
      : {}),
  };
  return { storage, platform, savedText, savedZips };
}

const gpxFile = (name: string): MemFile => ({
  name,
  bytes: new TextEncoder().encode(
    `<?xml version="1.0"?><gpx><trk><name>Morning ride</name><trkseg>
       <trkpt lat="59.9" lon="10.7"><ele>100</ele></trkpt>
       <trkpt lat="59.91" lon="10.71"><ele>110</ele></trkpt>
     </trkseg></trk></gpx>`,
  ),
});

const waypointsFile: MemFile = {
  name: 'favs.gpx',
  bytes: new TextEncoder().encode(
    '<gpx><wpt lat="59.9" lon="10.7"><name>Cabin</name></wpt><wpt lat="60" lon="11"/></gpx>',
  ),
};

describe('useUserData', () => {
  it('opens storage, loads lists, and reports readiness', async () => {
    const { storage, platform } = createPlatform();
    await storage.init();
    await storage.createPlace({ name: 'Existing', lat: 59, lng: 10 });
    const { result } = renderHook(() => useUserData(platform));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.places.map((p) => p.name)).toEqual(['Existing']);
    expect(result.current.storage).not.toBeNull();
  });

  it('reports an error state when storage cannot open', async () => {
    const platform: UserDataPlatform<MemFile> = {
      openStorage: () => Promise.reject(new Error('OPFS unavailable')),
      readFile: (f) => Promise.resolve(f),
      saveTextFile: () => Promise.resolve(),
    };
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('OPFS unavailable');
  });

  it('writes through mutations and surfaces failed writes', async () => {
    const { storage, platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let created: unknown;
    await act(async () => {
      created = await result.current.savePlace({ name: 'Home', lat: 59.9, lng: 10.7 });
    });
    expect(created).not.toBeNull();
    expect(result.current.places).toHaveLength(1);

    await act(async () => {
      await result.current.updatePlace(result.current.places[0]!.id, { name: 'Hjem' });
    });
    expect(result.current.places[0]!.name).toBe('Hjem');

    vi.spyOn(storage, 'deletePlace').mockRejectedValueOnce(new Error('disk full'));
    await act(async () => {
      await result.current.deletePlace(result.current.places[0]!.id);
    });
    expect(result.current.writeError).toBe('Deleting place failed — disk full');
    expect(result.current.places).toHaveLength(1); // nothing was deleted
    act(() => result.current.clearWriteError());
    expect(result.current.writeError).toBeNull();
  });

  it('imports tracks and waypoint-only files, collecting per-file errors', async () => {
    const { platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let outcome!: Awaited<ReturnType<typeof result.current.importFiles>>;
    await act(async () => {
      outcome = await result.current.importFiles([
        gpxFile('ride.gpx'),
        waypointsFile,
        { name: 'broken.gpx', bytes: new TextEncoder().encode('not xml at all') },
      ]);
    });
    expect(outcome.tracks.map((t) => t.name)).toEqual(['Morning ride']);
    expect(outcome.places).toHaveLength(2);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toContain('broken.gpx');
    expect(result.current.tracks).toHaveLength(1);
    expect(result.current.places).toHaveLength(2);

    // Imported geometry is parseable back out of storage (and cached).
    const data = await result.current.getTrackData(outcome.tracks[0]!.id);
    expect(data?.segments[0]).toHaveLength(2);
  });

  it('exports a single track as gpx or kml via the platform seam', async () => {
    const { platform, savedText } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let imported!: Awaited<ReturnType<typeof result.current.importFiles>>;
    await act(async () => {
      imported = await result.current.importFiles([gpxFile('Tur til hytta!.gpx')]);
    });

    await act(async () => {
      await result.current.exportTrack(imported.tracks[0]!.id, 'gpx');
      await result.current.exportTrack(imported.tracks[0]!.id, 'kml');
    });
    expect(savedText[0]!.name).toBe('Morning_ride.gpx');
    expect(savedText[0]!.mime).toBe('application/gpx+xml');
    expect(savedText[0]!.body).toContain('<trkpt'); // original GPX preserved
    expect(savedText[1]!.name).toBe('Morning_ride.kml');
    expect(savedText[1]!.body).toContain('<kml');
  });

  it('exportAll ships a zip when the platform can save one, else the JSON dump', async () => {
    const zipped = createPlatform({ zip: true });
    const hook1 = renderHook(() => useUserData(zipped.platform));
    await waitFor(() => expect(hook1.result.current.status).toBe('ready'));
    await act(async () => {
      await hook1.result.current.savePlace({ name: 'Home', lat: 59.9, lng: 10.7 });
      await hook1.result.current.importFiles([gpxFile('ride.gpx')]);
      await hook1.result.current.exportAll();
    });
    expect(zipped.savedZips).toHaveLength(1);
    const entries = unzipSync(zipped.savedZips[0]!.bytes);
    expect(Object.keys(entries).sort()).toEqual([
      'atlas-export.json',
      'places.gpx',
      'tracks/Morning_ride.gpx',
    ]);

    const plain = createPlatform();
    const hook2 = renderHook(() => useUserData(plain.platform));
    await waitFor(() => expect(hook2.result.current.status).toBe('ready'));
    await act(async () => {
      await hook2.result.current.exportAll();
    });
    expect(plain.savedText[0]!.mime).toBe('application/json');
    expect(JSON.parse(plain.savedText[0]!.body)).toHaveProperty('places');
  });

  it('setAllVisible flips only records that differ', async () => {
    const { storage, platform } = createPlatform();
    const { result } = renderHook(() => useUserData(platform));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.savePlace({ name: 'A', lat: 1, lng: 1 });
      await result.current.savePlace({ name: 'B', lat: 2, lng: 2 });
      await result.current.createCollection('Folder');
    });
    const bId = result.current.places.find((p) => p.name === 'B')!.id;
    await act(async () => {
      await result.current.updatePlace(bId, { visible: false });
    });

    const spy = vi.spyOn(storage, 'updatePlace');
    await act(async () => {
      await result.current.setAllVisible(false);
    });
    // Only A differed — B was already hidden (folders go via setCollectionVisible).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.places.every((p) => !p.visible)).toBe(true);
    expect(result.current.collections.every((c) => !c.visible)).toBe(true);
  });
});
