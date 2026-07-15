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
];

/** Bring the database up to the latest schema version. */
export async function migrate(driver: SqlDriver): Promise<void> {
  const rows = await driver.query('PRAGMA user_version');
  const version = Number(rows[0]?.['user_version'] ?? 0);
  for (let v = version; v < MIGRATIONS.length; v++) {
    await driver.execScript(MIGRATIONS[v]!);
    await driver.execScript(`PRAGMA user_version = ${v + 1}`);
  }
}
