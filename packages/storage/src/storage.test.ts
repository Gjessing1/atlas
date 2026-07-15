import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver, SqlRow, SqlValue } from './driver.js';
import { AtlasStorage } from './storage.js';

/** Test driver over Node's built-in SQLite; mirrors the web worker driver's contract. */
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

describe('AtlasStorage', () => {
  let storage: AtlasStorage;

  beforeEach(async () => {
    storage = new AtlasStorage(createNodeDriver());
    await storage.init();
  });

  it('init is idempotent (migrations only run once)', async () => {
    await storage.init();
    expect(await storage.listPlaces()).toEqual([]);
  });

  it('creates, lists, updates and deletes places', async () => {
    const place = await storage.createPlace({ name: 'Preikestolen', lat: 58.9864, lng: 6.1904 });
    expect(place.id).toMatch(/[0-9a-f-]{36}/);
    expect(place.tags).toEqual([]);

    await storage.updatePlace(place.id, { notes: 'Steep!', tags: ['hike', 'view'] });
    const [listed] = await storage.listPlaces();
    expect(listed).toMatchObject({
      name: 'Preikestolen',
      lat: 58.9864,
      notes: 'Steep!',
      tags: ['hike', 'view'],
    });
    expect(listed!.updatedAt).toBeGreaterThanOrEqual(place.updatedAt);

    await storage.deletePlace(place.id);
    expect(await storage.listPlaces()).toEqual([]);
  });

  it('supports moving a place to a collection and back to root', async () => {
    const collection = await storage.createCollection('Hikes');
    const place = await storage.createPlace({ name: 'A', lat: 1, lng: 2 });
    await storage.updatePlace(place.id, { collectionId: collection.id });
    expect((await storage.listPlaces())[0]!.collectionId).toBe(collection.id);
    await storage.updatePlace(place.id, { collectionId: null });
    expect((await storage.listPlaces())[0]!.collectionId).toBeNull();
  });

  it('nests collections and re-parents contents on delete', async () => {
    const parent = await storage.createCollection('Norway');
    const child = await storage.createCollection('Rogaland', parent.id);
    const grandchild = await storage.createCollection('Lysefjorden', child.id);
    const place = await storage.createPlace({ name: 'P', lat: 1, lng: 2, collectionId: child.id });

    await storage.deleteCollection(child.id);

    const collections = await storage.listCollections();
    expect(collections.map((c) => c.id).sort()).toEqual([parent.id, grandchild.id].sort());
    expect(collections.find((c) => c.id === grandchild.id)!.parentId).toBe(parent.id);
    expect((await storage.listPlaces())[0]!.collectionId).toBe(parent.id);
    expect(place.collectionId).toBe(child.id); // original record untouched
  });

  it('stores tracks with GPX body separate from the listed metadata', async () => {
    const gpx = '<gpx version="1.1"><trk><trkseg/></trk></gpx>';
    const track = await storage.createTrack({
      name: 'Morning run',
      gpx,
      stats: { distanceM: 5000, points: 120 },
    });

    const [listed] = await storage.listTracks();
    expect(listed).toMatchObject({
      name: 'Morning run',
      stats: { distanceM: 5000, points: 120 },
      visible: true,
    });
    expect('gpx' in listed!).toBe(false);
    expect(await storage.getTrackGpx(track.id)).toBe(gpx);
    expect(await storage.getTrackGpx('nope')).toBeNull();

    await storage.updateTrack(track.id, { visible: false, name: 'Evening run' });
    expect((await storage.listTracks())[0]).toMatchObject({ name: 'Evening run', visible: false });

    await storage.deleteTrack(track.id);
    expect(await storage.listTracks()).toEqual([]);
  });

  it('upserts settings', async () => {
    expect(await storage.getSetting('view')).toBeNull();
    await storage.setSetting('view', 'a');
    await storage.setSetting('view', 'b');
    expect(await storage.getSetting('view')).toBe('b');
  });

  it('exports everything', async () => {
    const collection = await storage.createCollection('C');
    await storage.createPlace({ name: 'P', lat: 1, lng: 2, collectionId: collection.id });
    await storage.createTrack({ name: 'T', gpx: '<gpx/>' });
    await storage.setSetting('k', 'v');

    const dump = await storage.exportAll();
    expect(dump.collections).toHaveLength(1);
    expect(dump.places).toHaveLength(1);
    expect(dump.tracks[0]).toMatchObject({ name: 'T', gpx: '<gpx/>' });
    expect(dump.settings).toEqual({ k: 'v' });
    expect(dump.exportedAt).toBeGreaterThan(0);
  });
});
