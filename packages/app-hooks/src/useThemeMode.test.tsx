import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useThemeMode, type ThemeModeSettings } from './useThemeMode.js';

function settings(stored: string | null): ThemeModeSettings {
  return {
    status: 'ready',
    getSetting: vi.fn(() => Promise.resolve(stored)),
    setSetting: vi.fn(),
  };
}

describe('useThemeMode', () => {
  it('restores a preference and persists manual changes', async () => {
    const store = settings('dark');
    const { result } = renderHook(() => useThemeMode(store, 'light'));
    await waitFor(() => expect(result.current.colorScheme).toBe('dark'));

    act(() => result.current.setMode('light'));
    expect(result.current.mode).toBe('light');
    expect(store.setSetting).toHaveBeenCalledWith('local.appearance.theme', 'light');
  });

  it('tracks system changes only in System mode', async () => {
    const store = settings('system');
    const { result, rerender } = renderHook(({ system }) => useThemeMode(store, system), {
      initialProps: { system: 'light' as const },
    });
    await waitFor(() => expect(store.getSetting).toHaveBeenCalled());
    expect(result.current.colorScheme).toBe('light');

    rerender({ system: 'dark' });
    expect(result.current.colorScheme).toBe('dark');
  });
});
