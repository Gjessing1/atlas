import type { RegionPackManifest } from '@atlas/core';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { packDownloads, type PackJob } from './downloads';

const subscribe = (listener: () => void) => packDownloads.subscribe(listener);
const getSnapshot = () => packDownloads.snapshot();

export interface PackDownloadsController {
  /** Every pack currently being downloaded, installed or waiting to resume. */
  jobs: PackJob[];
  /** Start or resume a download. `wifiOnly` holds it until an unmetered network. */
  start: (manifest: RegionPackManifest, wifiOnly?: boolean) => void;
  /** Stop a download; what has landed stays for a later resume. */
  cancel: (id: string) => void;
  /** Drop a failed/stopped job's record (also used when a pack is deleted). */
  dismiss: (id: string) => void;
}

/**
 * The app's live view of its background pack downloads.
 *
 * Reconciles on mount and every time Atlas comes back to the foreground: the
 * bytes may have arrived while it was away, and that is the moment to verify,
 * unpack and swap the pack into place. `onInstalled` is read through a ref so a
 * caller that passes a fresh closure each render cannot restart the effect.
 */
export function usePackDownloads(onInstalled: () => void): PackDownloadsController {
  const jobs = useSyncExternalStore(subscribe, getSnapshot);
  const installed = useRef(onInstalled);
  installed.current = onInstalled;

  useEffect(() => packDownloads.onInstalled(() => installed.current()), []);

  useEffect(() => {
    void packDownloads.refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void packDownloads.refresh();
    });
    return () => subscription.remove();
  }, []);

  return useMemo(
    () => ({
      jobs,
      start: (manifest, wifiOnly = false) => void packDownloads.start(manifest, wifiOnly),
      cancel: (id) => packDownloads.cancel(id),
      dismiss: (id) => packDownloads.forget(id),
    }),
    [jobs],
  );
}
