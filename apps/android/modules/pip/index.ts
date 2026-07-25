import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

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
  setActive(on: boolean): void;
  inPictureInPicture(): boolean;
  addListener(
    event: 'onPictureInPictureChange',
    listener: (payload: { inPictureInPicture: boolean }) => void,
  ): EventSubscription;
}

/** Null in builds that predate the native module (and in unit tests). */
const Native = requireOptionalNativeModule<PipNativeModule>('AtlasPip');

/** Whether a mini navigation window is possible: module present, device capable, app allowed. */
export function pipSupported(): boolean {
  try {
    return Native?.isSupported() === true && Native.isAllowed();
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

export function setPipActive(on: boolean): void {
  try {
    Native?.setActive(on);
  } catch {
    // A finishing activity — nothing to arm.
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
