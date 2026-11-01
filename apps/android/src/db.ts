import { AtlasStorage, createConnectionDriver, serializeDriver } from '@atlas/storage';
import { openDatabaseAsync } from 'expo-sqlite';

/**
 * Open the persistent user-data database over the device's native SQLite
 * (expo-sqlite). Same storage layer as the web app; only the SqlDriver
 * differs (rule 2: apps go through the storage package, never touch the
 * database directly).
 *
 * Everything runs on **one** connection, behind {@link serializeDriver}. Those
 * two facts are the same decision: a transaction is only atomic against writes
 * it can actually exclude, and this driver's only concurrency is JavaScript's,
 * so a queue excludes all of it. The alternative on offer,
 * `withExclusiveTransactionAsync`, excludes by opening a second connection and
 * letting SQLite arbitrate — which, with no busy timeout on either side, means
 * the second of two overlapping batches aborts with `database is locked` and
 * its write is simply gone. That is what shipped until v0.202.0; it lost
 * settings quietly until `setSetting` started reporting failures, at which
 * point it started losing them loudly.
 *
 * The queue cannot exclude a connection it does not own, and the old runtime's
 * is one on every OTA restart; {@link createConnectionDriver} carries the WAL,
 * busy-timeout and retry answer to that. {@link releaseStorage} is the other
 * half: the restart closes our connection first, so it never outlives its
 * runtime with a half-run batch.
 */
let live: AtlasStorage | null = null;
let released = false;

const RELEASED = 'User data is closed for an app restart';

export async function openStorage(): Promise<AtlasStorage> {
  // After a release the runtime is on its way out; a remount reopening here
  // would hand the new runtime the very connection the release closed.
  if (released) throw new Error(RELEASED);
  const db = await openDatabaseAsync('atlas.db');
  if (released) {
    await db.closeAsync();
    throw new Error(RELEASED);
  }
  const driver = await createConnectionDriver(db);
  const storage = new AtlasStorage(
    serializeDriver({
      ...driver,
      close: async () => {
        if (live === storage) live = null;
        await driver.close!();
      },
    }),
  );
  // Live before init, not after: a release that lands mid-migration must still
  // close this connection. Its close queues behind the call in flight, and the
  // rest of init then fails on the closed handle, which is the point.
  live = storage;
  await storage.init();
  return storage;
}

/**
 * Close the open user-data database, after every call already queued on it.
 * For a JS restart only (the OTA relaunch): the storage handed to the app is
 * dead afterwards, and nothing reopens it in this runtime.
 */
export async function releaseStorage(): Promise<void> {
  released = true;
  const storage = live;
  live = null;
  await storage?.close();
}
