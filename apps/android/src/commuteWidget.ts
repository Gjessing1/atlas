import type { TransitCommuteQuery } from '@atlas/transit';
import { requireOptionalNativeModule } from 'expo-modules-core';

interface CommuteWidgetModule {
  configure(baseUrl: string, queryJson: string | null): Promise<void>;
}

const native = requireOptionalNativeModule<CommuteWidgetModule>('AtlasCommuteWidget');

/** Keep the native home-screen widget's private configuration aligned with Atlas storage. */
export async function configureCommuteWidget(
  baseUrl: string,
  query: TransitCommuteQuery | null,
): Promise<void> {
  await native?.configure(baseUrl, query ? JSON.stringify(query) : null);
}
