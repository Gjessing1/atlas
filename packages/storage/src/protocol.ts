import type { SqlRow, SqlStatement, SqlValue } from './driver.js';

/** Main thread → worker. */
export type StorageWorkerRequest =
  | { id: number; kind: 'query'; sql: string; params: SqlValue[] }
  | { id: number; kind: 'batch'; statements: SqlStatement[] }
  | { id: number; kind: 'script'; sql: string }
  | { id: number; kind: 'pause' }
  | { id: number; kind: 'resume' }
  | { id: number; kind: 'close' };

/** Worker → main thread. */
export type StorageWorkerResponse =
  | { type: 'ready' }
  // `busy` = the database is held by another page (recoverable by waiting),
  // as opposed to a database that cannot be opened at all.
  | { type: 'init-error'; error: string; busy?: boolean }
  | { type: 'result'; id: number; rows: SqlRow[] }
  | { type: 'error'; id: number; error: string };
