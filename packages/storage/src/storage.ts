import { DEFAULT_PLACE_COLOR, DEFAULT_PLACE_ICON } from '@atlas/core';

import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from './driver.js';
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
  TrackAreaOverlay,
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

function parseTrackArea(value: SqlValue | undefined): TrackAreaOverlay | null {
  if (value == null || value === '') return null;
  try {
    const parsed = JSON.parse(String(value)) as Partial<TrackAreaOverlay>;
    const coordinate = (point: unknown): point is [number, number] =>
      Array.isArray(point) &&
      point.length === 2 &&
      typeof point[0] === 'number' &&
      typeof point[1] === 'number' &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]);
    const polygonsOk =
      Array.isArray(parsed.polygons) &&
      parsed.polygons.every(
        (polygon) =>
          Array.isArray(polygon) &&
          polygon.length > 0 &&
          polygon.every(
            (ring) =>
              Array.isArray(ring) && ring.length >= 3 && ring.every((point) => coordinate(point)),
          ),
      );
    const bboxOk =
      Array.isArray(parsed.bbox) &&
      parsed.bbox.length === 4 &&
      parsed.bbox.every((n) => typeof n === 'number' && Number.isFinite(n));
    if (
      parsed.kind !== 'area' ||
      parsed.source !== 'inatur' ||
      typeof parsed.sourceId !== 'string' ||
      !parsed.sourceId ||
      !polygonsOk ||
      !bboxOk
    ) {
      return null;
    }
    return parsed as TrackAreaOverlay;
  } catch {
    return null;
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
    address: r['address'] == null ? '' : String(r['address']),
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
    area: parseTrackArea(r['area']),
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  };
}

const TRACK_COLUMNS =
  'id, name, stats, collection_id, notes, tags, visible, area, created_at, updated_at';

/**
 * The user-data repository: collections (folders), places (favorites/pins),
 * tracks (GPX), and settings. All writes stamp `updated_at` for the
 * last-write-wins sync. Async throughout — the web driver crosses a worker
 * boundary. Every mutation commits its authoritative rows *and* their outbox
 * entries in one driver batch, so an interruption can never strand data that
 * silently fails to sync, or stop a multi-row operation halfway.
 */
export class AtlasStorage {
  /**
   * Highest LWW stamp this instance has issued or observed. Backs `tick()`,
   * the monotonic hybrid clock all mutations stamp `updated_at` from: raw
   * `Date.now()` would let a device whose clock stepped backwards issue edits
   * that lose to its own earlier ones, and a device whose clock lags another
   * device issue edits that lose to remote state it has already seen.
   */
  private lastVersion = 0;

  constructor(private readonly driver: SqlDriver) {}

  /** Run pending migrations; call once before anything else. */
  async init(): Promise<void> {
    await migrate(this.driver);
    // Seed the clock from everything stored: covers stamps issued before a
    // restart (in-memory state is gone) and remote stamps applied earlier.
    // The outbox is included because a pending delete's stamp lives only there.
    for (const table of ['collections', 'places', 'tracks', 'settings', 'outbox']) {
      const rows = await this.driver.query(`SELECT MAX(updated_at) AS m FROM ${table}`);
      const max = Number(rows[0]?.['m'] ?? 0);
      if (Number.isFinite(max) && max > this.lastVersion) this.lastVersion = max;
    }
  }

  /**
   * Issue the next LWW stamp: wall clock when it is ahead, else one past the
   * highest stamp seen. Every local mutation must outrank whatever state this
   * device has stored or observed, whatever the wall clock claims. (The server
   * clamps stamps that claim to be implausibly far in the future, bounding how
   * far one broken clock can drag this forward — see @atlas/sync.)
   */
  private tick(): number {
    const v = Math.max(Date.now(), this.lastVersion + 1);
    this.lastVersion = v;
    return v;
  }

  /**
   * Release the underlying database (web: closes the worker's SQLite handle,
   * freeing the exclusive OPFS locks, then terminates the worker). The
   * instance is unusable afterwards.
   */
  async close(): Promise<void> {
    await this.driver.close?.();
  }

  // ---- collections ----

  async listCollections(): Promise<CollectionRecord[]> {
    const rows = await this.driver.query('SELECT * FROM collections ORDER BY sort_index, name');
    return rows.map(rowToCollection);
  }

