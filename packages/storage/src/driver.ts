/** A value SQLite can bind or return. */
export type SqlValue = number | string | null | Uint8Array;

/** A result row keyed by column name. */
export type SqlRow = Record<string, SqlValue>;

/**
 * Minimal async SQL execution interface the storage layer is written against.
 * Implementations: SQLite-WASM in a Web Worker (production web), `node:sqlite`
 * (tests), native SQLite (Android, later).
 */
export interface SqlDriver {
  /** Execute a single parameterized statement and return its result rows. */
  query(sql: string, params?: SqlValue[]): Promise<SqlRow[]>;
  /** Execute a multi-statement script (no parameters, no results) — used for migrations. */
  execScript(sql: string): Promise<void>;
  close?(): Promise<void>;
}
