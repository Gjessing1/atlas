import { commuteSegments, type TransitCommuteQuery } from '@atlas/transit';
import { requireOptionalNativeModule } from 'expo-modules-core';

interface CommuteWidgetModule {
  configure(baseUrl: string, queryJson: string | null, segmentsJson: string | null): Promise<void>;
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

/**
 * Keep the native home-screen widget's private configuration aligned with Atlas
 * storage.
 *
 * The hops travel with the commute rather than being worked out in Kotlin: the
 * ⚙ screen offers a board per leg (ROADMAP §6.4 §5), and what a corridor's legs
 * are — and what each is called — is `commuteSegments`' answer, given once here
 * so the widget cannot come to a second one.
 */
export async function configureCommuteWidget(
  baseUrl: string,
  query: TransitCommuteQuery | null,
): Promise<void> {
  const segments = query
    ? commuteSegments(query).map((segment) => ({ id: segment.id, label: segment.label }))
    : [];
  try {
    await native?.configure(
      baseUrl,
      query ? JSON.stringify(query) : null,
      segments.length > 0 ? JSON.stringify(segments) : null,
    );
  } catch {
    // Guarded for the same reason as everything below: a bundle can outrun the
    // APK it runs on. Keeping the widget's previous configuration is the right
    // failure — it goes on answering from the commute it already knows, which is
    // the whole point of a home-screen widget.
  }
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
