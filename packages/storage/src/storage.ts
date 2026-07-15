import type { SqlDriver, SqlRow, SqlValue } from './driver.js';
import { migrate } from './migrations.js';
import type {
  CollectionRecord,
  ExportedData,
  NewPlace,
  NewTrack,
  PlacePatch,
  PlaceRecord,
  TrackPatch,
  TrackRecord,
} from './records.js';

function parseTags(value: SqlValue | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseStats(value: SqlValue | undefined): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function rowToCollection(r: SqlRow): CollectionRecord {
  return {
    id: String(r['id']),
    name: String(r['name']),
    parentId: r['parent_id'] === null ? null : String(r['parent_id']),
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  };
}

function rowToPlace(r: SqlRow): PlaceRecord {
  return {
    id: String(r['id']),
    name: String(r['name']),
    lat: Number(r['lat']),
    lng: Number(r['lng']),
    collectionId: r['collection_id'] === null ? null : String(r['collection_id']),
    notes: String(r['notes']),
    tags: parseTags(r['tags']),
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  };
}

function rowToTrack(r: SqlRow): TrackRecord {
  return {
    id: String(r['id']),
    name: String(r['name']),
    stats: parseStats(r['stats']),
    collectionId: r['collection_id'] === null ? null : String(r['collection_id']),
    notes: String(r['notes']),
    tags: parseTags(r['tags']),
    visible: Number(r['visible']) !== 0,
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  };
}

const TRACK_COLUMNS =
  'id, name, stats, collection_id, notes, tags, visible, created_at, updated_at';

/**
 * The user-data repository: collections (folders), places (favorites/pins),
 * tracks (GPX), and settings. All writes stamp `updated_at` for the future
 * last-write-wins sync (Phase 5). Async throughout — the web driver crosses a
 * worker boundary.
 */
export class AtlasStorage {
  constructor(private readonly driver: SqlDriver) {}

  /** Run pending migrations; call once before anything else. */
  async init(): Promise<void> {
    await migrate(this.driver);
  }

  // ---- collections ----

  async listCollections(): Promise<CollectionRecord[]> {
    const rows = await this.driver.query('SELECT * FROM collections ORDER BY name');
    return rows.map(rowToCollection);
  }

  async createCollection(name: string, parentId: string | null = null): Promise<CollectionRecord> {
    const now = Date.now();
    const record: CollectionRecord = {
      id: crypto.randomUUID(),
      name,
      parentId,
      createdAt: now,
      updatedAt: now,
    };
    await this.driver.query('INSERT INTO collections VALUES (?, ?, ?, ?, ?)', [
      record.id,
      record.name,
      record.parentId,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  async renameCollection(id: string, name: string): Promise<void> {
    await this.driver.query('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?', [
      name,
      Date.now(),
      id,
    ]);
  }

  /**
   * Delete a collection. Its contents and child collections move to its
   * parent (or the root) — deleting a folder never deletes user data.
   */
  async deleteCollection(id: string): Promise<void> {
    const rows = await this.driver.query('SELECT parent_id FROM collections WHERE id = ?', [id]);
    if (rows.length === 0) return;
    const parentId = rows[0]!['parent_id'] ?? null;
    const now = Date.now();
    for (const table of ['places', 'tracks']) {
      await this.driver.query(
        `UPDATE ${table} SET collection_id = ?, updated_at = ? WHERE collection_id = ?`,
        [parentId, now, id],
      );
    }
    await this.driver.query(
      'UPDATE collections SET parent_id = ?, updated_at = ? WHERE parent_id = ?',
      [parentId, now, id],
    );
    await this.driver.query('DELETE FROM collections WHERE id = ?', [id]);
  }

  // ---- places ----

  async listPlaces(): Promise<PlaceRecord[]> {
    const rows = await this.driver.query('SELECT * FROM places ORDER BY name');
    return rows.map(rowToPlace);
  }

  async createPlace(input: NewPlace): Promise<PlaceRecord> {
    const now = Date.now();
    const record: PlaceRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      lat: input.lat,
      lng: input.lng,
      collectionId: input.collectionId ?? null,
      notes: input.notes ?? '',
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.driver.query('INSERT INTO places VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      record.id,
      record.name,
      record.lat,
      record.lng,
      record.collectionId,
      record.notes,
      JSON.stringify(record.tags),
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  async updatePlace(id: string, patch: PlacePatch): Promise<void> {
    await this.applyPatch('places', id, {
      name: patch.name,
      lat: patch.lat,
      lng: patch.lng,
      collection_id: patch.collectionId,
      notes: patch.notes,
      tags: patch.tags === undefined ? undefined : JSON.stringify(patch.tags),
    });
  }

  async deletePlace(id: string): Promise<void> {
    await this.driver.query('DELETE FROM places WHERE id = ?', [id]);
  }

  // ---- tracks ----

  async listTracks(): Promise<TrackRecord[]> {
    const rows = await this.driver.query(`SELECT ${TRACK_COLUMNS} FROM tracks ORDER BY name`);
    return rows.map(rowToTrack);
  }

  /** The stored GPX document for a track, or null when the id is unknown. */
  async getTrackGpx(id: string): Promise<string | null> {
    const rows = await this.driver.query('SELECT gpx FROM tracks WHERE id = ?', [id]);
    return rows.length > 0 ? String(rows[0]!['gpx']) : null;
  }

  async createTrack(input: NewTrack): Promise<TrackRecord> {
    const now = Date.now();
    const record: TrackRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      stats: input.stats ?? {},
      collectionId: input.collectionId ?? null,
      notes: input.notes ?? '',
      tags: input.tags ?? [],
      visible: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.driver.query('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      record.id,
      record.name,
      input.gpx,
      JSON.stringify(record.stats),
      record.collectionId,
      record.notes,
      JSON.stringify(record.tags),
      1,
      record.createdAt,
      record.updatedAt,
    ]);
    return record;
  }

  async updateTrack(id: string, patch: TrackPatch): Promise<void> {
    await this.applyPatch('tracks', id, {
      name: patch.name,
      collection_id: patch.collectionId,
      notes: patch.notes,
      tags: patch.tags === undefined ? undefined : JSON.stringify(patch.tags),
      visible: patch.visible === undefined ? undefined : patch.visible ? 1 : 0,
    });
  }

  async deleteTrack(id: string): Promise<void> {
    await this.driver.query('DELETE FROM tracks WHERE id = ?', [id]);
  }

  // ---- settings ----

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.driver.query('SELECT value FROM settings WHERE key = ?', [key]);
    return rows.length > 0 ? String(rows[0]!['value']) : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.driver.query(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, Date.now()],
    );
  }

  // ---- export ----

  /** Everything the user owns, in one structure (rule: no feature traps data). */
  async exportAll(): Promise<ExportedData> {
    const [collections, places, trackRows, settingRows] = await Promise.all([
      this.listCollections(),
      this.listPlaces(),
      this.driver.query('SELECT * FROM tracks ORDER BY name'),
      this.driver.query('SELECT key, value FROM settings'),
    ]);
    const settings: Record<string, string> = {};
    for (const row of settingRows) settings[String(row['key'])] = String(row['value']);
    return {
      exportedAt: Date.now(),
      collections,
      places,
      tracks: trackRows.map((r) => ({ ...rowToTrack(r), gpx: String(r['gpx']) })),
      settings,
    };
  }

  /** UPDATE the defined entries of `columns` on one row, stamping updated_at. */
  private async applyPatch(
    table: 'places' | 'tracks',
    id: string,
    columns: Record<string, SqlValue | undefined>,
  ): Promise<void> {
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined) as [
      string,
      SqlValue,
    ][];
    if (entries.length === 0) return;
    const sets = entries.map(([column]) => `${column} = ?`).join(', ');
    await this.driver.query(`UPDATE ${table} SET ${sets}, updated_at = ? WHERE id = ?`, [
      ...entries.map(([, v]) => v),
      Date.now(),
      id,
    ]);
  }
}
