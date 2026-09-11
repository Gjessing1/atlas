import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Two home-screen commute widgets ship side by side (docs/TRANSIT.md §W1–§W7), and they are
 * different products rather than two versions of one:
 *
 *  - **v1 — "Atlas commute"** (`configure` / `support` / `requestPin`). One
 *    instance answers one board: a direction, both, or one hop, chosen in its ⚙.
 *  - **v2 — "Atlas commute (live)"** (`configureV2` / `supportV2` /
 *    `requestPinV2` / `setPlace` / `setCommitV2` / `commitV2`). One instance
 *    holds the whole commute.
 *
 * They keep separate native stores, which is why the surface is two sets of
 * functions and not one with a flag: configuring one must never touch the
 * other's state, and v1 stays the fallback until v2 has been commuted with.
 */
export interface CommuteWidgetNativeModule {
  // ---------------------------------------------------------------- v1 ---
  configure(
    baseUrl: string,
    queryJson: string | null,
    /** The corridor's hops as `[{"id","label"}, …]`, for the ⚙ screen's leg boards. */
    segmentsJson: string | null,
  ): Promise<void>;
  /** Whether this launcher takes pin requests, and how many v1 instances exist. */
  support(): Promise<{ pinnable: boolean; count: number }>;
  /** Ask the launcher to place a v1 widget; it shows its own confirmation. */
  requestPin(): Promise<boolean>;

  // ---------------------------------------------------------------- v2 ---
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
