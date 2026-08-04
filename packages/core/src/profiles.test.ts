import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP_PROFILE,
  defaultMapProfilePreferences,
  isMapProfile,
  layerDefaultsOn,
  layerInProfile,
  layersForProfile,
  MAP_PROFILES,
  mapProfile,
  preferredLayersForProfile,
  sanitizeMapProfilePreferences,
  type LayerMeta,
} from './index.js';

describe('map profiles', () => {
  const meta = (id: string, profiles?: string[]): LayerMeta =>
    ({ id, rev: 1, profiles }) as LayerMeta;

  it('narrows unknown ids to the default profile', () => {
    expect(isMapProfile('hike')).toBe(true);
    expect(isMapProfile('rocket')).toBe(false);
    expect(isMapProfile(null)).toBe(false);
    expect(mapProfile('rocket').id).toBe(DEFAULT_MAP_PROFILE);
  });

  it('always offers untagged general-purpose layers', () => {
    for (const p of MAP_PROFILES) {
      expect(layerInProfile(meta('hillshade'), p.id)).toBe(true);
      expect(layerInProfile(meta('property', []), p.id)).toBe(true);
    }
  });

  it('hides a tagged layer until its own profile is picked', () => {
    expect(layerInProfile(meta('trails-ski', ['ski']), 'ski')).toBe(true);
    expect(layerInProfile(meta('trails-ski', ['ski']), 'explore')).toBe(false);
    expect(layerInProfile(meta('trails-ski', ['ski']), 'hike')).toBe(false);
  });

  it('matches the hiking tag from the hike profile despite the differing words', () => {
    expect(layerInProfile(meta('trails-hiking', ['hiking']), 'hike')).toBe(true);
    expect(layerInProfile(meta('trails-bike', ['bike']), 'bike')).toBe(true);
  });

  it('filters a catalog while keeping the server order', () => {
    const catalog = [
      meta('hillshade'),
      meta('trails-ski', ['ski']),
      meta('sea-depth'),
      meta('trails-hiking', ['hiking']),
    ];
    expect(layersForProfile(catalog, 'explore').map((m) => m.id)).toEqual([
      'hillshade',
      'sea-depth',
    ]);
    expect(layersForProfile(catalog, 'hike').map((m) => m.id)).toEqual([
      'hillshade',
      'sea-depth',
      'trails-hiking',
    ]);
  });

  it('turns a profile default layer on only within that profile', () => {
    // Hike surfaces the trail network by default; nobody else does, and no
    // profile defaults a layer it does not even offer.
    expect(layerDefaultsOn('trails-hiking', 'hike')).toBe(true);
    expect(layerDefaultsOn('trails-hiking', 'explore')).toBe(false);
    expect(layerDefaultsOn('trails-hiking', 'bike')).toBe(false);
    expect(layerDefaultsOn('hillshade', 'hike')).toBe(false);
    for (const p of MAP_PROFILES) {
      for (const id of p.defaultLayers ?? []) {
        expect(layerInProfile(meta(id, [p.layerTags[0]!]), p.id)).toBe(true);
      }
    }
  });

  it('starts the trail and terrain overlays on for Run and Ski', () => {
    expect(mapProfile('run').defaultLayers).toEqual(['trails-hiking']);
    expect(mapProfile('ski').defaultLayers).toEqual(['trails-ski']);
    expect(layerDefaultsOn('trails-hiking', 'run')).toBe(true);
    expect(layerDefaultsOn('trails-ski', 'ski')).toBe(true);
    // terrain-slope is noisy, so it is offered in Ski but not started on.
    expect(layerDefaultsOn('terrain-slope', 'ski')).toBe(false);
    // Each default/offer is genuinely surfaced in its own profile (Run reaches
    // the hiking trails through its `hiking` tag; the ski layers are ski-tagged).
    expect(layerInProfile(meta('trails-hiking', ['hiking']), 'run')).toBe(true);
    expect(layerInProfile(meta('terrain-slope', ['hiking', 'ski']), 'ski')).toBe(true);
  });

  it('offers Fish & Hunt as a non-routing preset over general-purpose layers', () => {
    const fishhunt = mapProfile('fishhunt');
    expect(fishhunt.routing).toBeNull();
    // Most defaults are untagged general-purpose Norwegian layers, offered in
    // every profile and merely started on here; `statskog-jaktfelt` is the one
    // hunting-tagged default (surfaced because this profile carries `hunting`),
    // while `land-cover` and `rivers` are tagged for the outdoor/water profiles
    // but only *start on* here. Outside Norway they are simply absent.
    expect(fishhunt.defaultLayers).toEqual([
      'property',
      'lake-depth',
      'sea-depth',
      'hillshade',
      'terrain-contours',
      'statskog-jaktfelt',
      'ice-weak',
      'ice-observations',
      'land-cover',
      'rivers',
    ]);
    for (const id of fishhunt.defaultLayers!) {
      expect(layerInProfile(meta(id), 'fishhunt')).toBe(true);
      expect(layerDefaultsOn(id, 'fishhunt')).toBe(true);
      expect(layerDefaultsOn(id, 'explore')).toBe(false);
    }
  });

  it('states plainly that no Fish & Hunt layer grants permission', () => {
    // The one way this profile could actively mislead: Statskog covers state
    // land only, so a blank private forest must never read as "free to hunt".
    // Both panels render `note`, so the guarantee is that it exists and says so.
    const note = mapProfile('fishhunt').note ?? '';
    expect(note).toContain('never permission');
    expect(note).toContain('landowner');
    // Only the two profiles that draw *registers* of things a person might go
    // and stand on carry one — a note on every profile would be wallpaper.
    expect(MAP_PROFILES.filter((p) => p.note).map((p) => p.id)).toEqual([
      'fishhunt',
      'curiosities',
    ]);
  });

  it('offers Curiosities as a wholly contextual preset that promises nothing', () => {
    const curiosities = mapProfile('curiosities');
    // No travel mode, like Ski and Fish & Hunt: it is cartography plus a set of
    // registers, not a costing.
    expect(curiosities.routing).toBeNull();
    expect(curiosities.layerTags).toEqual(['curiosities']);
    expect(curiosities.defaultLayers).toEqual(['heritage-sites', 'geoheritage']);
    // The whole catalog is contextual here, which is the point: none of these
    // rows may leak into a profile someone opened to plan a run.
    for (const id of ['heritage-sites', 'wrecks', 'old-mines', 'alien-species']) {
      expect(layerInProfile(meta(id, ['curiosities']), 'curiosities')).toBe(true);
      for (const other of MAP_PROFILES.filter((p) => p.id !== 'curiosities')) {
        expect(layerInProfile(meta(id, ['curiosities']), other.id)).toBe(false);
      }
    }
    // A register is not permission, not safety, and not a survey — all three
    // failure modes of this profile are named where both panels render them.
    const note = curiosities.note ?? '';
    expect(note).toContain('registers, not invitations');
    expect(note).toContain('protected by law');
    expect(note).toContain('unsurveyed, not empty');
  });

  it('only names travel modes the routing package actually knows', () => {
    // A profile whose `routing` drifts from ROUTING_PROFILES would silently
    // fail at request time; core can't import routing, so assert the ids here.
    const known = ['car', 'bike', 'foot', 'hike', 'run'];
    for (const p of MAP_PROFILES) {
      if (p.routing !== null) expect(known).toContain(p.routing);
    }
  });
});

