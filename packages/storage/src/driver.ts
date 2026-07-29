/** A value SQLite can bind or return. */
export type SqlValue = number | string | null | Uint8Array;

/** A result row keyed by column name. */
export type SqlRow = Record<string, SqlValue>;

/** One parameterized statement, as queued into an atomic batch. */
export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

/**
 * Minimal async SQL execution interface the storage layer is written against.
 * Implementations: SQLite-WASM in a Web Worker (production web), `node:sqlite`
 * (tests), native SQLite via expo-sqlite (Android).
 */
export interface SqlDriver {
  /** Execute a single parameterized statement and return its result rows. */
  query(sql: string, params?: SqlValue[]): Promise<SqlRow[]>;
  /**
   * Execute several parameterized statements in one transaction — all applied
   * or none. Storage couples every authoritative-row write with its sync-outbox
   * write through this, so a crash can never create data that silently fails
   * to sync (or an outbox entry for data that was never written).
   */
  batch(statements: SqlStatement[]): Promise<void>;
  /** Execute a multi-statement script (no parameters, no results) — used for migrations. */
  execScript(sql: string): Promise<void>;
  /**
   * Temporarily release external resources without making the driver
   * unusable. The web OPFS driver uses this to hand its exclusive SAH-pool
   * handles to another page while this page is frozen in the back/forward
   * cache. Other drivers do not need to implement it.
   */
  pause?(): Promise<void>;
  /** Reacquire resources released by pause(). */
  resume?(): Promise<void>;
  close?(): Promise<void>;
}
