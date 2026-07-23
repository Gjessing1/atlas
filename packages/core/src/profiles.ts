/** Map profiles: the per-activity map setup (travel mode + offered overlays). */

import type { LayerMeta } from './layers.js';

/**
 * A curated activity profile: what the user is doing on the map right now.
 *
 * Deliberately a short fixed list, not a settings tree — the point is a one-tap
 * switch. A profile chooses the *default* travel mode for new routes and
 * decides which contextual overlays are offered; the route planner still shows
 * every travel mode, so a profile never traps the user.
 *
 * `routing` stays a plain string for the same reason `RoutePlanState.profile`
 * does: core knows nothing about the routing engine, and the app narrows it
 * with `isRoutingProfile` before any request goes out. `null` means the profile
 * expresses no opinion (Explore) or the engine has no matching costing (Ski).
 */
export interface MapProfile {
  id: string;
  label: string;
  routing: string | null;
  /**
   * `LayerMeta.profiles` tags this profile surfaces. Kept explicit rather than
   * matching on `id`, because the two vocabularies genuinely differ — the
   * hiking layers are tagged `hiking` while the travel mode is `hike`, and
   * `bike` lining up on both sides is a coincidence, not a rule.
   */
  layerTags: string[];
  /**
   * Layer ids that start **on** when this profile is picked, until the user
   * says otherwise. A hiker who switches to Hike wants the trail network there
   * without a second tap through the panel — the whole point of the profile.
   * It is only a *default*: an explicit toggle (which records `{on:false}`) is
   * always respected, so this never fights the user's own choice.
   */
  defaultLayers?: string[];
}

export const MAP_PROFILES: readonly MapProfile[] = [
  { id: 'explore', label: 'Explore', routing: null, layerTags: [] },
  { id: 'drive', label: 'Drive', routing: 'car', layerTags: [] },
  { id: 'bike', label: 'Cycle', routing: 'bike', layerTags: ['bike'] },
  {
    id: 'hike',
    label: 'Hike',
    routing: 'hike',
    layerTags: ['hiking'],
    defaultLayers: ['trails-hiking'],
  },
  { id: 'run', label: 'Run', routing: 'run', layerTags: ['running', 'hiking'] },
  { id: 'ski', label: 'Ski', routing: null, layerTags: ['ski'] },
];

/** The profile Atlas starts in, and the fallback for an unknown stored id. */
export const DEFAULT_MAP_PROFILE = 'explore';

/**
 * Account-level profile layout. The active profile remains device-local, but
 * which shortcuts are offered and which overlays a profile starts with travel
 * with the user's other Atlas data.
 */
export interface MapProfilePreferences {
  /** Profile ids shown in the one-tap map switcher, in Atlas's curated order. */
  visible: string[];
  /**
   * Preferred overlay ids per profile. A missing profile uses Atlas defaults;
   * an explicit empty array means that profile starts with no overlays.
   */
  layers: Record<string, string[]>;
}

/** Atlas defaults before the user has customized their profile layout. */
export function defaultMapProfilePreferences(): MapProfilePreferences {
  return {
    visible: MAP_PROFILES.map((profile) => profile.id),
    layers: {},
  };
}

/**
 * Read profile preferences from storage/sync without trusting hand-edited or
 * newer-version data. Unknown profile ids are ignored; unknown layer ids stay
 * because the overlay catalog is server-provided and may be newer than core.
 */
export function sanitizeMapProfilePreferences(input: unknown): MapProfilePreferences {
  const fallback = defaultMapProfilePreferences();
  if (typeof input !== 'object' || input === null) return fallback;
  const raw = input as Record<string, unknown>;
  const known = new Set(MAP_PROFILES.map((profile) => profile.id));
  const visibleRaw = Array.isArray(raw['visible']) ? raw['visible'] : fallback.visible;
  const visibleSet = new Set(
    visibleRaw.filter((id): id is string => typeof id === 'string' && known.has(id)),
  );
  // Never let customization remove the switcher completely. Explore is the
  // neutral recovery choice when a corrupt or hand-edited value hides all.
  if (visibleSet.size === 0) visibleSet.add(DEFAULT_MAP_PROFILE);

  const layers: Record<string, string[]> = {};
  const rawLayers = raw['layers'];
  if (typeof rawLayers === 'object' && rawLayers !== null) {
    for (const [profileId, ids] of Object.entries(rawLayers as Record<string, unknown>)) {
      if (!known.has(profileId) || !Array.isArray(ids)) continue;
      layers[profileId] = [
        ...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)),
      ];
    }
  }
  return {
    visible: MAP_PROFILES.filter((profile) => visibleSet.has(profile.id)).map(
      (profile) => profile.id,
    ),
    layers,
  };
}

/** Preferred layer ids for a profile, falling back to Atlas's curated defaults. */
export function preferredLayersForProfile(
  preferences: MapProfilePreferences,
  profileId: string,
): readonly string[] {
  return preferences.layers[profileId] ?? mapProfile(profileId).defaultLayers ?? [];
}

/** Narrow an untrusted string (a stored setting, a share link) to a known profile. */
export function isMapProfile(value: unknown): value is string {
  return typeof value === 'string' && MAP_PROFILES.some((p) => p.id === value);
}

/** Look up a profile by id, falling back to the default for anything unknown. */
export function mapProfile(id: string): MapProfile {
  return MAP_PROFILES.find((p) => p.id === id) ?? MAP_PROFILES[0]!;
}

/**
 * Whether an overlay belongs in the panel for a profile.
 *
 * Untagged layers are general purpose and always offered. A tagged layer is
 * contextual and stays hidden until its profile is picked — that is what keeps
 * the catalog short, and it is why Wave 2 layers carry tags at all.
 */
export function layerInProfile(meta: Pick<LayerMeta, 'profiles'>, profileId: string): boolean {
  if (!meta.profiles || meta.profiles.length === 0) return true;
  const tags = mapProfile(profileId).layerTags;
  return meta.profiles.some((tag) => tags.includes(tag));
}

/** The catalog narrowed to a profile, keeping the server's display order. */
export function layersForProfile(catalog: readonly LayerMeta[], profileId: string): LayerMeta[] {
  return catalog.filter((meta) => layerInProfile(meta, profileId));
}

/**
 * Whether a layer is on by default in this profile (see `defaultLayers`). Used
 * as the fallback when the device has no stored on/off choice for the layer, so
 * a profile can surface its signature overlay without a persisted setting.
 */
export function layerDefaultsOn(layerId: string, profileId: string): boolean {
  return mapProfile(profileId).defaultLayers?.includes(layerId) ?? false;
}
