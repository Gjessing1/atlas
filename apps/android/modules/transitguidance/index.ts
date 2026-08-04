import { transitAlightAlarms, type TransitTrip } from '@atlas/transit';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { PermissionsAndroid, Platform } from 'react-native';

interface TransitGuidanceNativeModule {
  schedule(alarmsJson: string): Promise<void>;
  cancel(): Promise<void>;
}

const native = requireOptionalNativeModule<TransitGuidanceNativeModule>('AtlasTransitGuidance');

export async function scheduleTransitAlarms(trip: TransitTrip): Promise<void> {
  if (!native) return;
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    const permission =
      'android.permission.POST_NOTIFICATIONS' as typeof PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    const result = await PermissionsAndroid.request(permission);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) return;
  }
  await native.schedule(JSON.stringify(transitAlightAlarms(trip, Date.now())));
}

export async function cancelTransitAlarms(): Promise<void> {
  await native?.cancel();
}
