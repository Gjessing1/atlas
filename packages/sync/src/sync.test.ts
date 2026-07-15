import { DatabaseSync } from 'node:sqlite';
import { AtlasStorage } from '@atlas/storage';
import type { SqlDriver, SqlRow, SqlValue, SyncChange } from '@atlas/storage';
import { describe, expect, it } from 'vitest';
import { SYNC_CURSOR_KEY, SyncEngine, SyncError } from './engine.js';
import type { SyncPullResponse, SyncPushRequest } from './protocol.js';
import { lwwWins } from './protocol.js';

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

/** In-memory model of the backend sync store: LWW rows + a pull sequence. */
class FakeServer {
  online = true;
  authorized = true;
  pushes = 0;
  private rows = new Map<string, { change: SyncChange; seq: number; deviceId: string }>();
  private seq = 0;

  readonly fetchFn: typeof fetch = (input, init) => {
    const url = new URL(String(input), 'http://server');
    if (!this.online) return Promise.reject(new TypeError('fetch failed'));
    if (!this.authorized) return Promise.resolve(Response.json({ error: 'nope' }, { status: 401 }));
    if (url.pathname === '/api/sync/push') {
      this.pushes++;
      const body = JSON.parse(String(init?.body)) as SyncPushRequest;
      let applied = 0;
      let skipped = 0;
      for (const change of body.changes) {
        const key = `${change.entity}|${change.id}`;
        const existing = this.rows.get(key);
        if (lwwWins(change.updatedAt, existing?.change.updatedAt ?? null)) {
          this.rows.set(key, { change, seq: ++this.seq, deviceId: body.deviceId });
          applied++;
        } else {
          skipped++;
        }
      }
      return Promise.resolve(Response.json({ applied, skipped }));
    }
    if (url.pathname === '/api/sync/pull') {
      const since = Number(url.searchParams.get('since'));
      const device = url.searchParams.get('device');
      const limit = Number(url.searchParams.get('limit')) || 100;
      const all = [...this.rows.values()]
        .filter((r) => r.seq > since && r.deviceId !== device)
        .sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, limit);
      const cursor = page.length > 0 ? page[page.length - 1]!.seq : this.seq;
      const body: SyncPullResponse = {
        changes: page.map((r) => r.change),
        cursor,
        hasMore: all.length > limit,
      };
      return Promise.resolve(Response.json(body));
    }
    return Promise.resolve(Response.json({ error: 'not found' }, { status: 404 }));
  };
}

async function createDevice(
  server: FakeServer,
): Promise<{ storage: AtlasStorage; engine: SyncEngine }> {
  const storage = new AtlasStorage(createNodeDriver());
  await storage.init();
  const engine = new SyncEngine({
    storage,
    getToken: () => 'test-token',
    fetchFn: server.fetchFn,
    batchSize: 3,
  });
  return { storage, engine };
}

describe('lwwWins', () => {
  it('applies newer, keeps ties and older', () => {
    expect(lwwWins(2, null)).toBe(true);
    expect(lwwWins(2, 1)).toBe(true);
    expect(lwwWins(2, 2)).toBe(false);
    expect(lwwWins(1, 2)).toBe(false);
  });
});

