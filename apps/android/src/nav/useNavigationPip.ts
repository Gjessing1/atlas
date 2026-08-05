import type { NavController } from '@atlas/app-hooks';
import { useCallback, useEffect, useState } from 'react';
import { AppState, useWindowDimensions } from 'react-native';

import {
  addPipListener,
  inPictureInPicture,
  pipArmed,
  pipBlockedByUser,
  pipSupported,
  setPipActive,
  setPipSourceRect,
} from '../../modules/pip';

/** Device-local, like every other navigation preference (`local.` keys never sync). */
const PIP_SETTING = 'local.nav.pip';

export interface NavPipSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface NavPipController {
  /** True while Atlas is showing as a floating mini window. */
  inPictureInPicture: boolean;
  /** Whether a mini window is possible and currently permitted. */
  available: boolean;
  /** PiP exists but is switched off for Atlas in system settings. */
  blockedByUser: boolean;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  /**
   * Tell the system where the map viewport is (dp, window coordinates), so the
   * shrink animation follows the content the mini window continues to show.
   */
  setMapRect: (rect: { x: number; y: number; width: number; height: number }) => void;
}

/**
 * Keeps guidance visible when the user leaves Atlas mid-trip.
 *
 * The native module is armed for exactly as long as guidance is actively
 * navigating (or rerouting) and the setting is on; the system does the entering,
 * so pressing Home or opening Recents shrinks the running trip into a floating
 * window instead of hiding it. Disarming on any other phase is what guarantees
 * an ended trip leaves no idle Atlas window behind.
 *
 * Nothing about the trip changes: the same NavigationSession, the same location
 * foreground service, the same voice prompts. `inPictureInPicture` only tells
 * the UI to render the compact card instead of the full chrome.
 */
export function useNavigationPip(nav: NavController, settings: NavPipSettings): NavPipController {
  const { status, getSetting, setSetting } = settings;
  const [supported, setSupported] = useState(pipSupported);
  const [blockedByUser, setBlockedByUser] = useState(pipBlockedByUser);
  const [enabled, setEnabledState] = useState(true);
  const [inPip, setInPip] = useState(inPictureInPicture);
  const win = useWindowDimensions();

  const refreshNativeState = useCallback(() => {
    setSupported(pipSupported());
    setBlockedByUser(pipBlockedByUser());
    setInPip(inPictureInPicture());
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(PIP_SETTING).then((raw) => {
      if (!cancelled && raw != null) setEnabledState(raw !== 'false');
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const setEnabled = useCallback(
    (value: boolean) => {
      setEnabledState(value);
      setSetting(PIP_SETTING, String(value));
    },
    [setSetting],
  );

  useEffect(() => {
    const subscription = addPipListener(setInPip);
    return () => subscription?.remove();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshNativeState();
    });
    return () => subscription.remove();
  }, [refreshNativeState]);

  const available = supported && !blockedByUser;
  const armed = available && enabled && (nav.phase === 'navigating' || nav.phase === 'rerouting');

  // Arming and geometry are intentionally separate. In particular, a PiP
  // resize must never run an effect cleanup that disarms the native module.
  useEffect(() => {
    setPipActive(armed);
  }, [armed]);

  // The native module also re-applies on activity resume. This check makes the
  // JS side self-healing on builds where the activity returned before the
  // AppState event was delivered.
  useEffect(() => {
    if (armed && !pipArmed()) setPipActive(true);
  }, [armed, win.width, win.height]);

  useEffect(
    () => () => {
      setPipActive(false);
    },
    [],
  );

  // Window dimensions update with the native resize, before the PiP event has
  // necessarily crossed the native→JS bridge. Reading native state here lets
  // the compact layout land with that resize rather than several frames later.
  const effectiveInPip = inPip || (armed && inPictureInPicture());

  const setMapRect = useCallback(
    (rect: { x: number; y: number; width: number; height: number }) => {
      // A resize in PiP measures the floating window itself. Keep the last
      // full-screen viewport for the next entry instead of replacing it with
      // that tiny rectangle.
      if (!available || effectiveInPip) return;
      setPipSourceRect(rect);
    },
    [available, effectiveInPip],
  );

  return {
    inPictureInPicture: effectiveInPip,
    available,
    blockedByUser,
    enabled,
    setEnabled,
    setMapRect,
  };
}
