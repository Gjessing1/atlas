import { requireOptionalNativeModule } from 'expo-modules-core';

export interface CommuteWidgetNativeModule {
  configure(baseUrl: string, queryJson: string | null): Promise<void>;
}

export default requireOptionalNativeModule<CommuteWidgetNativeModule>('AtlasCommuteWidget');
