import type { SqlDriver, SqlRow, SqlValue } from './driver.js';
import type { StorageWorkerRequest, StorageWorkerResponse } from './protocol.js';

/**
 * Main-thread SqlDriver that forwards statements to a storage worker (see
 * worker.ts). Resolves once the worker's database is open, so callers can fail
 * fast when OPFS/WASM is unavailable.
 */
export function createWorkerSqlDriver(worker: Worker): Promise<SqlDriver> {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (rows: SqlRow[]) => void; reject: (e: Error) => void }
  >();

  type Request = StorageWorkerRequest extends infer R
    ? R extends { id: number }
      ? Omit<R, 'id'>
      : never
    : never;

  const send = (request: Request): Promise<SqlRow[]> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...request, id });
    });

  const driver: SqlDriver = {
    query: (sql, params = []) => send({ kind: 'query', sql, params }),
    execScript: async (sql) => {
      await send({ kind: 'script', sql });
    },
    close: async () => {
      worker.terminate();
      const error = new Error('storage worker terminated');
      for (const { reject } of pending.values()) reject(error);
      pending.clear();
    },
  };

  return new Promise((resolveReady, rejectReady) => {
    worker.onmessage = (event: MessageEvent<StorageWorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'ready':
          resolveReady(driver);
          break;
        case 'init-error':
          rejectReady(new Error(msg.error));
          break;
        case 'result':
          pending.get(msg.id)?.resolve(msg.rows);
          pending.delete(msg.id);
          break;
        case 'error':
          pending.get(msg.id)?.reject(new Error(msg.error));
          pending.delete(msg.id);
          break;
      }
    };
    worker.onerror = (event) => {
      rejectReady(new Error(`storage worker failed: ${event.message}`));
    };
  });
}

export type { SqlValue };
