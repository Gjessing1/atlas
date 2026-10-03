import { parseCommuteCommit } from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import {
  commutePlaceAt,
  type TransitCommuteQuery,
  type TransitWidgetV2Commit,
} from '@atlas/transit';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * The Android home-screen commute widget — docs/TRANSIT.md §W1–§W7.
 * Native function names retain V2 because installed widgets keep their native
 * store across updates. One instance holds both directions and follows the
 * journey the traveller committed to.
 */
interface CommuteWidgetModule {
  configureV2(baseUrl: string, queryJson: string | null): Promise<void>;
  setCommitV2(commitJson: string | null): Promise<void>;
  commitV2(): Promise<string | null>;
  setPlace(place: string): Promise<void>;
  supportV2(): Promise<CommuteWidgetSupport>;
  requestPinV2(): Promise<boolean>;
  requestPinStop(): Promise<boolean>;
}

/** What the commute sheet needs to decide whether to offer "Add to home screen". */
export interface CommuteWidgetSupport {
  /** The launcher takes pin requests — Android 8+, and not every launcher does. */
  pinnable: boolean;
  /** How many Atlas commute widgets are already placed. */
  count: number;
}

const NONE: CommuteWidgetSupport = { pinnable: false, count: 0 };

const native = requireOptionalNativeModule<CommuteWidgetModule>('AtlasCommuteWidget');

/**
 * Keep the widget's private configuration aligned with Atlas storage —
 * docs/TRANSIT.md §W1–§W7.
 */
export async function configureCommuteWidgetV2(
  baseUrl: string,
  query: TransitCommuteQuery | null,
): Promise<void> {
  try {
    await native?.configureV2(baseUrl, query ? JSON.stringify(query) : null);
  } catch {
    // Guarded like everything else here: a JS bundle reaches a device by OTA and
    // routinely runs on an APK built before it — one whose native module has
    // `configure` and none of the v2 functions. Keeping the widget's previous
    // configuration is the right failure.
  }
}

/**
 * Tell the v2 widget roughly where the phone is — TRANSIT.md §W2's cached coarse fix,
 * which may choose AUTO's *presentation* and never the journey, the state or the
 * committed leg.
 *
 * Called only where the app already has a fix in hand while in the foreground,
 * so it costs no permission prompt and no battery of its own. The widget never
 * asks for one: a refresh runs in a WorkManager job with no foreground service,
 * where Android throttles background location to nothing useful, and the honest
 * way to hold a live fix is nav's permanent notification — which is not what a
 * home screen is for.
 */
export async function reportCommutePlace(
  query: TransitCommuteQuery | null,
  point: LatLng | null,
): Promise<void> {
  if (!query || !point) return;
  try {
    await native?.setPlace(commutePlaceAt(query, point));
  } catch {
    // An older APK has no `setPlace`. The fix is never load-bearing, so its
    // absence costs nothing: AUTO falls back to the clock, which is exactly
    // what TRANSIT.md §W2 says must happen when the fix is stale or switched off.
  }
}

/**
 * Hand the v2 widget the journey the *board* is tracking — TRANSIT.md §7.
 *
 * Before this existed the app and the widget each kept an honest commitment and
 * nothing made them the same one: tapping Track on the board left the widget on
 * the home screen still following whatever it had last been told, and neither
 * was wrong. The shape has been shared since the commitment shipped
 * (`TransitWidgetV2Commit`), so this is a copy, not a translation.
 *
 * Called on every change including release — `null` clears every instance —
 * and never on a mere launch: `useCommute` reads the saved commitment before it
 * reports `ready`, so "nothing is tracked" is only ever said because nothing is.
 */
export async function setCommuteWidgetCommit(commit: TransitWidgetV2Commit | null): Promise<void> {
  try {
    await native?.setCommitV2(commit ? JSON.stringify(commit) : null);
  } catch {
    // An older APK has no `setCommitV2`. The two commitments then stay
    // independent, which is what they were before this shipped: each honest on
    // its own, neither invented.
  }
}

/**
 * The commitment made on the *widget*, for the app to consider adopting.
 *
 * Parsed through `parseCommuteCommit` — the board's own reader — rather than
 * trusted as JSON: this value crosses a process boundary from a store an older
 * APK also writes, and the one definition of what a commitment is lives in
 * `@atlas/app-hooks`.
 */
export async function readCommuteWidgetCommit(): Promise<TransitWidgetV2Commit | null> {
  try {
    return parseCommuteCommit((await native?.commitV2()) ?? null);
  } catch {
    return null;
  }
}

export async function commuteWidgetV2Support(): Promise<CommuteWidgetSupport> {
  try {
    return (await native?.supportV2()) ?? NONE;
  } catch {
    return NONE;
  }
}

/** Ask the launcher to place a v2 widget. False = it declined, or cannot. */
export async function addCommuteWidgetV2(): Promise<boolean> {
  try {
    return (await native?.requestPinV2()) ?? false;
  } catch {
    return false;
  }
}

/** Ask the launcher to place a stop board; its configuration picks stop and line. */
export async function addStopDepartureWidget(): Promise<boolean> {
  try {
    return (await native?.requestPinStop()) ?? false;
  } catch {
    return false;
  }
}
