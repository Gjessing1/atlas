import type { TransitCommuteQuery } from '@atlas/transit';
import { requireOptionalNativeModule } from 'expo-modules-core';

interface CommuteWidgetModule {
  configure(baseUrl: string, queryJson: string | null): Promise<void>;
  support(): Promise<CommuteWidgetSupport>;
  requestPin(): Promise<boolean>;
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

/** Keep the native home-screen widget's private configuration aligned with Atlas storage. */
export async function configureCommuteWidget(
  baseUrl: string,
  query: TransitCommuteQuery | null,
): Promise<void> {
  await native?.configure(baseUrl, query ? JSON.stringify(query) : null);
}

/**
 * Every call here is guarded, and not only for the web: a JS bundle reaches a
 * device by OTA, so this code routinely runs on an APK built before it — one
 * whose native module has `configure` and nothing else. A missing widget button
 * is a shrug; an unhandled rejection on the commute sheet is not.
 */
export async function commuteWidgetSupport(): Promise<CommuteWidgetSupport> {
  try {
    return (await native?.support()) ?? NONE;
  } catch {
    return NONE;
  }
}

/** Ask the launcher to place a widget. False = it declined, or cannot. */
export async function addCommuteWidget(): Promise<boolean> {
  try {
    return (await native?.requestPin()) ?? false;
  } catch {
    return false;
  }
}
