import { I18nManager } from 'react-native';

/**
 * The phone's language, for the lookups that have one per language.
 *
 * Read from `I18nManager`'s constants rather than pulled in as a dependency:
 * it is the locale the Android framework already handed React Native at
 * startup ("nb_NO"), so no extra native module — and therefore no new APK — is
 * needed to stop asking English Wikipedia about a Norwegian phone's
 * surroundings. Anything unexpected falls back to English upstream.
 */
export function deviceLanguage(): string {
  try {
    return I18nManager.getConstants().localeIdentifier ?? 'en';
  } catch {
    return 'en';
  }
}
