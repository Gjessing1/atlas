import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMapProfile, type MapProfileSettings } from './useMapProfile.js';

function settings(stored: string | null): MapProfileSettings {
  return {
    status: 'ready',
    getSetting: vi.fn(() => Promise.resolve(stored)),
    setSetting: vi.fn(),
  };
}

describe('useMapProfile', () => {
  it('restores the per-device profile and persists a valid pick', async () => {
    const store = settings('hike');
    const { result } = renderHook(() => useMapProfile(store));

    await waitFor(() => expect(result.current.profile.id).toBe('hike'));
    act(() => result.current.setProfile('drive'));

    expect(result.current.profile.id).toBe('drive');
    expect(store.setSetting).toHaveBeenCalledWith('local.map.profile', 'drive');
  });

  it('keeps Explore for an unknown stored or selected profile', async () => {
    const store = settings('rocket');
    const { result } = renderHook(() => useMapProfile(store));

    await waitFor(() => expect(store.getSetting).toHaveBeenCalled());
    expect(result.current.profile.id).toBe('explore');

    act(() => result.current.setProfile('rocket'));
    expect(result.current.profile.id).toBe('explore');
    expect(store.setSetting).not.toHaveBeenCalled();
  });
});
