// @vitest-environment jsdom
import type { PlaceRecord } from '@atlas/storage';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  COMMUTE_SETTING_KEY,
  defaultCommuteConfig,
  parseCommuteConfig,
  useCommute,
  type CommuteSettings,
} from './useCommute.js';

function saved(id: string, name: string): PlaceRecord {
  return {
    id,
    name,
    lat: 59.9,
    lng: 10.7,
    address: '',
    collectionId: null,
    notes: '',
    tags: [],
    icon: 'star',
    color: '#000000',
    visible: true,
    sortIndex: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('commute settings', () => {
  it('recognises the requested favorites and initial filter defaults', () => {
    expect(
      defaultCommuteConfig([
        saved('n', 'Nationaltheatret stasjon'),
        saved('e', 'Engelsrud'),
        saved('a', 'Asker'),
      ]),
    ).toEqual({
      fromId: 'e',
      viaId: 'a',
      toId: 'n',
      allowedBusLines: ['280', '71'],
      excludedRailStops: ['Hvalstad'],
    });
  });

  it('sanitizes a synced setting and falls back for missing filters', () => {
    expect(parseCommuteConfig('{"fromId":"e","allowedBusLines":[" 280 ",""],"toId":7}')).toEqual({
      fromId: 'e',
      viaId: null,
      toId: null,
      allowedBusLines: ['280'],
      excludedRailStops: ['Hvalstad'],
    });
    expect(parseCommuteConfig('{')).toBeNull();
  });
});

describe('useCommute', () => {
  const places = [saved('e', 'Engelsrud'), saved('a', 'Asker'), saved('n', 'Nationaltheatret')];
  const settings = (getSetting: CommuteSettings['getSetting']): CommuteSettings => ({
    status: 'ready',
    getSetting,
    setSetting: vi.fn(),
  });

  /**
   * The contract Android's home-screen widget bridge depends on: until the
   * saved commute has been read there is no question to ask, and `ready` is how
   * a caller tells "no commute configured" from "not read yet". Handing the
   * widget a null query during that window would clear the question it already
   * had, so a launch that never got as far as storage would leave it blank.
   */
  it('has no query and is not ready until the saved setting resolves', async () => {
    let release: (value: string | null) => void = () => {};
    const pending = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const fetchCommute = vi.fn();
    const { result } = renderHook(() =>
      useCommute(
        settings(() => pending),
        places,
        fetchCommute,
        false,
      ),
    );

    expect(result.current.ready).toBe(false);
    expect(result.current.query).toBeNull();

    release(
      JSON.stringify({
        fromId: 'e',
        viaId: 'a',
        toId: 'n',
        allowedBusLines: ['280'],
        excludedRailStops: [],
      }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.query).toMatchObject({
      from: { name: 'Engelsrud' },
      via: [{ name: 'Asker' }],
      to: { name: 'Nationaltheatret' },
      allowedBusLines: ['280'],
    });
    // Closed board: the query exists for the widget, but nothing is fetched.
    expect(fetchCommute).not.toHaveBeenCalled();
  });

  it('seeds first-run defaults into the synced setting exactly once', async () => {
    const setSetting = vi.fn();
    const { result } = renderHook(() =>
      useCommute(
        { status: 'ready', getSetting: () => Promise.resolve(null), setSetting },
        places,
        vi.fn(),
        false,
      ),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting.mock.calls[0]![0]).toBe(COMMUTE_SETTING_KEY);
    expect(parseCommuteConfig(String(setSetting.mock.calls[0]![1]))).toEqual(
      defaultCommuteConfig(places),
    );
  });
});
