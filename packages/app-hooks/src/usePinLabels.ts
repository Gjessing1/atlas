import {
  PIN_LABELS_SETTING,
  pinLabelFeatures,
  toggleFolderPinLabels,
  toggleTagPinLabels,
  type PinLabelFeature,
  type PinLabelFolder,
  type PinLabelPrefs,
} from '@atlas/core';
import type { CollectionRecord, PlaceRecord } from '@atlas/storage';
import { useCallback, useMemo } from 'react';

import { usePersistedSetting, type SettingsAccess } from './usePersistedSetting.js';

export interface PinLabelsController {
  prefs: PinLabelPrefs;
  /** Switch a folder's labels (its whole subtree follows). */
  toggleFolder: (folderId: string) => Promise<boolean>;
  /** Switch a tag's labels, across every folder. */
  toggleTag: (tag: string) => Promise<boolean>;
  /** The label points for the drawn pins — empty when nothing is switched on. */
  features: { type: 'FeatureCollection'; features: PinLabelFeature[] };
}

/**
 * Per-folder and per-tag pin labels for both map clients: the synced switch
 * state, and the points to label among the places actually drawn.
 *
 * `drawnPlaces` must be the visibility-filtered list the map renders, so a
 * hidden pin never leaves its name behind.
 */
export function usePinLabels(
  settings: SettingsAccess,
  drawnPlaces: readonly PlaceRecord[],
  collections: readonly CollectionRecord[],
): PinLabelsController {
  const stored = usePersistedSetting(settings, PIN_LABELS_SETTING);
  const { setValue } = stored;
  const prefs = stored.value;
  const toggleFolder = useCallback(
    (folderId: string) => setValue((current) => toggleFolderPinLabels(current, folderId)),
    [setValue],
  );
  const toggleTag = useCallback(
    (tag: string) => setValue((current) => toggleTagPinLabels(current, tag)),
    [setValue],
  );
  const features = useMemo(() => {
    const folders = new Map<string, PinLabelFolder>(
      collections.map((folder) => [folder.id, { parentId: folder.parentId }]),
    );
    return pinLabelFeatures(drawnPlaces, prefs, folders);
  }, [drawnPlaces, collections, prefs]);
  return { prefs, toggleFolder, toggleTag, features };
}
