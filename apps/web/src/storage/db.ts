import { AtlasStorage, createWorkerSqlDriver } from '@atlas/storage';

/**
 * Open the persistent user-data database: SQLite-WASM over OPFS, hosted in a
 * dedicated worker (rule 2: apps go through the storage package, never touch
 * the database directly). Rejects when the browser lacks OPFS/WASM support.
 */
export async function openStorage(): Promise<AtlasStorage> {
  const worker = new Worker(new URL('./storage.worker.ts', import.meta.url), {
    type: 'module',
  });
  const driver = await createWorkerSqlDriver(worker);
  const storage = new AtlasStorage(driver);
  await storage.init();
  return storage;
}
