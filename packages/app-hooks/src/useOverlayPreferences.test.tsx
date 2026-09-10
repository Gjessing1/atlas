import { OVERLAY_STATE_SETTING, type LayerMeta } from '@atlas/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useOverlayPreferences, type OverlayPreferencesInput } from './useOverlayPreferences.js';
import type { SettingsAccess } from './usePersistedSetting.js';

const KEY = OVERLAY_STATE_SETTING.key;

/** A settings seam over an in-memory row, so a test can read what was written. */
function store(initial: Record<string, string> = {}) {
  const rows = { ...initial };
  return {
    rows,
    access: {
      status: 'ready',
      getSetting: (key: string) => Promise.resolve(rows[key] ?? null),
      setSetting: (key: string, value: string) => {
        rows[key] = value;
        return Promise.resolve(true);
      },
    } satisfies SettingsAccess,
    /** The persisted state map, decoded the way the app would read it back. */
    saved: () => JSON.parse(rows[KEY] ?? '{}') as Record<string, unknown>,
  };
}

function layer(id: string, extra: Partial<LayerMeta> = {}): LayerMeta {
  return {
    id,
    rev: 1,
    title: id,
    description: '',
    group: 'Terrain',
    attribution: '',
    maxzoom: 18,
    defaultOpacity: 0.8,
    identify: false,
    ...extra,
  };
}

/** Two derived potential surfaces, each with the target option they are tuned by. */
const target = (values: string[]) => ({
  key: 'target',
  label: 'Target',
  defaultValue: values[0]!,
  choices: values.map((value) => ({ value, label: value })),
});
const hunt = layer('hunt', {
  profiles: ['potential'],
  options: [target(['elg', 'radyr'])],
  derived: { vocabulary: 'hunt' as const, legend: [] },
});
const fish = layer('fish', {
  profiles: ['potential'],
  options: [target(['orret'])],
  derived: { vocabulary: 'fishing' as const, legend: [] },
});

const catalog = [
  layer('hillshade'),
  layer('trails-hiking', { profiles: ['hiking'] }),
  layer('heritage-sites', { profiles: ['curiosities'] }),
  hunt,
  fish,
];

function render(input: Partial<OverlayPreferencesInput> = {}, seam = store()) {
  const rendered = renderHook(
    (props: Partial<OverlayPreferencesInput>) =>
      useOverlayPreferences(seam.access, { catalog, profileId: 'explore', ...input, ...props }),
    { initialProps: {} },
  );
  return { ...rendered, ...seam };
}

/** The stored row has been read; nothing may be written before that (DR3). */
async function loaded(result: { current: { state: unknown } }) {
  await waitFor(() => expect(result.current.state).toBeTruthy());
}

