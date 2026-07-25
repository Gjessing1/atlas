import type { NavController } from '@atlas/app-hooks';
import { useCallback, useEffect, useState } from 'react';
import { useWindowDimensions } from 'react-native';

import {
  addPipListener,
  inPictureInPicture,
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
  /** Whether a mini window is possible at all on this device and build. */
  available: boolean;
  /** PiP exists but is switched off for Atlas in system settings. */
  blockedByUser: boolean;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  /**
   * Tell the system where the guidance banner is (dp, window coordinates), so
   * the shrink animation folds up *that* rather than the whole screen. Wired to
   * the banner's own layout.
   */
  setBannerRect: (rect: { x: number; y: number; width: number; height: number }) => void;
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
  const [available] = useState(pipSupported);
  const [blockedByUser] = useState(pipBlockedByUser);
  const [enabled, setEnabledState] = useState(true);
  const [inPip, setInPip] = useState(inPictureInPicture);
  const win = useWindowDimensions();

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

  const armed = available && enabled && (nav.phase === 'navigating' || nav.phase === 'rerouting');

  useEffect(() => {
    if (!available) return;
    // Re-arming also refreshes the window rectangle the shrink animation flies
    // out of, which is why the window size is a dependency — but never while
    // already in PiP, where that rectangle would be the mini window itself.
    if (inPip) return;
    setPipActive(armed);
    return () => setPipActive(false);
  }, [available, armed, inPip, win.width, win.height]);

  const setBannerRect = useCallback(
    (rect: { x: number; y: number; width: number; height: number }) => {
      // In the mini window the banner is not rendered at all, and its last
      // full-screen rectangle is the one worth keeping for the next entry.
      if (!available || inPip) return;
      setPipSourceRect(rect);
    },
    [available, inPip],
  );

  return {
    inPictureInPicture: inPip,
    available,
    blockedByUser,
    enabled,
    setEnabled,
    setBannerRect,
  };
}