  async createCollection(name: string, parentId: string | null = null): Promise<CollectionRecord> {
    const now = this.tick();
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
    await this.driver.batch([
      {
        sql: `INSERT INTO collections (id, name, parent_id, created_at, updated_at, visible, sort_index)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          record.id,
          record.name,
          record.parentId,
          record.createdAt,
          record.updatedAt,
          record.visible ? 1 : 0,
          record.sortIndex,
        ],
      },
      this.enqueueStmt('collection', record.id, 'upsert', now),
    ]);
    return record;
  }

  async renameCollection(id: string, name: string): Promise<void> {
    const now = this.tick();
    await this.driver.batch([
      {
        sql: 'UPDATE collections SET name = ?, updated_at = ? WHERE id = ?',
        params: [name, now, id],
      },
      this.enqueueStmt('collection', id, 'upsert', now),
    ]);
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
    const now = this.tick();
    // Read the affected rows first, then apply the whole reparent + delete as
    // one transaction — a folder deletion must never stop halfway up a tree.
    const movedChildren: { entity: SyncEntity; id: string }[] = [];
    const statements: SqlStatement[] = [];
    for (const [table, entity] of [
      ['places', 'place'],
      ['tracks', 'track'],
    ] as const) {
      const moved = await this.driver.query(`SELECT id FROM ${table} WHERE collection_id = ?`, [
        id,
      ]);
      statements.push({
        sql: `UPDATE ${table} SET collection_id = ?, updated_at = ? WHERE collection_id = ?`,
        params: [parentId, now, id],
      });
      for (const row of moved) {
        statements.push(this.enqueueStmt(entity, String(row['id']), 'upsert', now));
        movedChildren.push({ entity, id: String(row['id']) });
      }
    }
    const children = await this.driver.query('SELECT id FROM collections WHERE parent_id = ?', [
      id,
    ]);
    statements.push({
      sql: 'UPDATE collections SET parent_id = ?, updated_at = ? WHERE parent_id = ?',
      params: [parentId, now, id],
    });
    for (const row of children) {
      statements.push(this.enqueueStmt('collection', String(row['id']), 'upsert', now));
      movedChildren.push({ entity: 'collection', id: String(row['id']) });
    }
    statements.push({ sql: 'DELETE FROM collections WHERE id = ?', params: [id] });
    statements.push(this.enqueueStmt('collection', id, 'delete', now));
    await this.driver.batch(statements);
    return { entity: 'collection', id, data: snapshot.data, movedChildren };
  }

  // ---- places ----

  async listPlaces(): Promise<PlaceRecord[]> {
    const rows = await this.driver.query('SELECT * FROM places ORDER BY sort_index, name');
    return rows.map(rowToPlace);
  }

  async createPlace(input: NewPlace): Promise<PlaceRecord> {
    const now = this.tick();
    const record: PlaceRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      lat: input.lat,
      lng: input.lng,
      address: input.address ?? '',
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
    await this.driver.batch([
      {
        sql: `INSERT INTO places (id, name, lat, lng, address, collection_id, notes, tags,
                                  created_at, updated_at, icon, color, visible, sort_index)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          record.id,
          record.name,
          record.lat,
          record.lng,
          record.address,
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
      },
      this.enqueueStmt('place', record.id, 'upsert', now),
    ]);
    return record;
  }

