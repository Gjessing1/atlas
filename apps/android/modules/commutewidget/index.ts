import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * The Android commute widget. Native V2 names remain so an installed widget
 * keeps its stored selector and commitment across an APK update.
 */
export interface CommuteWidgetNativeModule {
  /** The saved commute, for v2. No hop list — a v2 instance holds the whole commute. */
  configureV2(baseUrl: string, queryJson: string | null): Promise<void>;
  /**
   * The journey the app's board is tracking, onto every v2 instance; `null`
   * clears them. The same `{"direction","departureMs","line","committedAtMs"}`
   * the widget writes when a row is tapped — one commitment, two hands on it.
   */
  setCommitV2(commitJson: string | null): Promise<void>;
  /** The newest commitment any instance holds, for a tap made on the home screen. */
  commitV2(): Promise<string | null>;
  /**
   * The coarse place the app observed while in the foreground — `home`,
   * `interchange`, `away` or `unknown`. It may choose AUTO's presentation and
   * nothing else, and the widget never asks for a fix of its own.
   */
  setPlace(place: string): Promise<void>;
  supportV2(): Promise<{ pinnable: boolean; count: number }>;
  requestPinV2(): Promise<boolean>;
}

export default requireOptionalNativeModule<CommuteWidgetNativeModule>('AtlasCommuteWidget');
