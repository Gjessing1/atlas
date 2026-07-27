import type { StorageAvailability } from '@atlas/app-hooks';
import { describeStorageUnavailable } from '@atlas/storage';
import { useState } from 'react';

/**
 * Says out loud that the user's saved data could not be opened. Without this
 * the failure was console-only: the map came up as usual, saving silently did
 * nothing, and the Account panel sat on "Opening local storage…" forever with
 * its buttons disabled — a dead end with no stated cause.
 *
 * Dismissible, because the map itself still works; the Account panel repeats
 * the same state where it actually blocks something.
 */
export function StorageBanner({ storage }: { storage: StorageAvailability }) {
  const [dismissed, setDismissed] = useState(false);
  const { status, errorReason } = storage;
  if (status !== 'error' || dismissed) return null;

  // The busy case gets its own wording: the shared sentence has to stand alone
  // elsewhere (Account panel, Android), so under a heading it repeats itself.
  const busy = errorReason === 'busy';
  return (
    <div className="storage-banner" role="alert">
      <div className="storage-banner-text">
        <strong>{busy ? 'Atlas is open in another window' : 'Saved data unavailable'}</strong>
        <span>
          {busy
            ? 'That window is holding your saved places and tracks — only one can have them at a time. Close it and this one picks them up.'
            : describeStorageUnavailable(errorReason ?? 'failed')}
        </span>
      </div>
      <button type="button" className="storage-banner-retry" onClick={storage.retry}>
        Try again
      </button>
      <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