  async updatePlace(id: string, patch: PlacePatch): Promise<void> {
    await this.applyPatch('places', 'place', id, {
      name: patch.name,
      lat: patch.lat,
      lng: patch.lng,
      address: patch.address,
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
    const statements: SqlStatement[] = [];
    const now = this.tick();
    for (const [i, id] of orderedIds.entries()) {
      const sortIndex = i + 1;
      if (!current.has(id) || current.get(id) === sortIndex) continue;
      statements.push(...this.patchStmts(table, entity, id, { sort_index: sortIndex }, now));
    }
    // One transaction — a reorder either lands whole or not at all.
    if (statements.length > 0) await this.driver.batch(statements);
  }

  /** Delete a place, returning a snapshot for undo (null when unknown). */
  async deletePlace(id: string): Promise<DeletedRecord | null> {
    const snapshot = await this.readSyncRecord('place', id);
    await this.driver.batch([
      { sql: 'DELETE FROM places WHERE id = ?', params: [id] },
      this.enqueueStmt('place', id, 'delete', this.tick()),
    ]);
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
    const now = this.tick();
    const record: TrackRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      stats: input.stats ?? {},
      collectionId: input.collectionId ?? null,
      notes: input.notes ?? '',
      tags: input.tags ?? [],
      visible: true,
      area: input.area ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.driver.batch([
      {
        sql: `INSERT INTO tracks (id, name, gpx, stats, collection_id, notes, tags,
                                  visible, area, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          record.id,
          record.name,
          input.gpx,
          JSON.stringify(record.stats),
          record.collectionId,
          record.notes,
          JSON.stringify(record.tags),
          1,
          input.area ? JSON.stringify(input.area) : null,
          record.createdAt,
          record.updatedAt,
        ],
      },
      this.enqueueStmt('track', record.id, 'upsert', now),
    ]);
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
    await this.driver.batch([
      { sql: 'DELETE FROM tracks WHERE id = ?', params: [id] },
      this.enqueueStmt('track', id, 'delete', this.tick()),
    ]);
    return snapshot && { entity: 'track', id, data: snapshot.data };
  }

  /**
   * Put back a record removed by delete*, under its original id, and re-parent
   * the children a folder deletion moved up. The restore is a normal local
   * mutation: it stamps a fresh updated_at and enqueues an upsert, so LWW
   * carries the undo to other devices rather than letting the older delete win.
   */
  async restore(deleted: DeletedRecord): Promise<void> {
    const now = this.tick();
    const statements: SqlStatement[] = [
      this.upsertStmt({
        entity: deleted.entity,
        id: deleted.id,
        updatedAt: now,
        deleted: false,
        data: deleted.data,
      }),
      this.enqueueStmt(deleted.entity, deleted.id, 'upsert', now),
    ];
    for (const child of deleted.movedChildren ?? []) {
      if (child.entity === 'collection') {
        statements.push({
          sql: 'UPDATE collections SET parent_id = ?, updated_at = ? WHERE id = ?',
          params: [deleted.id, now, child.id],
        });
      } else {
        const table = child.entity === 'place' ? 'places' : 'tracks';
        statements.push({
          sql: `UPDATE ${table} SET collection_id = ?, updated_at = ? WHERE id = ?`,
          params: [deleted.id, now, child.id],
        });
      }
      statements.push(this.enqueueStmt(child.entity, child.id, 'upsert', now));
    }
    await this.driver.batch(statements);
  }

  // ---- settings ----

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.driver.query('SELECT value FROM settings WHERE key = ?', [key]);
    return rows.length > 0 ? String(rows[0]!['value']) : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const now = this.tick();
    const statements: SqlStatement[] = [this.settingUpsertStmt(key, value, now)];
    if (!key.startsWith(LOCAL_SETTING_PREFIX))
      statements.push(this.enqueueStmt('setting', key, 'upsert', now));
    await this.driver.batch(statements);
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
    // Compare against local state first, then commit every accepted record in
    // one transaction — a restore lands whole or not at all, never a torn tree.
    const statements: SqlStatement[] = [];
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
      statements.push(this.upsertStmt({ entity, id, updatedAt, deleted: false, data }));
      statements.push(this.enqueueStmt(entity, id, 'upsert', updatedAt));
      // Observe the dump's stamp, as with a pulled change: later local edits
      // must out-rank what was just restored.
      if (updatedAt > this.lastVersion) this.lastVersion = updatedAt;
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
          address: p.address,
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
          area: t.area,
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
      const now = this.tick();
      statements.push(this.settingUpsertStmt(key, value, now));
      statements.push(this.enqueueStmt('setting', key, 'upsert', now));
      summary.settings.imported += 1;
    }
    if (statements.length > 0) await this.driver.batch(statements);
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
    if (entries.length === 0) return;
    await this.driver.batch(
      entries.map((e) => ({
        sql: 'DELETE FROM outbox WHERE entity = ? AND id = ? AND updated_at = ?',
        params: [e.entity, e.id, e.updatedAt],
      })),
    );
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
          address: p.address,
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
        area: t.area,
        createdAt: t.createdAt,
      },
    };
  }

  /**
   * Apply one change arriving from the server, last-write-wins against the
   * local row. Never writes the outbox (remote state must not echo back), and
   * clears any pending outbox entry the change supersedes.
   *
   * An *equal* stamp applies: pulls exclude this device's own writes, so an
   * equal-stamp change is a genuine two-device tie the server has already
   * broken deterministically — taking the server's winner is what makes both
   * devices converge instead of each keeping its own copy forever.
   */
  async applyRemoteChange(change: SyncChange): Promise<'applied' | 'skipped'> {
    // `local.` settings are device-private and never pushed; a server echoing one
    // back (buggy or hostile) must not clobber our sync cursor or device id.
    if (change.entity === 'setting' && change.id.startsWith(LOCAL_SETTING_PREFIX)) return 'skipped';
    const local = await this.localUpdatedAt(change.entity, change.id);
    if (local !== null && local > change.updatedAt) return 'skipped';
    const statements: SqlStatement[] = [];
    if (change.deleted) {
      if (change.entity === 'setting') {
        statements.push({ sql: 'DELETE FROM settings WHERE key = ?', params: [change.id] });
      } else {
        const table = { collection: 'collections', place: 'places', track: 'tracks' }[
          change.entity
        ];
        statements.push({ sql: `DELETE FROM ${table} WHERE id = ?`, params: [change.id] });
      }
    } else {
      if (change.data === null) return 'skipped';
      statements.push(this.upsertStmt(change));
    }
    statements.push({
      sql: 'DELETE FROM outbox WHERE entity = ? AND id = ? AND updated_at <= ?',
      params: [change.entity, change.id, change.updatedAt],
    });
    await this.driver.batch(statements);
    // Observe the remote stamp: a later local edit — even on a lagging wall
    // clock — must out-rank the state it was made on top of.
    if (change.updatedAt > this.lastVersion) this.lastVersion = change.updatedAt;
    return 'applied';
  }

  /**
   * Queue every existing record for push — the bootstrap when sync is enabled
   * on data created before login (the outbox may predate the account).
   */
  async enqueueFullState(): Promise<void> {
    await this.driver.batch([
      {
        sql: `INSERT OR REPLACE INTO outbox (entity, id, op, updated_at)
              SELECT 'collection', id, 'upsert', updated_at FROM collections`,
      },
      {
        sql: `INSERT OR REPLACE INTO outbox (entity, id, op, updated_at)
              SELECT 'place', id, 'upsert', updated_at FROM places`,
      },
      {
        sql: `INSERT OR REPLACE INTO outbox (entity, id, op, updated_at)
              SELECT 'track', id, 'upsert', updated_at FROM tracks`,
      },
      {
        sql: `INSERT OR REPLACE INTO outbox (entity, id, op, updated_at)
              SELECT 'setting', key, 'upsert', updated_at FROM settings WHERE key NOT LIKE ?`,
        params: [`${LOCAL_SETTING_PREFIX}%`],
      },
    ]);
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

  /** The INSERT OR REPLACE statement writing one sync-payload record. */
  private upsertStmt(change: SyncChange): SqlStatement {
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
        return {
          sql: `INSERT OR REPLACE INTO collections
                  (id, name, parent_id, created_at, updated_at, visible, sort_index)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          params: [
            change.id,
            str('name', '(unnamed)'),
            strOrNull('parentId'),
            createdAt,
            change.updatedAt,
            d['visible'] === false ? 0 : 1,
            num('sortIndex', createdAt),
          ],
        };
      case 'place':
        return {
          sql: `INSERT OR REPLACE INTO places
                  (id, name, lat, lng, address, collection_id, notes, tags,
                   created_at, updated_at, icon, color, visible, sort_index)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            change.id,
            str('name', '(unnamed)'),
            num('lat'),
            num('lng'),
            str('address'),
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
        };
      case 'track':
        return {
          sql: `INSERT OR REPLACE INTO tracks
                  (id, name, gpx, stats, collection_id, notes, tags,
                   visible, area, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            change.id,
            str('name', '(unnamed)'),
            str('gpx'),
            json('stats', '{}'),
            strOrNull('collectionId'),
            str('notes'),
            json('tags', '[]'),
            d['visible'] === false ? 0 : 1,
            d['area'] == null ? null : json('area', 'null'),
            createdAt,
            change.updatedAt,
          ],
        };
      case 'setting':
        return this.settingUpsertStmt(change.id, str('value'), change.updatedAt);
    }
  }

  private settingUpsertStmt(key: string, value: string, updatedAt: number): SqlStatement {
    return {
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      params: [key, value, updatedAt],
    };
  }

  private enqueueStmt(
    entity: SyncEntity,
    id: string,
    op: OutboxEntry['op'],
    updatedAt: number,
  ): SqlStatement {
    return {
      sql: 'INSERT OR REPLACE INTO outbox (entity, id, op, updated_at) VALUES (?, ?, ?, ?)',
      params: [entity, id, op, updatedAt],
    };
  }

  /** The UPDATE + outbox statements patching the defined entries of `columns` on one row. */
  private patchStmts(
    table: 'places' | 'tracks' | 'collections',
    entity: SyncEntity,
    id: string,
    columns: Record<string, SqlValue | undefined>,
    now: number,
  ): SqlStatement[] {
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined) as [
      string,
      SqlValue,
    ][];
    if (entries.length === 0) return [];
    const sets = entries.map(([column]) => `${column} = ?`).join(', ');
    return [
      {
        sql: `UPDATE ${table} SET ${sets}, updated_at = ? WHERE id = ?`,
        params: [...entries.map(([, v]) => v), now, id],
      },
      this.enqueueStmt(entity, id, 'upsert', now),
    ];
  }

  /** UPDATE the defined entries of `columns` on one row, stamping updated_at. */
  private async applyPatch(
    table: 'places' | 'tracks' | 'collections',
    entity: SyncEntity,
    id: string,
    columns: Record<string, SqlValue | undefined>,
  ): Promise<void> {
    const statements = this.patchStmts(table, entity, id, columns, this.tick());
    if (statements.length > 0) await this.driver.batch(statements);
  }
}
