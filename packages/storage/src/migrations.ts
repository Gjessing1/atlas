import type { SqlDriver } from './driver.js';

/**
 * Ordered migration scripts; `PRAGMA user_version` records how many have run.
 * Append-only — never edit an entry that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    collection_id TEXT,
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX places_collection ON places(collection_id);

  CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    gpx TEXT NOT NULL,
    stats TEXT NOT NULL DEFAULT '{}',
    collection_id TEXT,
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    visible INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tracks_collection ON tracks(collection_id);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE outbox (
    entity TEXT NOT NULL,
    id TEXT NOT NULL,
    op TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (entity, id)
  );
  `,
  // Per-place icon + colour (defaults match @atlas/core DEFAULT_PLACE_ICON/COLOR).
  `
  ALTER TABLE places ADD COLUMN icon TEXT NOT NULL DEFAULT '📍';
  ALTER TABLE places ADD COLUMN color TEXT NOT NULL DEFAULT '#e11d48';
  `,
  // Visibility toggles: hide/show individual places and whole folders on the
  // map. A place is drawn only when its own flag and every ancestor folder are
  // visible (see @atlas/core placeIsVisible). Existing rows default to shown.
  `
  ALTER TABLE places ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE collections ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
  `,
  // Manual ordering (drag-and-drop arranging). Lists sort by sort_index, then
  // name. Existing rows are backfilled with their alphabetical rank so nothing
  // visibly moves on upgrade; new rows use created_at, appending at the end.
  `
  ALTER TABLE places ADD COLUMN sort_index REAL NOT NULL DEFAULT 0;
  ALTER TABLE collections ADD COLUMN sort_index REAL NOT NULL DEFAULT 0;
  UPDATE places SET sort_index = (
    SELECT COUNT(*) FROM places p2
    WHERE p2.name < places.name OR (p2.name = places.name AND p2.id < places.id)
  ) + 1;
  UPDATE collections SET sort_index = (
    SELECT COUNT(*) FROM collections c2
    WHERE c2.name < collections.name OR (c2.name = collections.name AND c2.id < collections.id)
  ) + 1;
  `,
  // A distinct address survives search-result saves, sync and interoperable
  // exports without being mixed into free-form notes.
  `
  ALTER TABLE places ADD COLUMN address TEXT NOT NULL DEFAULT '';
  `,
  // A track may also be an area-shaped interoperable record (currently an
  // iNatur permit). GPX remains canonical for export; this JSON retains polygon
  // topology so the map can fill exterior rings without filling their holes.
  `
  ALTER TABLE tracks ADD COLUMN area TEXT;
  `,
];

/**
 * Bring the database up to the latest schema version. Each migration script
 * and its `user_version` bump commit as one transaction (`user_version` lives
 * in the database header and is journaled like any write), so a crash mid-way
 * can never leave a half-applied script or rerun a non-idempotent one.
 */
export async function migrate(
  driver: SqlDriver,
  migrations: readonly string[] = MIGRATIONS,
): Promise<void> {
  const rows = await driver.query('PRAGMA user_version');
  const version = Number(rows[0]?.['user_version'] ?? 0);
  for (let v = version; v < migrations.length; v++) {
    try {
      await driver.execScript(
        `BEGIN;\n${migrations[v]!}\nPRAGMA user_version = ${v + 1};\nCOMMIT;`,
      );
    } catch (err) {
      await driver.execScript('ROLLBACK').catch(() => {
        // Some failures abort the transaction on their own; nothing to roll back.
      });
      throw err;
    }
  }
}
