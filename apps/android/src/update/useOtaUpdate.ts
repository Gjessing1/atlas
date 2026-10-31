import * as Updates from 'expo-updates';
import { useCallback, useState } from 'react';

import appJson from '../../app.json';
import { releaseStorage } from '../db';

/**
 * The version of the *running JS bundle* — from app.json at bundle time, so an
 * OTA update carries its own number. Distinct from
 * Application.nativeApplicationVersion, which stays at whatever APK was last
 * installed.
 */
export const JS_VERSION: string = appJson.expo.version;

export type OtaStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error';

export interface OtaUpdateState {
  /** False in dev builds, where expo-updates is inert. */
  enabled: boolean;
  status: OtaStatus;
  /** Check the server and download in one step; ends in 'ready' | 'uptodate' | 'error'. */
  check: () => void;
  /** Relaunch into the downloaded bundle (status 'ready'). */
  restart: () => void;
}

/**
 * Relaunch into the downloaded bundle, closing the user-data database first so
 * the old runtime's connection cannot hold a lock — or a half-run batch — over
 * the new one (see ../db). A close that fails must not block the update.
 */
export async function relaunchIntoUpdate(): Promise<void> {
  try {
    await releaseStorage();
  } finally {
    await Updates.reloadAsync();
  }
}

/**
 * Manual over-the-air update check for the Settings sheet. Launch-time checks
 * are automatic (app.json updates.checkAutomatically ON_LOAD, surfaced by
 * UpdateNotices); this is the "check now" affordance.
 */
export function useOtaUpdate(): OtaUpdateState {
  const [status, setStatus] = useState<OtaStatus>('idle');

  const check = useCallback(() => {
    void (async () => {
      try {
        setStatus('checking');
        const result = await Updates.checkForUpdateAsync();
        if (!result.isAvailable) {
          setStatus('uptodate');
          return;
        }
        setStatus('downloading');
        await Updates.fetchUpdateAsync();
        setStatus('ready');
      } catch {
        setStatus('error');
      }
    })();
  }, []);

  const restart = useCallback(() => {
    void relaunchIntoUpdate();
  }, []);

  return { enabled: Updates.isEnabled, status, check, restart };
}