describe('SyncEngine', () => {
  it('pushes local changes and pulls them onto a second device', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    const b = await createDevice(server);

    const folder = await a.storage.createCollection('Hikes');
    await a.storage.createPlace({
      name: 'Preikestolen',
      lat: 58.98,
      lng: 6.19,
      collectionId: folder.id,
    });
    await a.storage.createTrack({ name: 'Run', gpx: '<gpx/>', stats: { d: 1 } });
    await a.storage.setSetting('theme', 'dark');

    const pushResult = await a.engine.sync();
    expect(pushResult.pushed).toBe(4);
    expect(await a.storage.listOutbox()).toEqual([]);

    const pullResult = await b.engine.sync();
    expect(pullResult.pulled).toBe(4);
    expect((await b.storage.listCollections())[0]!.name).toBe('Hikes');
    expect((await b.storage.listPlaces())[0]!.collectionId).toBe(folder.id);
    expect(await b.storage.getTrackGpx((await b.storage.listTracks())[0]!.id)).toBe('<gpx/>');
    expect(await b.storage.getSetting('theme')).toBe('dark');
    // Nothing echoes back: b's pull created no outbox entries.
    expect(await b.storage.listOutbox()).toEqual([]);
  });

  it('does not re-download changes this device pushed', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    await a.storage.createPlace({ name: 'P', lat: 1, lng: 2 });
    const result = await a.engine.sync();
    expect(result.pulled).toBe(0);
    // Cursor still advances past our own writes.
    const again = await a.engine.sync();
    expect(again.pulled).toBe(0);
  });

  it('keeps the outbox and cursor intact while offline, then replays', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    await a.storage.createPlace({ name: 'Offline pin', lat: 1, lng: 2 });

    server.online = false;
    await expect(a.engine.sync()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await a.storage.listOutbox()).toHaveLength(1);

    server.online = true;
    const result = await a.engine.sync();
    expect(result.pushed).toBe(1);
    expect(await a.storage.listOutbox()).toEqual([]);

    const b = await createDevice(server);
    await b.engine.sync();
    expect((await b.storage.listPlaces())[0]!.name).toBe('Offline pin');
  });

  it('surfaces auth failures as SyncError kind auth', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    await a.storage.createPlace({ name: 'P', lat: 1, lng: 2 });
    server.authorized = false;
    await expect(a.engine.sync()).rejects.toSatisfy(
      (e: unknown) => e instanceof SyncError && e.kind === 'auth',
    );
    const noToken = new SyncEngine({
      storage: a.storage,
      getToken: () => null,
      fetchFn: server.fetchFn,
    });
    await expect(noToken.sync()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('resolves concurrent edits by last write wins across devices', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    const b = await createDevice(server);

    const place = await a.storage.createPlace({ name: 'Original', lat: 1, lng: 2 });
    await a.engine.sync();
    await b.engine.sync();

    // b edits after a — b's write is newer and must win everywhere.
    await a.storage.updatePlace(place.id, { name: 'From A' });
    await new Promise((r) => setTimeout(r, 3));
    await b.storage.updatePlace(place.id, { name: 'From B' });

    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    expect((await a.storage.listPlaces())[0]!.name).toBe('From B');
    expect((await b.storage.listPlaces())[0]!.name).toBe('From B');
  });

  it('propagates deletes as tombstones', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    const b = await createDevice(server);

    const place = await a.storage.createPlace({ name: 'Doomed', lat: 1, lng: 2 });
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.storage.listPlaces()).toHaveLength(1);

    await a.storage.deletePlace(place.id);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.storage.listPlaces()).toEqual([]);
  });

  it('pages large pulls until hasMore is false', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    const b = await createDevice(server);
    for (let i = 0; i < 8; i++) await a.storage.createPlace({ name: `P${i}`, lat: i, lng: i });
    await a.engine.sync();
    const result = await b.engine.sync(); // batchSize 3 → 3 pages
    expect(result.pulled).toBe(8);
    expect(await b.storage.listPlaces()).toHaveLength(8);
  });

  it('bootstrap queues pre-login data and resets the cursor', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    // Data created "anonymously", then synced once, outbox drained.
    await a.storage.createPlace({ name: 'Old pin', lat: 1, lng: 2 });
    await a.engine.sync();

    // Fresh account on the same server: bootstrap re-queues everything.
    await a.engine.bootstrap();
    expect(await a.storage.getSetting(SYNC_CURSOR_KEY)).toBe('0');
    const outbox = await a.storage.listOutbox();
    expect(outbox.some((e) => e.entity === 'place')).toBe(true);
    // Device id is local-only and never queued.
    expect(outbox.every((e) => !e.id.startsWith('local.'))).toBe(true);
    const result = await a.engine.sync();
    expect(result.pushed).toBeGreaterThan(0);
  });

  it('coalesces concurrent sync calls into one run', async () => {
    const server = new FakeServer();
    const a = await createDevice(server);
    await a.storage.createPlace({ name: 'P', lat: 1, lng: 2 });
    const [r1, r2] = await Promise.all([a.engine.sync(), a.engine.sync()]);
    expect(r1).toBe(r2);
    expect(server.pushes).toBe(1);
  });
});
