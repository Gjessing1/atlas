/**
 * What Settings is divided into, and what each part is called.
 *
 * The two clients had grown different answers: web showed five tabs (Map,
 * Profiles, Navigation, Account, System) while Android showed eight rows, so
 * the same control lived under two different names — theme and overlays are
 * "Map" on web and "Appearance" + "Map layers" on Android, and a user who
 * learned one had to re-learn the other.
 *
 * The list is data, not UI: web renders it as a tab strip and Android as a
 * drill-down menu, but the sections, their names and their order come from
 * here. Two of them are genuinely Android-only — a browser streams its tiles
 * and has no offline packs — and saying so here is what keeps that a recorded
 * difference rather than drift.
 */

export type SettingsSectionId =
  'appearance' | 'layers' | 'tiles' | 'profiles' | 'navigation' | 'offline' | 'account' | 'system';

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  /** One line saying what is inside — a row subtitle, or a tab's tooltip. */
  readonly hint: string;
  /** Absent on web by nature (no downloaded tiles, no region packs). */
  readonly androidOnly?: true;
}

/** Every settings section, in the order both clients present them. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme, map colours and label sizes' },
  { id: 'layers', label: 'Map layers', hint: 'Overlays drawn on top of the map' },
  { id: 'tiles', label: 'Map tiles', hint: 'Streaming vs. downloaded basemap', androidOnly: true },
  { id: 'profiles', label: 'Activity profiles', hint: 'Switcher activities and their layers' },
  { id: 'navigation', label: 'Navigation', hint: 'Readouts shown during guidance' },
  {
    id: 'offline',
    label: 'Offline regions',
    hint: 'Download maps for offline use',
    androidOnly: true,
  },
  { id: 'account', label: 'Account & data', hint: 'Sign in, sync and export' },
  { id: 'system', label: 'System', hint: 'Server, status and app updates' },
];

/** The sections a given client shows, in order. */
export function settingsSectionsFor(platform: 'web' | 'android'): readonly SettingsSection[] {
  return platform === 'android'
    ? SETTINGS_SECTIONS
    : SETTINGS_SECTIONS.filter((section) => !section.androidOnly);
}
