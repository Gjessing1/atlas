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
  isArmed(): boolean;
  setSourceRect(x: number, y: number, width: number, height: number): void;
  inPictureInPicture(): boolean;
  addListener(
    event: 'onPictureInPictureChange',
    listener: (payload: { inPictureInPicture: boolean }) => void,
  ): EventSubscription;
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
      listener(payload.inPictureInPicture),
    ) ?? null
  );
}
