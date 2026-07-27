import { AtlasStorage, StorageUnavailableError, createWorkerSqlDriver } from '@atlas/storage';
import type { SqlDriver } from '@atlas/storage';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The name of the origin-wide lock that stands for "this page owns the user
 * database". It is not what enforces the single-writer rule — OPFS does that,
 * by handing out exclusive file handles — it is what lets us *know* we are the
 * second page instead of inferring it from a DOMException, and what tells us
 * the moment the first one lets go.
 */
const OWNER_LOCK = 'atlas.storage.owner';

interface Ownership {
  release: () => void;
}

const locks = (): LockManager | null =>
  typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null;

/**
 * Take ownership of the database for this page, or report that another page
 * already has it. The lock is held until `release` (storage closed) or until
 * the page goes away, whichever comes first — the browser cleans up the latter.
 */
async function acquireOwnership(): Promise<Ownership | null> {
  const manager = locks();
  // No Web Locks (Safari < 15.4): open anyway and let OPFS arbitrate, exactly
  // as before — we simply lose the ability to name the reason precisely.
  if (!manager) return { release: () => undefined };

  return new Promise<Ownership | null>((settle) => {
    void manager
      .request(OWNER_LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          settle(null);
          return undefined;
        }
        // Holding a lock means not resolving the callback's promise: this one
        // is settled by `release`, which is what hands ownership on.
        return new Promise<void>((releaseHeld) => {
          settle({ release: releaseHeld });
        });
      })
      .catch(() => settle(null));
  });
}

/**
 * Resolve once no other page owns the database — i.e. the tab holding it was
 * closed. Ownership is taken (briefly) and immediately given up again; the
 * caller re-opens, which takes it properly.
 */
export function awaitAvailability(signal: AbortSignal): Promise<void> {
  const manager = locks();
  if (!manager) return Promise.reject(new Error('Web Locks unavailable'));
  return manager.request(OWNER_LOCK, { signal }, () => undefined).then(() => undefined);
}

/** OPFS refusing a second exclusive handle — a busy database, not a broken one. */
function isBusyFailure(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return (
    text.includes('NoModificationAllowedError') ||
    text.includes('Access Handles cannot be created') ||
    text.includes('sahpool')
  );
}

function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

async function openOnce(ownership: Ownership): Promise<AtlasStorage> {
  const worker = new Worker(new URL('./storage.worker.ts', import.meta.url), {
    type: 'module',
  });
  const driver = await createWorkerSqlDriver(worker);
  // Ownership lasts exactly as long as the open database does, so closing the
  // storage is what hands the lock (and the OPFS handles) to a waiting page.
  // Armed only once the open has succeeded: a failed attempt tears its own
  // worker down and must keep the lock for the retry behind it.
  let handOver: () => void = () => undefined;
  const owned: SqlDriver = {
    ...driver,
    close: async () => {
      try {
        await driver.close?.();
      } finally {
        handOver();
      }
    },
  };
  const storage = new AtlasStorage(owned);
  try {
    await storage.init();
  } catch (err) {
    await storage.close().catch(() => undefined);
    throw err;
  }
  handOver = ownership.release;
  return storage;
}

/**
 * Open the persistent user-data database: SQLite-WASM over OPFS, hosted in a
 * dedicated worker (rule 2: apps go through the storage package, never touch
 * the database directly).
 *
 * The OPFS SAH pool takes exclusive file handles, so exactly one page per
 * origin can have the database. That is not a bug to work around, but it must
 * be *legible*: this function distinguishes "another page has it" (recoverable
 * on its own — see `awaitAvailability`) from "this browser cannot store data"
 * and from a genuine failure, so the app can say which.
 *
 * A page that has just closed (navigation, tab restore) can still be releasing
 * its handles, so a failed open is retried briefly before being reported.
 */
export async function openStorage(): Promise<AtlasStorage> {
  if (!opfsSupported()) throw new StorageUnavailableError('unsupported');

  const ownership = await acquireOwnership();
  if (!ownership) throw new StorageUnavailableError('busy');

  const retryDelaysMs = [0, 300, 900];
  let last: unknown;
  for (const ms of retryDelaysMs) {
    if (ms > 0) await delay(ms);
    try {
      return await openOnce(ownership);
    } catch (err) {
      last = err;
    }
  }
  ownership.release();
  // We hold the lock, so an OPFS refusal here means handles held by a page
  // that predates it (an older bundle, or one the browser has not torn down
  // yet) — still "busy", still worth waiting out.
  throw new StorageUnavailableError(
    isBusyFailure(last) ? 'busy' : 'failed',
    last instanceof Error ? last.message : undefined,
  );
}