describe('useOverlayPreferences', () => {
  describe('defaults', () => {
    it('starts a profile default on and everything else off', async () => {
      const { result } = render({ profileId: 'hike' });
      await loaded(result);
      expect(result.current.isOn('trails-hiking')).toBe(true);
      expect(result.current.isOn('hillshade')).toBe(false);
      expect(result.current.overlays.map((o) => o.meta.id)).toEqual(['trails-hiking']);
    });

    it('lets an explicit choice override the profile default', async () => {
      const seam = store({ [KEY]: JSON.stringify({ 'hike:trails-hiking': { on: false } }) });
      const { result } = render({ profileId: 'hike' }, seam);
      await waitFor(() => expect(result.current.isOn('trails-hiking')).toBe(false));
      expect(result.current.overlays).toEqual([]);
    });

    it('keeps a choice per profile, so switching activity switches the map', async () => {
      const { result, rerender, saved } = render({ profileId: 'hike' });
      await loaded(result);
      act(() => result.current.setOn('hillshade', true));
      await waitFor(() => expect(result.current.isOn('hillshade')).toBe(true));
      expect(saved()).toEqual({ 'hike:hillshade': { on: true } });
      rerender({ profileId: 'explore' });
      expect(result.current.isOn('hillshade')).toBe(false);
    });

    it('honours a legacy unscoped choice until the profile has one of its own', async () => {
      const seam = store({ [KEY]: JSON.stringify({ hillshade: { on: true } }) });
      const { result } = render({ profileId: 'hike' }, seam);
      await waitFor(() => expect(result.current.isOn('hillshade')).toBe(true));
      act(() => result.current.setOn('hillshade', false));
      await waitFor(() => expect(result.current.isOn('hillshade')).toBe(false));
    });

    it('resolves a corrupt row to "nothing chosen yet" rather than throwing', async () => {
      const seam = store({ [KEY]: '{ half-writ' });
      const { result } = render({ profileId: 'hike' }, seam);
      await loaded(result);
      expect(result.current.state).toEqual({});
      expect(result.current.isOn('trails-hiking')).toBe(true);
    });
  });

  describe('profile customization', () => {
    it('takes the synced preset as the baseline once the profile is customized', async () => {
      const { result } = render({
        profileId: 'hike',
        preferredLayers: ['hillshade'],
        customizedLayers: true,
      });
      await loaded(result);
      // The preset replaces the Atlas default rather than adding to it.
      expect(result.current.isOn('hillshade')).toBe(true);
      expect(result.current.isOn('trails-hiking')).toBe(false);
    });

    it('ignores the preset while the profile is untouched', async () => {
      const { result } = render({ profileId: 'hike', preferredLayers: ['hillshade'] });
      await loaded(result);
      expect(result.current.isOn('hillshade')).toBe(false);
      expect(result.current.isOn('trails-hiking')).toBe(true);
    });

    it('lets a quick-switch deviation win over the preset', async () => {
      const { result } = render({
        profileId: 'hike',
        preferredLayers: ['hillshade'],
        customizedLayers: true,
      });
      await loaded(result);
      act(() => result.current.toggle('hillshade'));
      await waitFor(() => expect(result.current.isOn('hillshade')).toBe(false));
    });

    it('writes a preset choice for a profile that is not the active one', async () => {
      const { result, saved } = render({ profileId: 'explore' });
      await loaded(result);
      act(() => result.current.setProfileOn('curiosities', 'heritage-sites', false));
      await waitFor(() => expect(saved()).toEqual({ 'curiosities:heritage-sites': { on: false } }));
      expect(result.current.isOn('heritage-sites')).toBe(false);
    });
  });

  describe('the basemap switch', () => {
    it('draws until the device says otherwise, per profile', async () => {
      const { result, rerender, saved } = render({ profileId: 'curiosities' });
      await loaded(result);
      expect(result.current.basemapOn).toBe(true);
      act(() => result.current.setBasemapOn(false));
      await waitFor(() => expect(result.current.basemapOn).toBe(false));
      expect(saved()).toEqual({ 'curiosities:basemap': { on: false } });
      // Reading an 1826 amtskart bare is a Curiosities decision, not a global one.
      rerender({ profileId: 'hike' });
      expect(result.current.basemapOn).toBe(true);
    });

    it('is not resolved against the profile default layers', async () => {
      // The trap the shared rule exists for: `isOn('basemap')` would answer
      // *off*, because no profile lists the basemap in `defaultLayers`.
      const { result } = render({ profileId: 'hike' });
      await loaded(result);
      expect(result.current.basemapOn).toBe(true);
      expect(result.current.isOn('basemap')).toBe(false);
    });
  });

  describe('opacity', () => {
    it('falls back to the catalog default and then to the stored value', async () => {
      const { result, saved } = render({ profileId: 'explore' });
      await loaded(result);
      expect(result.current.opacityFor('hillshade')).toBe(0.8);
      act(() => result.current.setOpacity('hillshade', 0.25));
      await waitFor(() => expect(result.current.opacityFor('hillshade')).toBe(0.25));
      expect(saved()).toEqual({ 'explore:hillshade': { on: false, opacity: 0.25 } });
    });

    it('records the resolved visibility with it, so a default is not shadowed', async () => {
      // The entry that carries opacity is the profile-scoped one — the same one
      // `isOn` reads first — so writing it without `on` would switch a
      // defaulted-on layer off.
      const { result, saved } = render({ profileId: 'hike' });
      await loaded(result);
      act(() => result.current.setOpacity('trails-hiking', 0.5));
      await waitFor(() => expect(result.current.isOn('trails-hiking')).toBe(true));
      expect(saved()).toEqual({ 'hike:trails-hiking': { on: true, opacity: 0.5 } });
    });

    it('is per profile, with the unscoped value as the older fallback', async () => {
      const seam = store({ [KEY]: JSON.stringify({ hillshade: { opacity: 0.3 } }) });
      const { result } = render({ profileId: 'hike' }, seam);
      await waitFor(() => expect(result.current.opacityFor('hillshade')).toBe(0.3));
      act(() => result.current.setOpacity('hillshade', 0.9));
      await waitFor(() => expect(result.current.opacityFor('hillshade')).toBe(0.9));
    });

    it('clamps an out-of-range stored opacity rather than handing it to a paint property', async () => {
      const seam = store({ [KEY]: JSON.stringify({ 'hike:hillshade': { opacity: 4 } }) });
      const { result } = render({ profileId: 'hike' }, seam);
      await waitFor(() => expect(result.current.opacityFor('hillshade')).toBe(1));
    });
  });

  describe('options', () => {
    it('resolves a layer without a stored choice to its declared default', async () => {
      const { result } = render({ profileId: 'fishhunt' });
      await loaded(result);
      expect(result.current.optionsFor(hunt)).toEqual({ target: 'elg' });
    });

    it('stores a variant under the bare layer id, not per profile', async () => {
      // The species you hunt does not change because you switched to Hike.
      const { result, rerender, saved } = render({ profileId: 'fishhunt' });
      await loaded(result);
      act(() => result.current.setOption(hunt, 'target', 'radyr'));
      await waitFor(() => expect(result.current.optionsFor(hunt)).toEqual({ target: 'radyr' }));
      expect(saved()).toEqual({ hunt: { options: { target: 'radyr' } } });
      rerender({ profileId: 'hike' });
      expect(result.current.optionsFor(hunt)).toEqual({ target: 'radyr' });
    });

    it('drops a value the catalog does not declare', async () => {
      const seam = store({ [KEY]: JSON.stringify({ hunt: { options: { target: 'einhorn' } } }) });
      const { result } = render({ profileId: 'fishhunt' }, seam);
      await waitFor(() => expect(result.current.optionsFor(hunt)).toEqual({ target: 'elg' }));
    });
  });

  describe('the active catalog entries', () => {
    it('hides a contextual layer outside its profile without forgetting it', async () => {
      const { result, rerender } = render({ profileId: 'curiosities' });
      await loaded(result);
      expect(result.current.isOn('heritage-sites')).toBe(true);
      expect(result.current.catalog.map((meta) => meta.id)).toContain('heritage-sites');
      // An overlay the panel doesn't list is one the user can't switch off, so
      // it must stop drawing too — the choice survives in storage.
      rerender({ profileId: 'hike' });
      expect(result.current.catalog.map((meta) => meta.id)).not.toContain('heritage-sites');
      expect(result.current.overlays.map((o) => o.meta.id)).not.toContain('heritage-sites');
      rerender({ profileId: 'curiosities' });
      expect(result.current.overlays.map((o) => o.meta.id)).toContain('heritage-sites');
    });

    it('carries each entry with its resolved opacity and variant', async () => {
      const { result } = render({ profileId: 'fishhunt' });
      await loaded(result);
      act(() => result.current.setOn('hunt', true));
      const entry = () => result.current.overlays.find((o) => o.meta.id === 'hunt');
      await waitFor(() => expect(entry()).toBeDefined());
      expect(entry()).toMatchObject({ opacity: 0.8, options: { target: 'elg' } });
    });
  });

  describe('the active derived surface', () => {
    it('is null when no potential surface is on', async () => {
      const { result } = render({ profileId: 'fishhunt' });
      await loaded(result);
      expect(result.current.derived).toBeNull();
    });

    it('names the surface and the target the card must speak for', async () => {
      const { result } = render({ profileId: 'fishhunt' });
      await loaded(result);
      act(() => result.current.setOn('fish', true));
      await waitFor(() => expect(result.current.derived?.layer).toBe('fish'));
      expect(result.current.derived?.target).toBe('orret');
    });

    it('takes the first in catalog order when two are somehow on', async () => {
      const seam = store({
        [KEY]: JSON.stringify({ 'fishhunt:fish': { on: true }, 'fishhunt:hunt': { on: true } }),
      });
      const { result } = render({ profileId: 'fishhunt' }, seam);
      await waitFor(() => expect(result.current.derived?.layer).toBe('hunt'));
      // Both still draw; this only decides which one the pill explains.
      // (Hillshade rides along: Fish & Hunt starts it on.)
      expect(result.current.overlays.map((o) => o.meta.id)).toEqual(['hillshade', 'hunt', 'fish']);
    });
  });

  describe('storage that is not ready', () => {
    it('keeps toggles working in-session and writes nothing', async () => {
      const seam = store();
      const access: SettingsAccess = { ...seam.access, status: 'loading' };
      const { result } = renderHook(() =>
        useOverlayPreferences(access, { catalog, profileId: 'hike' }),
      );
      act(() => result.current.setOn('hillshade', true));
      await waitFor(() => expect(result.current.isOn('hillshade')).toBe(true));
      expect(seam.rows[KEY]).toBeUndefined();
    });
  });
});
