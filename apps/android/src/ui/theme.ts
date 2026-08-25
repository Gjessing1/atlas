import { PlatformColor } from 'react-native';

/**
 * Semantic Android palette. Platform theme attributes are resolved by the
 * native renderer on every light/dark configuration change, so StyleSheets
 * created at module load still follow System and manual Appearance overrides.
 */
export const theme = {
  surface: PlatformColor(
    '?attr/colorBackgroundFloating',
    '?attr/colorSurface',
    '?android:attr/colorBackground',
  ),
  surfaceOverlay: PlatformColor(
    '?attr/colorBackgroundFloating',
    '?attr/colorSurface',
    '?android:attr/colorBackground',
  ),
  surfaceMuted: PlatformColor('?attr/colorButtonNormal', '?android:attr/colorBackground'),
  surfaceActive: PlatformColor('?attr/colorControlHighlight'),
  // `textColorPrimary/Secondary` are ColorStateList resources; React Native's
  // PlatformColor converter reads theme-attribute scalar data, so those lists
  // become transparent resource ids. colorForeground is a real ARGB value and
  // follows AppCompat DayNight correctly.
  text: PlatformColor('?android:attr/colorForeground'),
  textMuted: PlatformColor('?android:attr/colorForeground'),
  /** SVG props currently accept CSS strings rather than React Native ColorValue. */
  icon: '#8493a3',
  border: PlatformColor('?android:attr/colorForeground'),
  accent: '#4f91ef',
  accentFaint: 'rgba(79,145,239,0.22)',
  warning: '#d08a28',
  danger: '#d84f55',
  /**
   * "Running as published" and "not the service you booked" — the two service
   * states that are neither a warning nor an error. Fixed hex rather than a
   * theme attribute for the same reason `warning` and `danger` are: these mark
   * a *departure's* condition, and it must read identically in light and dark.
   * `info` is deliberately not `accent`, which is reserved for the one control
   * a screen wants tapped.
   */
  success: '#3f9d5f',
  info: '#5a8fd0',
  onAccent: '#fff',
  backdrop: 'rgba(6,10,14,0.52)',
  handle: PlatformColor('?android:attr/colorForeground'),
} as const;
