/**
 * Why the persistent user-data database could not be opened.
 *
 * `busy` is the one that matters: the web driver's OPFS SAH pool takes
 * *exclusive* file handles, so only one page per origin can hold the database.
 * A second one is not broken and not out of data — it is simply second, and it
 * recovers on its own once the first lets go. Telling it apart from a real
 * failure is the difference between "close the other tab" and "your data is
 * gone".
 */
export type StorageUnavailableReason = 'busy' | 'unsupported' | 'failed';

/**
 * Thrown by a platform's `openStorage` when the database cannot be opened, so
 * the app can say something true about it. Anything else thrown is treated as
 * `failed`.
 */
export class StorageUnavailableError extends Error {
  readonly reason: StorageUnavailableReason;

  constructor(reason: StorageUnavailableReason, message?: string) {
    super(message ?? describeStorageUnavailable(reason));
    this.name = 'StorageUnavailableError';
    this.reason = reason;
  }
}

/**
 * One sentence a user can act on, shared by both clients so they explain the
 * same state the same way. Deliberately free of "try again" — whether retrying
 * is even worth offering is the UI's call, and for `busy` it happens by itself.
 */
export function describeStorageUnavailable(reason: StorageUnavailableReason): string {
  switch (reason) {
    case 'busy':
      return 'Atlas is already open elsewhere, and that page is holding your saved data. Only one can have it at a time.';
    case 'unsupported':
      return 'This browser will not let Atlas store data on this device — private browsing usually blocks it.';
    case 'failed':
      return 'Your saved data could not be opened on this device.';
  }
}

/** Classify a caught open failure; anything unrecognised is a real failure. */
export function storageUnavailableReason(err: unknown): StorageUnavailableReason {
  return err instanceof StorageUnavailableError ? err.reason : 'failed';
}
