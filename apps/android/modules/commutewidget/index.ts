import { requireOptionalNativeModule } from 'expo-modules-core';

export interface CommuteWidgetNativeModule {
  configure(
    baseUrl: string,
    queryJson: string | null,
    /** The corridor's hops as `[{"id","label"}, …]`, for the ⚙ screen's leg boards. */
    segmentsJson: string | null,
  ): Promise<void>;
  /** Whether this launcher takes pin requests, and how many instances exist. */
  support(): Promise<{ pinnable: boolean; count: number }>;
  /** Ask the launcher to place one; it shows its own confirmation. */
  requestPin(): Promise<boolean>;
}

export default requireOptionalNativeModule<CommuteWidgetNativeModule>('AtlasCommuteWidget');
