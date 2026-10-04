import {
  EXPLORE_CATEGORIES,
  exploreCategoriesForProfile,
  sanitizeExploreShortcuts,
  type ExploreCategoryId,
} from '@atlas/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

const SETTING = 'map.explore-shortcuts';

export interface ExploreShortcutSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<boolean>;
}

/** The compact browse row follows the profile and the signed-in user's synced settings. */
export function useExploreShortcuts(settings: ExploreShortcutSettings, profileId: string) {
  const [overrides, setOverrides] = useState<Record<string, ExploreCategoryId[]>>({});
  const [loaded, setLoaded] = useState(false);
  const { status, getSetting, setSetting } = settings;

  useEffect(() => {
    if (status !== 'ready') {
      setLoaded(false);
      return;
    }
    let cancelled = false;
    void getSetting(SETTING)
      .then((raw) => {
        if (cancelled || !raw) return;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          const cleaned: Record<string, ExploreCategoryId[]> = {};
          for (const [profile, ids] of Object.entries(parsed)) {
            if (Array.isArray(ids)) cleaned[profile] = sanitizeExploreShortcuts(ids, profile);
          }
          setOverrides(cleaned);
        } catch {
          // Invalid preferences leave the profile defaults available.
        }
      })
      .catch(() => {
        // Reading a broken store leaves the defaults visible.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const shortcuts = useMemo(
    () => overrides[profileId] ?? exploreCategoriesForProfile(profileId).map((item) => item.id),
    [overrides, profileId],
  );
  const categories = useMemo(
    () => shortcuts.map((id) => EXPLORE_CATEGORIES.find((item) => item.id === id)!),
    [shortcuts],
  );

  const setPinned = useCallback(
    (id: ExploreCategoryId, pinned: boolean) => {
      if (!loaded || status !== 'ready') return;
      setOverrides((current) => {
        const before =
          current[profileId] ?? exploreCategoriesForProfile(profileId).map((item) => item.id);
        if (!pinned && before.length === 1 && before.includes(id)) return current;
        const nextIds = pinned ? [...before, id] : before.filter((item) => item !== id);
        const next = { ...current, [profileId]: sanitizeExploreShortcuts(nextIds, profileId) };
        void setSetting(SETTING, JSON.stringify(next));
        return next;
      });
    },
    [loaded, profileId, setSetting, status],
  );

  const reset = useCallback(() => {
    if (!loaded || status !== 'ready') return;
    setOverrides((current) => {
      const next = { ...current };
      delete next[profileId];
      void setSetting(SETTING, JSON.stringify(next));
      return next;
    });
  }, [loaded, profileId, setSetting, status]);

  return { shortcuts, categories, editable: loaded && status === 'ready', setPinned, reset };
}
