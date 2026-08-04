import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  useMapProfilePreferences,
  type MapProfilePreferenceSettings,
} from './useMapProfilePreferences.js';

function settings(stored: string | null): MapProfilePreferenceSettings {
  return {
    status: 'ready',
    getSetting: vi.fn(() => Promise.resolve(stored)),
    setSetting: vi.fn(),
  };
}

describe('useMapProfilePreferences', () => {
  it('restores synced visibility and preferred layers', async () => {
    const store = settings(
      JSON.stringify({
        visible: ['drive', 'hike'],
        layers: { hike: ['trails-hiking', 'weather'] },
      }),
    );
    const { result } = renderHook(() => useMapProfilePreferences(store));

    await waitFor(() =>
      expect(result.current.visibleProfiles.map((profile) => profile.id)).toEqual([
        'drive',
        'hike',
        'curiosities',
      ]),
    );
    expect(result.current.preferredLayers('hike')).toEqual(['trails-hiking', 'weather']);
    expect(result.current.customizedLayers('hike')).toBe(true);
  });

  it('keeps at least one quick profile and persists edits as a synced setting', () => {
    const store = settings(null);
    const { result } = renderHook(() => useMapProfilePreferences(store));

    for (const id of ['drive', 'bike', 'hike', 'run', 'ski', 'fishhunt', 'curiosities']) {
      act(() => result.current.setVisible(id, false));
    }
    act(() => result.current.setVisible('explore', false));
    expect(result.current.visibleProfiles.map((profile) => profile.id)).toEqual(['explore']);

    act(() => result.current.setPreferredLayers('drive', ['traffic']));
    expect(result.current.preferredLayers('drive')).toEqual(['traffic']);
    expect(store.setSetting).toHaveBeenLastCalledWith(
      'map.profile-preferences',
      expect.stringContaining('"drive":["traffic"]'),
    );
  });
});
