import type { RoutingProfile } from '@atlas/routing';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useNavPrefs, type NavPrefsSettings } from './useNavPrefs.js';

function settings(stored: Record<string, string> = {}, status = 'ready'): NavPrefsSettings {
  return {
    status,
    getSetting: vi.fn((key: string) => Promise.resolve(stored[key] ?? null)),
    setSetting: vi.fn(),
  };
}

const target = (profile: RoutingProfile = 'car', muted = false) => ({
  muted,
  setMuted: vi.fn(),
  profile,
});

describe('useNavPrefs', () => {
  it('restores both preferences once storage is ready', async () => {
    const store = settings({ 'local.nav.muted': 'true', 'local.nav.follow': 'north' });
    const nav = target();
    const { result } = renderHook(() => useNavPrefs(store, nav));

    await waitFor(() => expect(result.current.followMode).toBe('north'));
    expect(nav.setMuted).toHaveBeenCalledWith(true);
  });

  it('leaves the defaults alone while storage is still loading', async () => {
    const store = settings({ 'local.nav.follow': 'north' }, 'loading');
    const nav = target();
    const { result } = renderHook(() => useNavPrefs(store, nav));

    await Promise.resolve();
    expect(store.getSetting).not.toHaveBeenCalled();
    expect(result.current.followMode).toBe('course');
    expect(nav.setMuted).not.toHaveBeenCalled();
  });

  it('ignores an absent or malformed follow setting', async () => {
    const store = settings({ 'local.nav.follow': 'sideways' });
    const { result } = renderHook(() => useNavPrefs(store, target()));

    await waitFor(() => expect(store.getSetting).toHaveBeenCalledTimes(4));
    expect(result.current.followMode).toBe('course');
  });

  it('persists orientation changes', async () => {
    const store = settings();
    const { result } = renderHook(() => useNavPrefs(store, target()));

    act(() => result.current.toggleFollowMode());
    expect(result.current.followMode).toBe('north');
    expect(store.setSetting).toHaveBeenCalledWith('local.nav.follow', 'north');

    act(() => result.current.setFollowMode('course'));
    expect(result.current.followMode).toBe('course');
    expect(store.setSetting).toHaveBeenLastCalledWith('local.nav.follow', 'course');
  });

  it('keeps a separate orientation per mode class, walking defaulting north-up', async () => {
    const store = settings({ 'local.nav.follow': 'course' });
    const { result, rerender } = renderHook(({ profile }) => useNavPrefs(store, target(profile)), {
      initialProps: { profile: 'car' as RoutingProfile },
    });
    await waitFor(() => expect(store.getSetting).toHaveBeenCalled());
    expect(result.current.followMode).toBe('course');

    // The same device, now walking: north-up by default (OsmAnd's pedestrian
    // default), without having disturbed the driving preference.
    rerender({ profile: 'foot' });
    expect(result.current.followMode).toBe('north');

    // A walking toggle persists under the walking key only.
    act(() => result.current.toggleFollowMode());
    expect(result.current.followMode).toBe('course');
    expect(store.setSetting).toHaveBeenLastCalledWith('local.nav.follow.walk', 'course');

    rerender({ profile: 'car' });
    expect(result.current.followMode).toBe('course');
  });

  it('mirrors mute changes made through the controller, but not the initial value', async () => {
    const store = settings();
    const { rerender } = renderHook(
      ({ muted }) => useNavPrefs(store, { muted, setMuted: vi.fn(), profile: 'car' }),
      { initialProps: { muted: false } },
    );
    await waitFor(() => expect(store.getSetting).toHaveBeenCalled());
    expect(store.setSetting).not.toHaveBeenCalled();

    rerender({ muted: true });
    expect(store.setSetting).toHaveBeenCalledWith('local.nav.muted', 'true');
  });

  it('restores and persists a capped widget selection', async () => {
    const store = settings({
      'local.nav.widgets': '["altitude","next-turn","remaining","speed"]',
    });
    const { result } = renderHook(() => useNavPrefs(store, target()));
    await waitFor(() =>
      expect(result.current.widgets).toEqual(['altitude', 'next-turn', 'remaining']),
    );

    act(() => result.current.toggleWidget('altitude'));
    expect(result.current.widgets).toEqual(['next-turn', 'remaining']);
    expect(store.setSetting).toHaveBeenLastCalledWith(
      'local.nav.widgets',
      '["next-turn","remaining"]',
    );
  });

  it('defaults the widget strip per mode until the user curates one', async () => {
    const store = settings();
    const { result, rerender } = renderHook(({ profile }) => useNavPrefs(store, target(profile)), {
      initialProps: { profile: 'car' as RoutingProfile },
    });
    await waitFor(() => expect(store.getSetting).toHaveBeenCalled());
    expect(result.current.widgets).toEqual(['speed']);

    // A hike leads with the climb, not the speedometer.
    rerender({ profile: 'hike' });
    expect(result.current.widgets).toEqual(['ascent', 'altitude']);

    // The first customisation materialises a saved strip that then applies
    // to every mode.
    act(() => result.current.toggleWidget('remaining'));
    expect(result.current.widgets).toEqual(['ascent', 'altitude', 'remaining']);
    expect(store.setSetting).toHaveBeenLastCalledWith(
      'local.nav.widgets',
      '["ascent","altitude","remaining"]',
    );
    rerender({ profile: 'car' });
    expect(result.current.widgets).toEqual(['ascent', 'altitude', 'remaining']);
  });

  it('does not re-read when the controller hands out a new setMuted each render', async () => {
    const store = settings({ 'local.nav.muted': 'true' });
    const { rerender } = renderHook(() =>
      useNavPrefs(store, { muted: false, setMuted: () => undefined, profile: 'car' }),
    );
    await waitFor(() => expect(store.getSetting).toHaveBeenCalledTimes(4));

    rerender();
    rerender();
    expect(store.getSetting).toHaveBeenCalledTimes(4);
  });
});
