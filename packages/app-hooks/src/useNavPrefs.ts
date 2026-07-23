import { MAX_NAV_WIDGETS, parseNavWidgets, type NavWidgetId } from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Navigation preferences that survive across trips. Device-local by design —
 * a phone mounted in a car and a desktop planning the same drive disagree on
 * purpose, and `local.` keys are excluded from sync.
 */
const MUTED_SETTING = 'local.nav.muted';
const FOLLOW_SETTING = 'local.nav.follow';
const WIDGETS_SETTING = 'local.nav.widgets';

export type NavFollowMode = 'course' | 'north';

export interface NavPrefsSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

/** The slice of a navigation controller these preferences own. */
export interface NavPrefsTarget {
  muted: boolean;
  setMuted: (muted: boolean) => void;
}

export interface NavPrefsController {
  /** Map orientation while navigating: direction of travel, or north-up. */
  followMode: NavFollowMode;
  setFollowMode: (mode: NavFollowMode) => void;
  toggleFollowMode: () => void;
  /** Curated readouts shown during guidance, in display order. */
  widgets: NavWidgetId[];
  toggleWidget: (widget: NavWidgetId) => void;
}

/**
 * Loads and persists the two nav preferences shared by both apps: voice mute
 * and map orientation.
 *
 * Mute is owned by the navigation controller (the banner's button toggles it
 * there, and voice prompts read it); this hook only mirrors it to storage and
 * restores it at startup. The orientation is owned here, because the two apps
 * feed it to different camera implementations.
 */
export function useNavPrefs(settings: NavPrefsSettings, nav: NavPrefsTarget): NavPrefsController {
  const { status, getSetting, setSetting } = settings;
  const [followMode, setFollowModeState] = useState<NavFollowMode>('course');
  const [widgets, setWidgets] = useState<NavWidgetId[]>(() => parseNavWidgets(null));

  // Read through a ref: a controller that hands out a fresh setMuted each
  // render would otherwise re-run the load effect and clobber a live toggle.
  const setMutedRef = useRef(nav.setMuted);
  setMutedRef.current = nav.setMuted;

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(MUTED_SETTING).then((raw) => {
      if (!cancelled && raw != null) setMutedRef.current(raw === 'true');
    });
    void getSetting(FOLLOW_SETTING).then((raw) => {
      if (!cancelled && (raw === 'north' || raw === 'course')) setFollowModeState(raw);
    });
    void getSetting(WIDGETS_SETTING).then((raw) => {
      if (!cancelled) setWidgets(parseNavWidgets(raw));
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const setFollowMode = useCallback(
    (mode: NavFollowMode) => {
      setFollowModeState(mode);
      setSetting(FOLLOW_SETTING, mode);
    },
    [setSetting],
  );

  const toggleFollowMode = useCallback(() => {
    setFollowModeState((mode) => {
      const next = mode === 'course' ? 'north' : 'course';
      setSetting(FOLLOW_SETTING, next);
      return next;
    });
  }, [setSetting]);

  const toggleWidget = useCallback(
    (widget: NavWidgetId) => {
      setWidgets((current) => {
        const next = current.includes(widget)
          ? current.filter((item) => item !== widget)
          : current.length < MAX_NAV_WIDGETS
            ? [...current, widget]
            : current;
        setSetting(WIDGETS_SETTING, JSON.stringify(next));
        return next;
      });
    },
    [setSetting],
  );

  // Mute is toggled through the controller (banner button); persist the result
  // rather than wrapping every caller. Skip the initial value so a restored
  // preference isn't immediately written back over itself.
  const prevMuted = useRef(nav.muted);
  useEffect(() => {
    if (prevMuted.current === nav.muted) return;
    prevMuted.current = nav.muted;
    if (status === 'ready') setSetting(MUTED_SETTING, String(nav.muted));
  }, [nav.muted, status, setSetting]);

  return { followMode, setFollowMode, toggleFollowMode, widgets, toggleWidget };
}
