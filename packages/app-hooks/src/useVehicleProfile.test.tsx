import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVehicleProfile } from './useVehicleProfile.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSettings(stored: Record<string, string> = {}) {
  const values = { ...stored };
  return {
    status: 'ready',
    getSetting: vi.fn(async (key: string) => values[key] ?? null),
    setSetting: vi.fn((key: string, value: string) => {
      values[key] = value;
    }),
    values,
  };
}

describe('useVehicleProfile', () => {
  it('restores a saved vehicle', async () => {
    const settings = makeSettings({
      'route.vehicle': JSON.stringify({ heightM: 2.8, widthM: 2.22, topSpeedKph: 80 }),
    });
    const { result } = renderHook(() => useVehicleProfile(settings));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.vehicle).toEqual({ heightM: 2.8, widthM: 2.22, topSpeedKph: 80 });
  });

  it('saves under a syncing key, not a device-local one', async () => {
    // The van's height does not depend on which device opened the planner.
    const settings = makeSettings();
    const { result } = renderHook(() => useVehicleProfile(settings));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.setVehicle({ heightM: 2.8, widthM: 2.22, topSpeedKph: 80 }));
    const key = settings.setSetting.mock.calls[0]?.[0];
    expect(key).toBe('route.vehicle');
    expect(key?.startsWith('local.')).toBe(false);
  });

  it('stores the clamped value, so what is shown is what is routed on', async () => {
    const settings = makeSettings();
    const { result } = renderHook(() => useVehicleProfile(settings));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.setVehicle({ heightM: 99, widthM: 2.2, topSpeedKph: 80 }));
    expect(result.current.vehicle?.heightM).toBe(5);
    expect(JSON.parse(settings.values['route.vehicle'] ?? '{}').heightM).toBe(5);
  });

  it('falls back to an ordinary car on a corrupt setting', async () => {
    // Never a guessed clearance: no height means no vehicle.
    for (const raw of ['not json', '{"widthM":2.2}', '{}', '']) {
      const settings = makeSettings({ 'route.vehicle': raw });
      const { result } = renderHook(() => useVehicleProfile(settings));
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.vehicle).toBeNull();
    }
  });

  it('clears back to an ordinary car', async () => {
    const settings = makeSettings({
      'route.vehicle': JSON.stringify({ heightM: 2.8, widthM: 2.22, topSpeedKph: 80 }),
    });
    const { result } = renderHook(() => useVehicleProfile(settings));
    await waitFor(() => expect(result.current.vehicle).not.toBeNull());
    act(() => result.current.setVehicle(null));
    expect(result.current.vehicle).toBeNull();
    expect(settings.values['route.vehicle']).toBe('');
  });
});
