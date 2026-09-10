import { act, renderHook, waitFor } from '@testing-library/react';
import { jsonSetting, stringSetting } from '@atlas/core';
import { describe, expect, it, vi } from 'vitest';

import { usePersistedSetting, type SettingsAccess } from './usePersistedSetting.js';

let n = 0;
const uniq = () => `local.test.persisted${n++}`;

function access(
  stored: Record<string, string>,
  setSetting: SettingsAccess['setSetting'] = () => Promise.resolve(true),
  status = 'ready',
): SettingsAccess {
  return {
    status,
    getSetting: (key: string) => Promise.resolve(stored[key] ?? null),
    setSetting,
  };
}

describe('usePersistedSetting', () => {
  it('shows the default until the stored value has been read', async () => {
    const def = stringSetting({ key: uniq(), scope: 'local', defaultValue: 'fallback' });
    const { result } = renderHook(() => usePersistedSetting(access({ [def.key]: 'saved' }), def));
    expect(result.current.value).toBe('fallback');
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.value).toBe('saved');
  });

  /**
   * The bug every hand-rolled version had to remember: without a `loaded`
   * latch, the first render's default is written straight over the user's real
   * value on every cold start — which only ever shows up on someone else's
   * device.
   */
  it('never reports loaded before the read comes back', async () => {
    const def = stringSetting({ key: uniq(), scope: 'local', defaultValue: '' });
    let release: ((value: string | null) => void) | undefined;
    const seam: SettingsAccess = {
      status: 'ready',
      getSetting: () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
      setSetting: () => Promise.resolve(true),
    };
    const { result } = renderHook(() => usePersistedSetting(seam, def));
    expect(result.current.loaded).toBe(false);
    await act(async () => {
      release?.('late');
    });
    expect(result.current.loaded).toBe(true);
    expect(result.current.value).toBe('late');
  });

  it('resolves a corrupt row to the default rather than throwing', async () => {
    const def = jsonSetting<number[]>({
      key: uniq(),
      scope: 'local',
      defaultValue: [],
      parse: (value) =>
        Array.isArray(value) ? value.filter((v) => typeof v === 'number') : undefined,
    });
    const { result } = renderHook(() =>
      usePersistedSetting(access({ [def.key]: '{ half-writ' }), def),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.value).toEqual([]);
  });

  it('encodes through the definition on write', async () => {
    const def = jsonSetting<{ on: boolean }>({
      key: uniq(),
      scope: 'local',
      defaultValue: { on: false },
      parse: (value) => value as { on: boolean },
    });
    const setSetting = vi.fn(() => Promise.resolve(true));
    const { result } = renderHook(() => usePersistedSetting(access({}, setSetting), def));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.setValue({ on: true });
    });
    expect(setSetting).toHaveBeenCalledWith(def.key, '{"on":true}');
    expect(result.current.value).toEqual({ on: true });
  });

  it('accepts an updater, like setState', async () => {
    const def = jsonSetting<number>({
      key: uniq(),
      scope: 'local',
      defaultValue: 0,
      parse: (value) => (typeof value === 'number' ? value : undefined),
    });
    const { result } = renderHook(() => usePersistedSetting(access({ [def.key]: '4' }), def));
    await waitFor(() => expect(result.current.value).toBe(4));
    await act(async () => {
      await result.current.setValue((current) => current + 1);
    });
    expect(result.current.value).toBe(5);
  });

  /**
   * DR3's headline: `setSetting` used to return `void` and drop the storage
   * promise, so a preference could change in memory, fail to persist, and look
   * saved until the next restart. The caller can now see it — and so can a
   * test, which is the other half of the requirement.
   */
  it('reports a write that did not reach storage', async () => {
    const def = stringSetting({ key: uniq(), scope: 'local', defaultValue: '' });
    const { result } = renderHook(() =>
      usePersistedSetting(
        access({}, () => Promise.resolve(false)),
        def,
      ),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.setValue('nope');
    });
    expect(saved).toBe(false);
    // The value still changed in memory — the session stays usable, and the
    // write error is what tells the user it will not survive a reload.
    expect(result.current.value).toBe('nope');
  });

  it('tolerates a seam whose setSetting answers nothing', async () => {
    const def = stringSetting({ key: uniq(), scope: 'local', defaultValue: '' });
    const { result } = renderHook(() =>
      usePersistedSetting(
        access({}, () => undefined),
        def,
      ),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      expect(await result.current.setValue('x')).toBe(true);
    });
  });

  it('waits for storage, and stays usable in the session without it', async () => {
    const def = stringSetting({ key: uniq(), scope: 'local', defaultValue: 'default' });
    const getSetting = vi.fn(() => Promise.resolve('stored'));
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        usePersistedSetting({ status, getSetting, setSetting: () => undefined }, def),
      { initialProps: { status: 'loading' } },
    );
    expect(getSetting).not.toHaveBeenCalled();
    // Toggling still works with no database behind it; it just cannot persist.
    await act(async () => {
      await result.current.setValue('in-session');
    });
    expect(result.current.value).toBe('in-session');
    rerender({ status: 'ready' });
    await waitFor(() => expect(getSetting).toHaveBeenCalledWith(def.key));
  });

  /**
   * The window between "the UI is live" and "storage is open" is real — OPFS on
   * the web, SQLite on the phone — and a user can act inside it. This is the
   * regression that found it: a layer switched on in the first second used to
   * flip itself back off a moment later, when the stored row landed and won.
   */
  it('replays an edit made before the read onto the stored value', async () => {
    const def = jsonSetting<Record<string, boolean>>({
      key: uniq(),
      scope: 'local',
      defaultValue: {},
      parse: (value) =>
        typeof value === 'object' && value ? (value as Record<string, boolean>) : undefined,
    });
    const rows: Record<string, string> = { [def.key]: JSON.stringify({ hillshade: true }) };
    let release: ((value: string | null) => void) | undefined;
    const seam: SettingsAccess = {
      status: 'ready',
      getSetting: () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
      setSetting: (key: string, value: string) => {
        rows[key] = value;
        return Promise.resolve(true);
      },
    };
    const { result } = renderHook(() => usePersistedSetting(seam, def));
    // The user switches a layer on while the read is still in flight.
    await act(async () => {
      await result.current.setValue((current) => ({ ...current, satellites: true }));
    });
    expect(result.current.value).toEqual({ satellites: true });
    await act(async () => {
      release?.(rows[def.key]!);
    });
    // The edit survives, and so does everything else the row already held —
    // writing the pre-read value wholesale would have erased `hillshade`.
    expect(result.current.value).toEqual({ hillshade: true, satellites: true });
    expect(result.current.loaded).toBe(true);
    // And it is saved now that it can be: the edit is not merely in-session.
    expect(JSON.parse(rows[def.key]!)).toEqual({ hillshade: true, satellites: true });
  });

  it('keeps an absolute pre-read value, replacing what was stored', async () => {
    const def = stringSetting({ key: uniq(), scope: 'local', defaultValue: '' });
    let release: ((value: string | null) => void) | undefined;
    const seam: SettingsAccess = {
      status: 'ready',
      getSetting: () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
      setSetting: () => Promise.resolve(true),
    };
    const { result } = renderHook(() => usePersistedSetting(seam, def));
    await act(async () => {
      await result.current.setValue('chosen');
    });
    await act(async () => {
      release?.('stored');
    });
    expect(result.current.value).toBe('chosen');
  });

  it('ignores a read that lands after the hook moved on', async () => {
    const def = stringSetting({ key: uniq(), scope: 'local', defaultValue: '' });
    let release: ((value: string | null) => void) | undefined;
    const seam: SettingsAccess = {
      status: 'ready',
      getSetting: () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
      setSetting: () => Promise.resolve(true),
    };
    const { result, unmount } = renderHook(() => usePersistedSetting(seam, def));
    unmount();
    await act(async () => {
      release?.('too late');
    });
    expect(result.current.value).toBe('');
  });
});
