// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useExploreShortcuts } from './useExploreShortcuts.js';

it('persists profile shortcuts, restores them, and keeps one category', async () => {
  const saved = new Map<string, string>();
  const settings = {
    status: 'ready',
    getSetting: vi.fn(async (key: string) => saved.get(key) ?? null),
    setSetting: vi.fn(async (key: string, value: string) => {
      saved.set(key, value);
      return true;
    }),
  };
  const { result, unmount } = renderHook(() => useExploreShortcuts(settings, 'explore'));
  await waitFor(() => expect(result.current.editable).toBe(true));
  act(() => result.current.setPinned('pharmacy', true));
  expect(result.current.shortcuts).toContain('pharmacy');
  for (const id of result.current.shortcuts.filter((id) => id !== 'pharmacy')) {
    act(() => result.current.setPinned(id, false));
  }
  act(() => result.current.setPinned('pharmacy', false));
  expect(result.current.shortcuts).toEqual(['pharmacy']);
  unmount();
  const restored = renderHook(() => useExploreShortcuts(settings, 'explore'));
  await waitFor(() => expect(restored.result.current.shortcuts).toEqual(['pharmacy']));
  act(() => restored.result.current.reset());
  expect(restored.result.current.shortcuts).not.toEqual(['pharmacy']);
  restored.unmount();
});
