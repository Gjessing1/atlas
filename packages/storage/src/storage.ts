import { DEFAULT_PLACE_COLOR, DEFAULT_PLACE_ICON } from '@atlas/core';

import type { SqlDriver, SqlRow, SqlValue } from './driver.js';
import { migrate } from './migrations.js';
import type {
  CollectionPatch,
  CollectionRecord,
  ExportedData,
  NewPlace,
  NewTrack,
  OutboxEntry,
  PlacePatch,
  PlaceRecord,
  SyncChange,
  SyncEntity,
  TrackPatch,
  TrackRecord,
} from './records.js';

/**
 * Settings whose keys start with this prefix stay on this device — they are
 * never enqueued for sync (used e.g. for the sync cursor itself).
 */
export const LOCAL_SETTING_PREFIX = 'local.';

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
    visible: r['visible'] == null ? true : Number(r['visible']) !== 0,
    sortIndex: r['sort_index'] == null ? 0 : Number(r['sort_index']),
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
    icon: r['icon'] == null ? DEFAULT_PLACE_ICON : String(r['icon']),
    color: r['color'] == null ? DEFAULT_PLACE_COLOR : String(r['color']),
    visible: r['visible'] == null ? true : Number(r['visible']) !== 0,
    sortIndex: r['sort_index'] == null ? 0 : Number(r['sort_index']),
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
    const rows = await this.driver.query('SELECT * FROM collections ORDER BY sort_index, name');
    return rows.map(rowToCollection);
  }

  async createCollection(name: string, parentId: string | null = null): Promise<CollectionRecord> {
    const now = Date.now();
    const record: CollectionRecord = {
      id: crypto.randomUUID(),
      name,
      parentId,
      visible: true,
      // created_at dwarfs the renumbered ranks (1..n), so new rows list last.
      sortIndex: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.driver.query(
      `INSERT INTO collections (id, name, parent_id, created_at, updated_at, visible, sort_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.name,
        record.parentId,
        record.createdAt,
        record.updatedAt,
        record.visible ? 1 : 0,
        record.sortIndex,
      ],
    );
    await this.enqueue('collection', record.id, 'upsert', now);
    return record;
  }

  async renameCollection(id: string, name: string): Promise<void> {
    const now = Date.now();
    await this.driver.query('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?', [
      name,
      now,
      id,
    ]);
    await this.enqueue('collection', id, 'upsert', now);
  }

  /** Show or hide a folder (and, via effective visibility, everything under it). */
  async setCollectionVisible(id: string, visible: boolean): Promise<void> {
    await this.updateCollection(id, { visible });
  }

  async updateCollection(id: string, patch: CollectionPatch): Promise<void> {
    await this.applyPatch('collections', 'collection', id, {
      visible: patch.visible === undefined ? undefined : patch.visible ? 1 : 0,
      sort_index: patch.sortIndex,
    });
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
    for (const [table, entity] of [
      ['places', 'place'],
      ['tracks', 'track'],
    ] as const) {
      const moved = await this.driver.query(`SELECT id FROM ${table} WHERE collection_id = ?`, [
        id,
      ]);
      await this.driver.query(
        `UPDATE ${table} SET collection_id = ?, updated_at = ? WHERE collection_id = ?`,
        [parentId, now, id],
      );
      for (const row of moved) await this.enqueue(entity, String(row['id']), 'upsert', now);
    }
    const children = await this.driver.query('SELECT id FROM collections WHERE parent_id = ?', [
      id,
    ]);
    await this.driver.query(
      'UPDATE collections SET parent_id = ?, updated_at = ? WHERE parent_id = ?',
      [parentId, now, id],
    );
    for (const row of children) await this.enqueue('collection', String(row['id']), 'upsert', now);
    await this.driver.query('DELETE FROM collections WHERE id = ?', [id]);
    await this.enqueue('collection', id, 'delete', now);
  }

  // ---- places ----

  async listPlaces(): Promise<PlaceRecord[]> {
    const rows = await this.driver.query('SELECT * FROM places ORDER BY sort_index, name');
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
      icon: input.icon ?? DEFAULT_PLACE_ICON,
      color: input.color ?? DEFAULT_PLACE_COLOR,
      visible: true,
      // created_at dwarfs the renumbered ranks (1..n), so new rows list last.
      sortIndex: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.driver.query(
      `INSERT INTO places (id, name, lat, lng, collection_id, notes, tags,
                           created_at, updated_at, icon, color, visible, sort_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.name,
        record.lat,
        record.lng,
        record.collectionId,
        record.notes,
        JSON.stringify(record.tags),
        record.createdAt,
        record.updatedAt,
        record.icon,
        record.color,
        record.visible ? 1 : 0,
        record.sortIndex,
      ],
    );
    await this.enqueue('place', record.id, 'upsert', now);
    return record;
  }

  async updatePlace(id: string, patch: PlacePatch): Promise<void> {
    await this.applyPatch('places', 'place', id, {
      name: patch.name,
      lat: patch.lat,
      lng: patch.lng,
      collection_id: patch.collectionId,
      notes: patch.notes,
      tags: patch.tags === undefined ? undefined : JSON.stringify(patch.tags),
      icon: patch.icon,
      color: patch.color,
      visible: patch.visible === undefined ? undefined : patch.visible ? 1 : 0,
      sort_index: patch.sortIndex,
    });
  }

  /**
   * Persist a drag-and-drop arrangement: the ids in their new order get
   * sequential sort indexes (1..n). Only rows whose position actually changed
   * are written, so an unchanged drop doesn't churn updated_at or the outbox.
   */
  async reorderPlaces(orderedIds: string[]): Promise<void> {
    await this.reorderRows('places', 'place', orderedIds);
  }

  async reorderCollections(orderedIds: string[]): Promise<void> {
    await this.reorderRows('collections', 'collection', orderedIds);
  }

  private async reorderRows(
    table: 'places' | 'collections',
    entity: SyncEntity,
    orderedIds: string[],
  ): Promise<void> {
    const rows = await this.driver.query(`SELECT id, sort_index FROM ${table}`);
    const current = new Map(rows.map((r) => [String(r['id']), Number(r['sort_index'])]));
    for (const [i, id] of orderedIds.entries()) {
      const sortIndex = i + 1;
      if (!current.has(id) || current.get(id) === sortIndex) continue;
      await this.applyPatch(table, entity, id, { sort_index: sortIndex });
    }
  }

  async deletePlace(id: string): Promise<void> {
    await this.driver.query('DELETE FROM places WHERE id = ?', [id]);
    await this.enqueue('place', id, 'delete', Date.now());
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
    await this.driver.query(
      `INSERT INTO tracks (id, name, gpx, stats, collection_id, notes, tags,
                           visible, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
    );
    await this.enqueue('track', record.id, 'upsert', now);
    return record;
  }

  async updateTrack(id: string, patch: TrackPatch): Promise<void> {
    await this.applyPatch('tracks', 'track', id, {
      name: patch.name,
      collection_id: patch.collectionId,
      notes: patch.notes,
      tags: patch.tags === undefined ? undefined : JSON.stringify(patch.tags),
      visible: patch.visible === undefined ? undefined : patch.visible ? 1 : 0,
    });
  }

  async deleteTrack(id: string): Promise<void> {
    await this.driver.query('DELETE FROM tracks WHERE id = ?', [id]);
    await this.enqueue('track', id, 'delete', Date.now());
  }

  // ---- settings ----

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.driver.query('SELECT value FROM settings WHERE key = ?', [key]);
    return rows.length > 0 ? String(rows[0]!['value']) : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const now = Date.now();
    await this.driver.query(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, now],
    );
    if (!key.startsWith(LOCAL_SETTING_PREFIX)) await this.enqueue('setting', key, 'upsert', now);
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

  // ---- sync support (used by @atlas/sync, not by application code) ----

  /** Pending local mutations, oldest state wins nothing — LWW keeps one per record. */
  async listOutbox(): Promise<OutboxEntry[]> {
    const rows = await this.driver.query('SELECT * FROM outbox ORDER BY updated_at');
    return rows.map((r) => ({
      entity: String(r['entity']) as SyncEntity,
      id: String(r['id']),
      op: String(r['op']) as OutboxEntry['op'],
      updatedAt: Number(r['updated_at']),
    }));
  }

  /**
   * Remove outbox entries after a successful push. Guarded by updated_at so an
   * entry that was overwritten by a newer local change mid-push stays queued.
   */
  async clearOutbox(entries: OutboxEntry[]): Promise<void> {
    for (const e of entries) {
      await this.driver.query('DELETE FROM outbox WHERE entity = ? AND id = ? AND updated_at = ?', [
        e.entity,
        e.id,
        e.updatedAt,
      ]);
    }
  }

  /**
   * Current state of one record as a sync payload (`data` excludes id and
   * updatedAt, which travel in the change envelope). Null when the record no
   * longer exists locally.
   */
  async readSyncRecord(
    entity: SyncEntity,
    id: string,
  ): Promise<{ updatedAt: number; data: Record<string, unknown> } | null> {
    if (entity === 'setting') {
      const rows = await this.driver.query('SELECT value, updated_at FROM settings WHERE key = ?', [
        id,
      ]);
      if (rows.length === 0) return null;
      return {
        updatedAt: Number(rows[0]!['updated_at']),
        data: { value: String(rows[0]!['value']) },
      };
    }
    const table = { collection: 'collections', place: 'places', track: 'tracks' }[entity];
    const rows = await this.driver.query(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (rows.length === 0) return null;
    const r = rows[0]!;
    const updatedAt = Number(r['updated_at']);
    if (entity === 'collection') {
      const c = rowToCollection(r);
      return {
        updatedAt,
        data: {
          name: c.name,
          parentId: c.parentId,
          visible: c.visible,
          sortIndex: c.sortIndex,
          createdAt: c.createdAt,
        },
      };
    }
    if (entity === 'place') {
      const p = rowToPlace(r);
      return {
        updatedAt,
        data: {
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          collectionId: p.collectionId,
          notes: p.notes,
          tags: p.tags,
          icon: p.icon,
          color: p.color,
          visible: p.visible,
          sortIndex: p.sortIndex,
          createdAt: p.createdAt,
        },
      };
    }
    const t = rowToTrack(r);
    return {
      updatedAt,
      data: {
        name: t.name,
        gpx: String(r['gpx']),
        stats: t.stats,
        collectionId: t.collectionId,
        notes: t.notes,
        tags: t.tags,
        visible: t.visible,
        createdAt: t.createdAt,
      },
    };
  }

  /**
   * Apply one change arriving from the server, last-write-wins against the
   * local row. Never writes the outbox (remote state must not echo back), and
   * clears any pending outbox entry the change supersedes.
   */
  async applyRemoteChange(change: SyncChange): Promise<'applied' | 'skipped'> {
    const local = await this.localUpdatedAt(change.entity, change.id);
    if (local !== null && local >= change.updatedAt) return 'skipped';
    if (change.deleted) {
      if (change.entity === 'setting') {
        await this.driver.query('DELETE FROM settings WHERE key = ?', [change.id]);
      } else {
        const table = { collection: 'collections', place: 'places', track: 'tracks' }[
          change.entity
        ];
        await this.driver.query(`DELETE FROM ${table} WHERE id = ?`, [change.id]);
      }
    } else {
      if (change.data === null) return 'skipped';
      await this.upsertFromRemote(change);
    }
    await this.driver.query('DELETE FROM outbox WHERE entity = ? AND id = ? AND updated_at <= ?', [
      change.entity,
      change.id,
      change.updatedAt,
    ]);
    return 'applied';
  }

  /**
   * Queue every existing record for push — the bootstrap when sync is enabled
   * on data created before login (the outbox may predate the account).
   */
  async enqueueFullState(): Promise<void> {
    await this.driver.query(
      `INSERT OR REPLACE INTO outbox (entity, id, op, updated_at)
       SELECT 'collection', id, 'upsert', updated_at FROM collections`,
    );
    await this.driver.query(
      `INSERT OR REPLACE INTO outbox (entity, id, op, updated_at)
       SELECT 'place', id, 'upsert', updated_at FROM places`,
    );
    await this.driver.query(
      `INSERT OR REPLACE INTO outbox (entity, id, op, updated_at)
       SELECT 'track', id, 'upsert', updated_at FROM tracks`,
    );
    await this.driver.query(
      `INSERT OR REPLACE INTO outbox (entity, id, op, updated_at)
       SELECT 'setting', key, 'upsert', updated_at FROM settings WHERE key NOT LIKE ?`,
      [`${LOCAL_SETTING_PREFIX}%`],
    );
  }

  private async localUpdatedAt(entity: SyncEntity, id: string): Promise<number | null> {
    const rows =
      entity === 'setting'
        ? await this.driver.query('SELECT updated_at FROM settings WHERE key = ?', [id])
        : await this.driver.query(
            `SELECT updated_at FROM ${
              { collection: 'collections', place: 'places', track: 'tracks' }[entity]
            } WHERE id = ?`,
            [id],
          );
    return rows.length > 0 ? Number(rows[0]!['updated_at']) : null;
  }

  private async upsertFromRemote(change: SyncChange): Promise<void> {
    const d = change.data!;
    const str = (k: string, fallback = ''): string =>
      typeof d[k] === 'string' ? (d[k] as string) : fallback;
    const num = (k: string, fallback = 0): number =>
      typeof d[k] === 'number' ? (d[k] as number) : fallback;
    const strOrNull = (k: string): string | null =>
      typeof d[k] === 'string' ? (d[k] as string) : null;
    const json = (k: string, fallback: string): string => {
      try {
        return d[k] === undefined ? fallback : JSON.stringify(d[k]);
      } catch {
        return fallback;
      }
    };
    const createdAt = num('createdAt', change.updatedAt);
    switch (change.entity) {
      case 'collection':
        await this.driver.query(
          `INSERT OR REPLACE INTO collections
             (id, name, parent_id, created_at, updated_at, visible, sort_index)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            change.id,
            str('name', '(unnamed)'),
            strOrNull('parentId'),
            createdAt,
            change.updatedAt,
            d['visible'] === false ? 0 : 1,
            num('sortIndex', createdAt),
          ],
        );
        break;
      case 'place':
        await this.driver.query(
          `INSERT OR REPLACE INTO places
             (id, name, lat, lng, collection_id, notes, tags,
              created_at, updated_at, icon, color, visible, sort_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            change.id,
            str('name', '(unnamed)'),
            num('lat'),
            num('lng'),
            strOrNull('collectionId'),
            str('notes'),
            json('tags', '[]'),
            createdAt,
            change.updatedAt,
            str('icon', DEFAULT_PLACE_ICON),
            str('color', DEFAULT_PLACE_COLOR),
            d['visible'] === false ? 0 : 1,
            num('sortIndex', createdAt),
          ],
        );
        break;
      case 'track':
        await this.driver.query(
          `INSERT OR REPLACE INTO tracks
             (id, name, gpx, stats, collection_id, notes, tags,
              visible, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            change.id,
            str('name', '(unnamed)'),
            str('gpx'),
            json('stats', '{}'),
            strOrNull('collectionId'),
            str('notes'),
            json('tags', '[]'),
            d['visible'] === false ? 0 : 1,
            createdAt,
            change.updatedAt,
          ],
        );
        break;
      case 'setting':
        await this.driver.query(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [change.id, str('value'), change.updatedAt],
        );
        break;
    }
  }

  private async enqueue(
    entity: SyncEntity,
    id: string,
    op: OutboxEntry['op'],
    updatedAt: number,
  ): Promise<void> {
    await this.driver.query(
      'INSERT OR REPLACE INTO outbox (entity, id, op, updated_at) VALUES (?, ?, ?, ?)',
      [entity, id, op, updatedAt],
    );
  }

  /** UPDATE the defined entries of `columns` on one row, stamping updated_at. */
  private async applyPatch(
    table: 'places' | 'tracks' | 'collections',
    entity: SyncEntity,
    id: string,
    columns: Record<string, SqlValue | undefined>,
  ): Promise<void> {
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined) as [
      string,
      SqlValue,
    ][];
    if (entries.length === 0) return;
    const now = Date.now();
    const sets = entries.map(([column]) => `${column} = ?`).join(', ');
    await this.driver.query(`UPDATE ${table} SET ${sets}, updated_at = ? WHERE id = ?`, [
      ...entries.map(([, v]) => v),
      now,
      id,
    ]);
    await this.enqueue(entity, id, 'upsert', now);
  }
}
