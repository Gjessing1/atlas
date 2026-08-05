import type { NavController } from '@atlas/app-hooks';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  beginNavigationDiagnosticTrip,
  clearNavigationDiagnostics,
  configureNavigationDiagnostics,
  logNavigationDiagnostic,
  NAV_DIAGNOSTICS_SETTING,
  navigationDiagnosticSize,
  shareNavigationDiagnostics,
  uploadNavigationDiagnostics,
} from './diagnostics';

export interface NavigationDiagnosticsSettings {
  status: string;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): void;
}

export interface NavigationDiagnosticsController {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  sizeBytes: number;
  share(): Promise<boolean>;
  upload(): Promise<string>;
  clear(): Promise<void>;
}

/**
 * The switch is a normal (synced) Atlas setting, so it follows the signed-in
 * account. The log is intentionally a device-private file because it contains
 * exact routes and locations; it moves only through the explicit Share action.
 */
export function useNavigationDiagnostics(
  settings: NavigationDiagnosticsSettings,
  account: string | null,
  syncStatus: string,
): NavigationDiagnosticsController {
  const [enabled, setEnabledState] = useState(false);
  const [sizeBytes, setSizeBytes] = useState(0);
  const accountRef = useRef(account);
  accountRef.current = account;

  useEffect(() => {
    if (settings.status !== 'ready' || syncStatus === 'syncing') return;
    let cancelled = false;
    void settings.getSetting(NAV_DIAGNOSTICS_SETTING).then((raw) => {
      if (cancelled) return;
      const on = raw === 'true';
      setEnabledState(on);
      configureNavigationDiagnostics(on, account);
      void navigationDiagnosticSize().then((bytes) => {
        if (!cancelled) setSizeBytes(bytes);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [settings.status, settings.getSetting, account, syncStatus]);

  // Keep Settings' share/clear controls truthful after a drive without tying
  // every 1 Hz log append to a React render.
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => void navigationDiagnosticSize().then(setSizeBytes);
    const timer = setInterval(refresh, 15_000);
    refresh();
    return () => clearInterval(timer);
  }, [enabled]);

  const setEnabled = useCallback(
    (on: boolean) => {
      setEnabledState(on);
      configureNavigationDiagnostics(on, accountRef.current);
      settings.setSetting(NAV_DIAGNOSTICS_SETTING, String(on));
      void navigationDiagnosticSize().then(setSizeBytes);
    },
    [settings.setSetting],
  );

  const share = useCallback(async () => {
    const shared = await shareNavigationDiagnostics();
    setSizeBytes(await navigationDiagnosticSize());
    return shared;
  }, []);

  const upload = useCallback(async () => {
    const reference = await uploadNavigationDiagnostics();
    setSizeBytes(await navigationDiagnosticSize());
    return reference;
  }, []);

  const clear = useCallback(async () => {
    await clearNavigationDiagnostics();
    setSizeBytes(0);
  }, []);

  return { enabled, setEnabled, sizeBytes, share, upload, clear };
}

/** Capture the controller's interpretation of raw fixes and its chosen route. */
export function useNavigationDiagnosticState(nav: NavController): void {
  const previousPhase = useRef(nav.phase);
  const previousPath = useRef(nav.activePath);

  useEffect(() => {
    if (nav.phase === 'starting' && previousPhase.current !== 'starting') {
      void beginNavigationDiagnosticTrip({
        profile: nav.profile,
        destination: nav.destination,
        previousPhase: previousPhase.current,
      });
    } else if (nav.phase !== previousPhase.current) {
      void logNavigationDiagnostic({
        event: 'navigation-phase',
        from: previousPhase.current,
        to: nav.phase,
        profile: nav.profile,
        error: nav.error,
      });
    }
    previousPhase.current = nav.phase;
  }, [nav.phase, nav.profile, nav.destination, nav.error]);

  useEffect(() => {
    if (nav.activePath && nav.activePath !== previousPath.current) {
      void logNavigationDiagnostic({
        event: 'active-route',
        phase: nav.phase,
        profile: nav.profile,
        destination: nav.destination,
        path: nav.activePath,
      });
    }
    previousPath.current = nav.activePath;
  }, [nav.activePath, nav.phase, nav.profile, nav.destination]);

  useEffect(() => {
    if (!nav.state) return;
    const latestFixAccepted =
      nav.state.fix === 'live' &&
      nav.position !== null &&
      Math.abs(nav.state.raw.lat - nav.position.lat) < 1e-8 &&
      Math.abs(nav.state.raw.lng - nav.position.lng) < 1e-8;
    void logNavigationDiagnostic({
      event: 'navigation-state',
      phase: nav.phase,
      profile: nav.profile,
      rawPosition: nav.position,
      latestFixAccepted,
      state: nav.state,
      rerouteFailed: nav.rerouteFailed,
    });
  }, [nav.state, nav.phase, nav.profile, nav.position, nav.rerouteFailed]);
}
