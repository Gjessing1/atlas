import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMapStyleEditor, type MapStyleSettings } from './useMapStyleEditor.js';

describe('useMapStyleEditor', () => {
  it('restores, sanitizes and persists style edits', async () => {
    const settings: MapStyleSettings = {
      status: 'ready',
      getSetting: vi.fn(() =>
        Promise.resolve(JSON.stringify({ waterColor: '#ABCDEF', labelScale: 9, poiScale: 0.1 })),
      ),
      setSetting: vi.fn(),
    };
    const { result } = renderHook(() => useMapStyleEditor(settings));
    await waitFor(() => expect(result.current.value.waterColor).toBe('#abcdef'));
    expect(result.current.value.labelScale).toBe(1.5);
    expect(result.current.value.poiScale).toBe(0.5);

    act(() => result.current.setColor('pathColor', '#123456'));
    expect(result.current.value.pathColor).toBe('#123456');
    expect(settings.setSetting).toHaveBeenCalledWith(
      'local.map.style-overrides',
      expect.stringContaining('#123456'),
    );
  });
});
