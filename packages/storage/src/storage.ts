import { DEFAULT_PLACE_COLOR, DEFAULT_PLACE_ICON } from '@atlas/core';

import type { SqlDriver, SqlRow, SqlValue } from './driver.js';
import { migrate } from './migrations.js';
import type {
  CollectionPatch,
  CollectionRecord,
  DeletedRecord,
  ExportedData,
  ImportSummary,
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

/**
 * The LWW timestamp to import a dumped record under. Hand-edited or
 * older-format dumps may carry no usable updated_at; falling back to createdAt
 * (then to 0) keeps such a record importable while making sure it can never
 * out-rank a real local edit.
 */
function stampOf(updatedAt: unknown, createdAt: unknown): number {
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) return updatedAt;
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt;
  return 0;
}

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
      parent_id: patch.parentId,
      visible: patch.visible === undefined ? undefined : patch.visible ? 1 : 0,
      sort_index: patch.sortIndex,
    });
  }

  /**
   * Move a collection under another collection, or back to the root. The
   * explicit hierarchy check keeps malformed UI/sync input from creating a
   * parent cycle that would strand the whole subtree.
   */
  async moveCollection(id: string, parentId: string | null): Promise<void> {
    const rows = await this.driver.query('SELECT id, parent_id FROM collections');
    const parents = new Map(
      rows.map((row) => [
        String(row['id']),
        row['parent_id'] === null ? null : String(row['parent_id']),
      ]),
    );
    if (!parents.has(id)) throw new Error('Collection not found');
    if (parentId !== null && !parents.has(parentId)) throw new Error('Parent collection not found');

    const visited = new Set<string>();
    let ancestor = parentId;
    while (ancestor !== null && !visited.has(ancestor)) {
      if (ancestor === id) throw new Error('A collection cannot be moved into its own subtree');
      visited.add(ancestor);
      ancestor = parents.get(ancestor) ?? null;
    }

    if (parents.get(id) === parentId) return;
    await this.updateCollection(id, { parentId });
  }

  /**
   * Delete a collection. Its contents and child collections move to its
   * parent (or the root) — deleting a folder never deletes user data.
   * Returns a snapshot for undo (null when the id is unknown).
   */
  async deleteCollection(id: string): Promise<DeletedRecord | null> {
    const snapshot = await this.readSyncRecord('collection', id);
    const rows = await this.driver.query('SELECT parent_id FROM collections WHERE id = ?', [id]);
    if (rows.length === 0 || snapshot === null) return null;
    const parentId = rows[0]!['parent_id'] ?? null;
    const now = Date.now();
    const movedChildren: { entity: SyncEntity; id: string }[] = [];
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
      for (const row of moved) {
        await this.enqueue(entity, String(row['id']), 'upsert', now);
        movedChildren.push({ entity, id: String(row['id']) });
      }
    }
    const children = await this.driver.query('SELECT id FROM collections WHERE parent_id = ?', [
      id,
    ]);
    await this.driver.query(
      'UPDATE collections SET parent_id = ?, updated_at = ? WHERE parent_id = ?',
      [parentId, now, id],
    );
    for (const row of children) {
      await this.enqueue('collection', String(row['id']), 'upsert', now);
      movedChildren.push({ entity: 'collection', id: String(row['id']) });
    }
    await this.driver.query('DELETE FROM collections WHERE id = ?', [id]);
    await this.enqueue('collection', id, 'delete', now);
    return { entity: 'collection', id, data: snapshot.data, movedChildren };
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

  /** Delete a place, returning a snapshot for undo (null when unknown). */
  async deletePlace(id: string): Promise<DeletedRecord | null> {
    const snapshot = await this.readSyncRecord('place', id);
    await this.driver.query('DELETE FROM places WHERE id = ?', [id]);
    await this.enqueue('place', id, 'delete', Date.now());
    return snapshot && { entity: 'place', id, data: snapshot.data };
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

  /** Delete a track, returning a snapshot for undo (null when unknown). */
  async deleteTrack(id: string): Promise<DeletedRecord | null> {
    const snapshot = await this.readSyncRecord('track', id);
    await this.driver.query('DELETE FROM tracks WHERE id = ?', [id]);
    await this.enqueue('track', id, 'delete', Date.now());
    return snapshot && { entity: 'track', id, data: snapshot.data };
  }

  /**
   * Put back a record removed by delete*, under its original id, and re-parent
   * the children a folder deletion moved up. The restore is a normal local
   * mutation: it stamps a fresh updated_at and enqueues an upsert, so LWW
   * carries the undo to other devices rather than letting the older delete win.
   */
  async restore(deleted: DeletedRecord): Promise<void> {
    const now = Date.now();
    await this.upsertFromRemote({
      entity: deleted.entity,
      id: deleted.id,
      updatedAt: now,
      deleted: false,
      data: deleted.data,
    });
    await this.enqueue(deleted.entity, deleted.id, 'upsert', now);
    for (const child of deleted.movedChildren ?? []) {
      if (child.entity === 'collection') {
        await this.driver.query(
          'UPDATE collections SET parent_id = ?, updated_at = ? WHERE id = ?',
          [deleted.id, now, child.id],
        );
      } else {
        const table = child.entity === 'place' ? 'places' : 'tracks';
        await this.driver.query(
          `UPDATE ${table} SET collection_id = ?, updated_at = ? WHERE id = ?`,
          [deleted.id, now, child.id],
        );
      }
      await this.enqueue(child.entity, child.id, 'upsert', now);
    }
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

  /**
   * Merge an export dump back in (restore / backup import). Records merge by
   * id under the same last-write-wins rule sync uses, so importing is safe to
   * repeat, safe to do onto a device that already has data, and safe to do on
   * two devices at once: a record only lands if the dump's copy is newer than
   * the local one. Unlike a sync pull this *does* write the outbox — an import
   * is a local mutation and must propagate to the user's other devices.
   *
   * A dump has no tombstones, so import only ever adds or updates; it can never
   * delete. Restoring an old backup therefore cannot remove newer work.
   */
  async importAll(dump: ExportedData): Promise<ImportSummary> {
    const summary: ImportSummary = {
      collections: { imported: 0, skipped: 0 },
      places: { imported: 0, skipped: 0 },
      tracks: { imported: 0, skipped: 0 },
      settings: { imported: 0, skipped: 0 },
    };
    const merge = async (
      entity: SyncEntity,
      id: string,
      updatedAt: number,
      data: Record<string, unknown>,
      into: { imported: number; skipped: number },
    ): Promise<void> => {
      const local = await this.localUpdatedAt(entity, id);
      if (local !== null && local >= updatedAt) {
        into.skipped += 1;
        return;
      }
      await this.upsertFromRemote({ entity, id, updatedAt, deleted: false, data });
      await this.enqueue(entity, id, 'upsert', updatedAt);
      into.imported += 1;
    };
    // Folders first, so places and tracks land on a parent that already exists.
    for (const c of dump.collections) {
      const updatedAt = stampOf(c.updatedAt, c.createdAt);
      await merge(
        'collection',
        c.id,
        updatedAt,
        {
          name: c.name,
          parentId: c.parentId,
          visible: c.visible,
          sortIndex: c.sortIndex,
          createdAt: c.createdAt,
        },
        summary.collections,
      );
    }
    for (const p of dump.places) {
      await merge(
        'place',
        p.id,
        stampOf(p.updatedAt, p.createdAt),
        {
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
        summary.places,
      );
    }
    for (const t of dump.tracks) {
      await merge(
        'track',
        t.id,
        stampOf(t.updatedAt, t.createdAt),
        {
          name: t.name,
          gpx: t.gpx,
          stats: t.stats,
          collectionId: t.collectionId,
          notes: t.notes,
          tags: t.tags,
          visible: t.visible,
          createdAt: t.createdAt,
        },
        summary.tracks,
      );
    }
    for (const [key, value] of Object.entries(dump.settings)) {
      // `local.` settings are device-private (sync cursor, device id, map
      // profile). Restoring another device's copy would corrupt this device's
      // sync state, so they are never imported — same rule as the pull path.
      if (key.startsWith(LOCAL_SETTING_PREFIX)) {
        summary.settings.skipped += 1;
        continue;
      }
      // Dumps carry settings as bare key/value with no timestamp, so an
      // imported setting cannot claim to be newer than a local edit: it lands
      // only where the key is absent (localUpdatedAt null).
      const local = await this.localUpdatedAt('setting', key);
      if (local !== null) {
        summary.settings.skipped += 1;
        continue;
      }
      await this.setSetting(key, value);
      summary.settings.imported += 1;
    }
    return summary;
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
   * How many local changes are waiting to be pushed. Counted in SQL rather
   * than by reading `listOutbox().length` — the UI polls this and an outbox
   * row's payload can be a whole GPX document.
   */
  async countOutbox(): Promise<number> {
    const rows = await this.driver.query('SELECT COUNT(*) AS n FROM outbox');
    return rows.length > 0 ? Number(rows[0]!['n']) : 0;
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
    // `local.` settings are device-private and never pushed; a server echoing one
    // back (buggy or hostile) must not clobber our sync cursor or device id.
    if (change.entity === 'setting' && change.id.startsWith(LOCAL_SETTING_PREFIX)) return 'skipped';
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
