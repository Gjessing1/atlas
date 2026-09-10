import { usePersistedSetting, type NavController, type SettingsAccess } from '@atlas/app-hooks';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  clearNavigationDiagnostics,
  configureNavigationDiagnostics,
  configureNavigationDiagnosticsAutoUpload,
  deleteNavigationDiagnosticTrip,
  flushNavigationDiagnosticUploads,
  listNavigationDiagnosticTrips,
  logNavigationDiagnostic,
  markNavigationDiagnostic,
  NAV_DIAGNOSTICS_AUTO_UPLOAD_SETTING,
  NAV_DIAGNOSTICS_SETTING,
  shareNavigationDiagnosticTrip,
  uploadNavigationDiagnosticTrip,
  type NavDiagnosticTrip,
} from './diagnostics';

export type NavigationDiagnosticsSettings = SettingsAccess;

export interface NavigationDiagnosticsController {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  /** Send each finished trip to Atlas by itself, retrying anything pending. */
  autoUpload: boolean;
  setAutoUpload(on: boolean): void;
  /** The recorded trips, newest first. */
  trips: NavDiagnosticTrip[];
  sizeBytes: number;
  /** Re-read the trip list (after a drive, or after acting on a trip). */
  refresh(): void;
  share(tripId: string): Promise<boolean>;
  upload(tripId: string): Promise<string>;
  remove(tripId: string): Promise<void>;
  clear(): Promise<void>;
  /** Stamp "look at this bit" onto the running trip. */
  mark(note?: string): void;
}

/**
 * The two switches, the trip list, and the actions Settings offers on it.
 *
 * Both preferences are ordinary synced Atlas settings, so they follow the
 * signed-in account. The logs themselves are deliberately device-private files
 * — they contain exact routes and positions — and move only through Share or
 * an upload the traveller asked for, either by pressing the button or by
 * leaving auto-upload on.
 */
export function useNavigationDiagnostics(
  settings: NavigationDiagnosticsSettings,
  account: string | null,
  syncStatus: string,
): NavigationDiagnosticsController {
  const enabledSetting = usePersistedSetting(settings, NAV_DIAGNOSTICS_SETTING);
  const autoUploadSetting = usePersistedSetting(settings, NAV_DIAGNOSTICS_AUTO_UPLOAD_SETTING);
  const [trips, setTrips] = useState<NavDiagnosticTrip[]>([]);
  const accountRef = useRef(account);
  accountRef.current = account;

  const enabled = enabledSetting.value;
  const autoUpload = autoUploadSetting.value;
  const loaded = enabledSetting.loaded && autoUploadSetting.loaded && syncStatus !== 'syncing';

  const refresh = useCallback(() => {
    void listNavigationDiagnosticTrips().then(setTrips);
  }, []);

  // Recording follows the stored preference, never the render's default: a
  // switch that reads `false` for the first frame must not close the tap on a
  // drive that is already being recorded.
  useEffect(() => {
    if (!loaded) return;
    configureNavigationDiagnostics(enabled, accountRef.current);
    refresh();
  }, [loaded, enabled, refresh]);

  // Same discipline for auto-upload, and enabling it flushes whatever a drive
  // out of coverage left pending.
  useEffect(() => {
    if (!loaded) return;
    configureNavigationDiagnosticsAutoUpload(autoUpload);
    if (!autoUpload) return;
    void flushNavigationDiagnosticUploads().then((sent) => {
      if (sent > 0) refresh();
    });
  }, [loaded, autoUpload, refresh]);

  // Keep Settings' list truthful after a drive without tying every 1 Hz append
  // to a React render.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  const setEnabled = useCallback(
    (on: boolean) => {
      configureNavigationDiagnostics(on, accountRef.current);
      void enabledSetting.setValue(on);
      refresh();
    },
    [enabledSetting, refresh],
  );

  const setAutoUpload = useCallback(
    (on: boolean) => {
      configureNavigationDiagnosticsAutoUpload(on);
      void autoUploadSetting.setValue(on);
    },
    [autoUploadSetting],
  );

  const share = useCallback((tripId: string) => shareNavigationDiagnosticTrip(tripId), []);

  const upload = useCallback(
    async (tripId: string) => {
      try {
        return await uploadNavigationDiagnosticTrip(tripId);
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (tripId: string) => {
      await deleteNavigationDiagnosticTrip(tripId);
      refresh();
    },
    [refresh],
  );

  const clear = useCallback(async () => {
    await clearNavigationDiagnostics();
    setTrips([]);
  }, []);

  const mark = useCallback((note?: string) => void markNavigationDiagnostic(note), []);

  return {
    enabled,
    setEnabled,
    autoUpload,
    setAutoUpload,
    trips,
    sizeBytes: trips.reduce((sum, trip) => sum + trip.bytes, 0),
    refresh,
    share,
    upload,
    remove,
    clear,
    mark,
  };
}

/**
 * The phase transitions, which the controller does not emit.
 *
 * Everything *inside* a trip — states, matcher decisions, route reasons, voice
 * prompts, the trip's own brackets and summary — is recorded by the shared
 * navigation controller through its diagnostics seam, because only it knows
 * why any of it happened. What is left here is the screen's own view of the
 * trip: the phase the UI is showing, which is the thing a report cross-checks
 * a driver's account against.
 */
export function useNavigationDiagnosticState(nav: NavController): void {
  const previousPhase = useRef(nav.phase);

  useEffect(() => {
    if (nav.phase !== previousPhase.current) {
      void logNavigationDiagnostic({
        event: 'navigation-phase',
        from: previousPhase.current,
        to: nav.phase,
        profile: nav.profile,
        ...(nav.error ? { error: nav.error } : {}),
      });
    }
    previousPhase.current = nav.phase;
  }, [nav.phase, nav.profile, nav.error]);
}
