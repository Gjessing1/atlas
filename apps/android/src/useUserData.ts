import type { AtlasStorage, NewPlace, PlaceRecord } from '@atlas/storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { openStorage } from './db';

export interface UserData {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  places: PlaceRecord[];
  /** The open storage (null until ready) — for wiring the sync engine only. */
  storage: AtlasStorage | null;
  /** Reload from storage, e.g. after sync applied remote changes. */
  refreshAll: () => Promise<void>;
  savePlace: (input: NewPlace) => Promise<void>;
  deletePlace: (id: string) => Promise<void>;
}

/**
 * Android counterpart of the web app's useUserData: the same @atlas/storage
 * layer over the device's native SQLite (see src/db.ts). Local data is
 * authoritative — the server only syncs (ARCHITECTURE.md rule 3).
 */
export function useUserData(): UserData {
  const [status, setStatus] = useState<UserData['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<PlaceRecord[]>([]);
  const storageRef = useRef<AtlasStorage | null>(null);
  const [storage, setStorage] = useState<AtlasStorage | null>(null);

  const refreshAll = useCallback(async () => {
    const s = storageRef.current;
    if (!s) return;
    setPlaces(await s.listPlaces());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void openStorage()
      .then(async (s) => {
        if (cancelled) return;
        storageRef.current = s;
        setStorage(s);
        setPlaces(await s.listPlaces());
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
      storageRef.current = null;
    };
  }, []);

  const savePlace = useCallback(
    async (input: NewPlace) => {
      await storageRef.current?.createPlace(input);
      await refreshAll();
    },
    [refreshAll],
  );

  const deletePlace = useCallback(
    async (id: string) => {
      await storageRef.current?.deletePlace(id);
      await refreshAll();
    },
    [refreshAll],
  );

  return { status, error, places, storage, refreshAll, savePlace, deletePlace };
}
