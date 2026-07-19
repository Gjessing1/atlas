/**
 * The app's surface palette. Every floating control over the map (nav banner,
 * pills, chips, round buttons) draws from this one object so the whole UI
 * reads as a single set — no mix of dark and light cards. Light theme only for
 * now; a dark theme is a second object with the same keys, selected via
 * `useColorScheme()` when dark mode lands.
 */
export const theme = {
  /** Card/button background (nav banner, pills, round buttons, chips). */
  surface: '#fff',
  /** Slightly translucent surface for passive overlays (badges, road chip). */
  surfaceOverlay: 'rgba(255,255,255,0.92)',
  /** Pressed/active state of a surface control. */
  surfaceActive: '#d7e7ff',
  /** Primary text/icon colour on a surface. */
  text: '#1c2733',
  /** Secondary text (summaries, labels, "then" hints). */
  textMuted: '#5f6c7b',
  /** Brand blue — active route, distances, progress, nav arrow. */
  accent: '#1a73e8',
  /** Faint accent, for progress tracks and ghosted arrows. */
  accentFaint: 'rgba(26,115,232,0.18)',
  /** Warnings (rerouting, wrong-branch hints). */
  warning: '#9a5b00',
  /** Errors and the stop-navigation button. */
  danger: '#b3261e',
} as const;
