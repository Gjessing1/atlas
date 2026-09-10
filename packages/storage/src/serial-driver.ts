import type { SqlDriver } from './driver.js';

/**
 * Run one database call at a time, in the order they were asked for.
 *
 * `SqlDriver.batch` promises atomicity — "all applied or none" — and every
 * caller in the tree relies on it, because storage couples an authoritative row
 * with its outbox entry in the same batch. What the contract never said is what
 * happens when two batches are in flight *at once*, and the three drivers
 * answer differently: the worker driver cannot overlap (SQLite-WASM's API is
 * synchronous, so each request runs to completion inside the worker before the
 * next message is delivered), neither can the node driver, for the same reason
 * — and Android's expo-sqlite driver could, with data loss as the result. So
 * the guarantee is stated here rather than left to each driver to happen to
 * have.
 *
 * The Android failure is worth naming, because nothing about it looks like a
 * concurrency bug from the call site. `withExclusiveTransactionAsync` opens a
 * *second connection* and BEGINs on it; expo sets no busy timeout, and one set
 * on the app's own connection would not reach that one anyway. So a second
 * batch starting while the first holds the write lock does not wait — it aborts
 * immediately with SQLite's `database is locked`. Nobody has to do anything
 * unusual to arrange that: the sync engine's pull lands while a toggle is being
 * written, two settings hydrate in the same tick, an import runs under a live
 * map. Whichever write lost simply never happened.
 *
 * Serializing costs nothing here. These are single-user, single-device
 * databases whose statements are keyed row reads and writes; there is no
 * throughput to trade away, and the alternative — a busy timeout, i.e. retry
 * until the lock frees — turns a lost write into a slow one only if every
 * connection involved agrees to it.
 *
 * Reads go through the same queue as writes. In SQLite's rollback-journal mode
 * a COMMIT takes an exclusive lock that fails concurrent readers exactly as it
 * fails concurrent writers, and a read that returns `database is locked`
 * instead of a row is the same bug wearing a different message.
 */
export function serializeDriver(driver: SqlDriver): SqlDriver {
  const { pause, resume, close } = driver;
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    // `then(work, work)` rather than a `finally`: the queue must advance
    // whether the call in front resolved or threw. The rejection itself belongs
    // to that call's own caller, so `tail` keeps a swallowed copy — chaining
    // the rejection instead would fail every call queued behind it, turning one
    // bad statement into a dead driver.
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  };

  return {
    query: (sql, params) => enqueue(() => driver.query(sql, params)),
    batch: (statements) => enqueue(() => driver.batch(statements)),
    execScript: (sql) => enqueue(() => driver.execScript(sql)),
    // Optional members stay optional: callers test for `pause` to decide
    // whether a platform can hand its handles over at all, and a wrapper that
    // always answered yes would promise a handover that never happens.
    ...(pause ? { pause: () => enqueue(() => pause.call(driver)) } : {}),
    ...(resume ? { resume: () => enqueue(() => resume.call(driver)) } : {}),
    ...(close ? { close: () => enqueue(() => close.call(driver)) } : {}),
  };
}
