import type { SqlRow, SqlValue } from './driver.js';

/** Main thread → worker. */
export type StorageWorkerRequest =
  | { id: number; kind: 'query'; sql: string; params: SqlValue[] }
  | { id: number; kind: 'script'; sql: string };

/** Worker → main thread. */
export type StorageWorkerResponse =
  | { type: 'ready' }
  | { type: 'init-error'; error: string }
  | { type: 'result'; id: number; rows: SqlRow[] }
  | { type: 'error'; id: number; error: string };
