import { AtlasStorage, createWorkerSqlDriver } from '@atlas/storage';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openOnce(): Promise<AtlasStorage> {
  const worker = new Worker(new URL('./storage.worker.ts', import.meta.url), {
    type: 'module',
  });
  const driver = await createWorkerSqlDriver(worker);
  const storage = new AtlasStorage(driver);
  try {
    await storage.init();
  } catch (err) {
    await storage.close().catch(() => undefined);
    throw err;
  }
  return storage;
}

/**
 * Open the persistent user-data database: SQLite-WASM over OPFS, hosted in a
 * dedicated worker (rule 2: apps go through the storage package, never touch
 * the database directly). Rejects when the browser lacks OPFS/WASM support.
 *
 * The OPFS SAH pool takes exclusive file handles, and a page that has just
 * closed (navigation, tab restore) can still be releasing them — so a failed
 * open is retried briefly before being reported as unavailable. A second tab
 * open at the same time keeps failing, which is the intended single-tab rule.
 */
export async function openStorage(): Promise<AtlasStorage> {
  const retryDelaysMs = [300, 900];
  for (const ms of retryDelaysMs) {
    try {
      return await openOnce();
    } catch {
      await delay(ms);
    }
  }
  return openOnce();
}
