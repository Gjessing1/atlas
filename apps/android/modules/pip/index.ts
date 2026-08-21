import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import { PixelRatio } from 'react-native';

/**
 * Picture-in-picture for active navigation.
 *
 * `setActive` is the whole contract: while it is on, leaving Atlas shrinks the
 * app into a floating mini window (the system does the entering — on Android 12+
 * from the auto-enter flag, below that from the module's user-leaves hook), and
 * `onPictureInPictureChange` says when that happened so React can render the
 * compact guidance instead of the full chrome.
 */
interface PipNativeModule {
  isSupported(): boolean;
  isAllowed(): boolean;
  setActive(on: boolean): boolean;
  setMuted(on: boolean): void;
  isArmed(): boolean;
  setSourceRect(x: number, y: number, width: number, height: number): void;
  windowSize(): { width: number; height: number } | null;
  inPictureInPicture(): boolean;
  openSettings(): boolean;
  addListener(
    event: 'onPictureInPictureChange' | 'onPictureInPictureAction',
    listener: (payload: { inPictureInPicture?: boolean; action?: PipAction }) => void,
  ): EventSubscription;
}

export type PipAction = 'toggleMute' | 'endTrip';
export interface PipWindowSize {
  width: number;
  height: number;
}

/** Null in builds that predate the native module (and in unit tests). */
const Native = requireOptionalNativeModule<PipNativeModule>('AtlasPip');

/** Whether the build and device support a mini navigation window. */
export function pipSupported(): boolean {
  try {
    return Native?.isSupported() === true;
  } catch {
    return false;
  }
}

/** True when the device has PiP but the user has switched it off for Atlas. */
export function pipBlockedByUser(): boolean {
  try {
    return Native?.isSupported() === true && !Native.isAllowed();
  } catch {
    return false;
  }
}

/** Request PiP arming and return whether native state is currently applied. */
export function setPipActive(on: boolean): boolean {
  try {
    return Native?.setActive(on) === true;
  } catch {
    // A finishing activity — nothing to arm.
    return false;
  }
}

export function pipArmed(): boolean {
  try {
    return Native?.isArmed() === true;
  } catch {
    return false;
  }
}

/** Keep the native PiP action label in sync with navigation voice state. */
export function setPipMuted(muted: boolean): void {
  try {
    Native?.setMuted(muted);
  } catch {
    // An older binary has no PiP actions; guidance itself is unaffected.
  }
}

/** Take the user directly to Atlas's per-app PiP permission. */
export function openPipSettings(): boolean {
  try {
    return Native?.openSettings() === true;
  } catch {
    return false;
  }
}

/**
 * Where the map viewport sits (dp, window coordinates) — the patch of screen
 * the mini window is about to become.
 *
 * Android crops the shrinking activity to this rectangle, so it decides what
 * the transition appears to fold up: the banner, or (with no hint) the whole
 * screen full of map and chrome. Pass null while nothing is being guided.
 */
export function setPipSourceRect(
  rect: { x: number; y: number; width: number; height: number } | null,
): void {
  try {
    const scale = PixelRatio.get();
    if (!rect) Native?.setSourceRect(0, 0, 0, 0);
    else
      Native?.setSourceRect(
        Math.round(rect.x * scale),
        Math.round(rect.y * scale),
        Math.round(rect.width * scale),
        Math.round(rect.height * scale),
      );
  } catch {
    // Older build without the function, or a finishing activity: the module
    // falls back to the whole content view, which is what it always used.
  }
}

/**
 * The activity's current window in Android configuration dp.
 *
 * React Native normally reports `useWindowDimensions()` in dp, but on the
 * measured Android 16 PiP transition it returned the task's 400x533 physical
 * pixels while Yoga still interpreted style values as dp. That made a 152 dp
 * wide window choose the wide card and clip its arrival clock. Native reads
 * those task bounds and normalizes them to 152x203 dp, so use that for the
 * compact presentation and keep the React value only as an older-binary
 * fallback.
 */
export function pipWindowSize(fallback: PipWindowSize): PipWindowSize {
  try {
    const measured = Native?.windowSize();
    if (measured && measured.width > 0 && measured.height > 0) return measured;
  } catch {
    // A runtime-13 binary has no size function; its existing layout remains.
  }
  return fallback;
}

export function inPictureInPicture(): boolean {
  try {
    return Native?.inPictureInPicture() === true;
  } catch {
    return false;
  }
}

export function addPipListener(
  listener: (inPictureInPicture: boolean) => void,
): EventSubscription | null {
  return (
    Native?.addListener('onPictureInPictureChange', (payload) =>
      listener(payload.inPictureInPicture === true),
    ) ?? null
  );
}

/** Mute/End buttons supplied by Android's own PiP controls. */
export function addPipActionListener(
  listener: (action: PipAction) => void,
): EventSubscription | null {
  return (
    Native?.addListener('onPictureInPictureAction', (payload) => {
      if (payload.action === 'toggleMute' || payload.action === 'endTrip') listener(payload.action);
    }) ?? null
  );
}
