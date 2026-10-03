import type { CollectionRecord, PlaceRecord } from '@atlas/storage';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePinLabels } from './usePinLabels.js';

const folder = (id: string, parentId: string | null = null): CollectionRecord => ({
  id,
  name: id,
  parentId,
  visible: true,
  sortIndex: 0,
  createdAt: 0,
  updatedAt: 0,
});

const place = (id: string, collectionId: string | null, tags: string[] = []): PlaceRecord => ({
  id,
  name: id,
  lat: 60,
  lng: 10,
  address: '',
  collectionId,
  notes: '',
  tags,
  icon: '📍',
  color: '#e11d48',
  visible: true,
  sortIndex: 0,
  stand: null,
  createdAt: 0,
  updatedAt: 0,
});

const collections = [folder('family'), folder('kids', 'family'), folder('stands')];
const places = [
  place('mum', 'family'),
  place('school', 'kids'),
  place('tower', 'stands', ['hunt']),
];

describe('usePinLabels', () => {
  it('restores the synced switches and labels only their pins', async () => {
    const store = {
      status: 'ready',
      getSetting: vi.fn(() => Promise.resolve(JSON.stringify({ folders: ['family'], tags: [] }))),
      setSetting: vi.fn(() => Promise.resolve(true)),
    };
    const { result } = renderHook(() => usePinLabels(store, places, collections));
    await waitFor(() => expect(result.current.features.features).toHaveLength(2));
    expect(store.getSetting).toHaveBeenCalledWith('map.pinLabels');
    expect(result.current.features.features.map((f) => f.properties.name).sort()).toEqual([
      'mum',
      'school',
    ]);
  });

  it('switches a tag on and persists it under the synced key', async () => {
    const store = {
      status: 'ready',
      getSetting: vi.fn(() => Promise.resolve(null)),
      setSetting: vi.fn(() => Promise.resolve(true)),
    };
    const { result } = renderHook(() => usePinLabels(store, places, collections));
    await waitFor(() => expect(store.getSetting).toHaveBeenCalled());
    await waitFor(() => expect(result.current.features.features).toHaveLength(0));

    await act(async () => {
      await result.current.toggleTag('Hunt');
    });
    expect(result.current.features.features.map((f) => f.properties.name)).toEqual(['tower']);
    expect(store.setSetting).toHaveBeenLastCalledWith(
      'map.pinLabels',
      JSON.stringify({ folders: [], tags: ['Hunt'] }),
    );
  });
});