describe('map profile preferences', () => {
  it('sanitizes hidden profiles and keeps a recovery profile', () => {
    expect(
      sanitizeMapProfilePreferences({
        hidden: ['drive', 'rocket', 'drive'],
        layers: { hike: ['trails-hiking', 'weather', 'weather'], rocket: ['x'] },
      }),
    ).toEqual({
      visible: ['explore', 'bike', 'hike', 'run', 'ski', 'fishhunt', 'curiosities'],
      hidden: ['drive'],
      layers: { hike: ['trails-hiking', 'weather'] },
    });
    // Hiding everything is not a state the switcher can render, so Explore
    // comes back — and stops being listed as hidden, or it would come back
    // switched off.
    const all = MAP_PROFILES.map((p) => p.id);
    expect(sanitizeMapProfilePreferences({ hidden: all })).toMatchObject({
      visible: ['explore'],
      hidden: all.filter((id) => id !== 'explore'),
    });
  });

  it('reads a pre-v0.143 value without hiding the profiles it predates', () => {
    // The stored shape used to be the *positive* list, which cannot say
    // anything about a profile that did not exist when it was written. A user
    // who had switched Drive off back then must keep Drive off and still be
    // shown Curiosities — the whole reason the stored field is now `hidden`.
    const legacy = sanitizeMapProfilePreferences({
      visible: ['explore', 'bike', 'hike', 'run', 'ski', 'fishhunt'],
      layers: {},
    });
    expect(legacy.hidden).toEqual(['drive']);
    expect(legacy.visible).toContain('curiosities');
    expect(legacy.visible).not.toContain('drive');
    // A legacy list that names nothing is corrupt, not a demand to hide six
    // profiles: the old sanitizer replaced it with Explore rather than honour
    // it, so reading intent out of it now would invent a choice nobody made.
    expect(sanitizeMapProfilePreferences({ visible: [] })).toEqual(defaultMapProfilePreferences());
  });

  it('uses Atlas defaults until a profile has an explicit layer selection', () => {
    const defaults = defaultMapProfilePreferences();
    expect(preferredLayersForProfile(defaults, 'hike')).toEqual(['trails-hiking']);
    expect(preferredLayersForProfile({ ...defaults, layers: { hike: [] } }, 'hike')).toEqual([]);
  });
});
