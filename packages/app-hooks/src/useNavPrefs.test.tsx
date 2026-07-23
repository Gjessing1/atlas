// @vitest-environment jsdom
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

describe('useNavPrefs', () => {
  it('restores both preferences once storage is ready', async () => {
    const store = settings({ 'local.nav.muted': 'true', 'local.nav.follow': 'north' });
    const setMuted = vi.fn();
    const { result } = renderHook(() => useNavPrefs(store, { muted: false, setMuted }));

    await waitFor(() => expect(result.current.followMode).toBe('north'));
    expect(setMuted).toHaveBeenCalledWith(true);
  });

  it('leaves the defaults alone while storage is still loading', async () => {
    const store = settings({ 'local.nav.follow': 'north' }, 'loading');
    const setMuted = vi.fn();
    const { result } = renderHook(() => useNavPrefs(store, { muted: false, setMuted }));

    await Promise.resolve();
    expect(store.getSetting).not.toHaveBeenCalled();
    expect(result.current.followMode).toBe('course');
    expect(setMuted).not.toHaveBeenCalled();
  });

  it('ignores an absent or malformed follow setting', async () => {
    const store = settings({ 'local.nav.follow': 'sideways' });
    const { result } = renderHook(() => useNavPrefs(store, { muted: false, setMuted: vi.fn() }));

    await waitFor(() => expect(store.getSetting).toHaveBeenCalledTimes(3));
    expect(result.current.followMode).toBe('course');
  });

  it('persists orientation changes', async () => {
    const store = settings();
    const { result } = renderHook(() => useNavPrefs(store, { muted: false, setMuted: vi.fn() }));

    act(() => result.current.toggleFollowMode());
    expect(result.current.followMode).toBe('north');
    expect(store.setSetting).toHaveBeenCalledWith('local.nav.follow', 'north');

    act(() => result.current.setFollowMode('course'));
    expect(result.current.followMode).toBe('course');
    expect(store.setSetting).toHaveBeenLastCalledWith('local.nav.follow', 'course');
  });

  it('mirrors mute changes made through the controller, but not the initial value', async () => {
    const store = settings();
    const { rerender } = renderHook(
      ({ muted }) => useNavPrefs(store, { muted, setMuted: vi.fn() }),
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
    const { result } = renderHook(() => useNavPrefs(store, { muted: false, setMuted: vi.fn() }));
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

  it('does not re-read when the controller hands out a new setMuted each render', async () => {
    const store = settings({ 'local.nav.muted': 'true' });
    const { rerender } = renderHook(() =>
      useNavPrefs(store, { muted: false, setMuted: () => undefined }),
    );
    await waitFor(() => expect(store.getSetting).toHaveBeenCalledTimes(3));

    rerender();
    rerender();
    expect(store.getSetting).toHaveBeenCalledTimes(3);
  });
});
