import {
  defaultNavWidgetsFor,
  isNavWidgetId,
  MAX_NAV_WIDGETS,
  type NavWidgetId,
} from '@atlas/core';
import type { RoutingProfile } from '@atlas/routing';
import type { HeadingSource } from '@atlas/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Navigation preferences that survive across trips. Device-local by design —
 * a phone mounted in a car and a desktop planning the same drive disagree on
 * purpose, and `local.` keys are excluded from sync.
 */
const MUTED_SETTING = 'local.nav.muted';
const FOLLOW_SETTING = 'local.nav.follow';
/**
 * Walking modes keep their own orientation preference: OsmAnd defaults
 * pedestrians to north-up (the walker turns on the spot constantly — a map
 * that spun with them would be unreadable) while course-up stays the right
 * driving default, and one shared key would make each trip clobber the other
 * mode's choice.
 */
const FOLLOW_WALK_SETTING = 'local.nav.follow.walk';
const WIDGETS_SETTING = 'local.nav.widgets';
const HEADING_SOURCE_SETTING = 'local.nav.heading-source';

export type NavFollowMode = 'course' | 'north';

/** Modes where the traveller is a pedestrian, not a vehicle. */
const isWalking = (profile: RoutingProfile): boolean =>
  profile === 'foot' || profile === 'hike' || profile === 'run';

export interface NavPrefsSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

/** The slice of a navigation controller these preferences own or read. */
export interface NavPrefsTarget {
  muted: boolean;
  setMuted: (muted: boolean) => void;
  /** Travel mode of the current trip — picks the orientation/widget defaults. */
  profile: RoutingProfile;
  headingSource: HeadingSource;
  setHeadingSource: (source: HeadingSource) => void;
}

export interface NavPrefsController {
  /** Map orientation while navigating: direction of travel, or north-up. */
  followMode: NavFollowMode;
  setFollowMode: (mode: NavFollowMode) => void;
  toggleFollowMode: () => void;
  /** Direction-arrow input for walking, running and cycling guidance. */
  headingSource: HeadingSource;
  setHeadingSource: (source: HeadingSource) => void;
  /** Curated readouts shown during guidance, in display order. */
  widgets: NavWidgetId[];
  toggleWidget: (widget: NavWidgetId) => void;
}

const parseFollow = (raw: string | null): NavFollowMode | null =>
  raw === 'north' || raw === 'course' ? raw : null;

const parseHeadingSource = (raw: string | null): HeadingSource | null =>
  raw === 'auto' || raw === 'compass' || raw === 'gps' ? raw : null;

/** Parse a stored widget strip; null when nothing (valid) was ever saved. */
function parseStoredWidgets(raw: string | null): NavWidgetId[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    const widgets: NavWidgetId[] = [];
    for (const item of value) {
      if (isNavWidgetId(item) && !widgets.includes(item)) widgets.push(item);
      if (widgets.length === MAX_NAV_WIDGETS) break;
    }
    return widgets;
  } catch {
    return null;
  }
}

/**
 * Loads and persists the nav preferences shared by both apps: voice mute, map
 * orientation and the widget strip.
 *
 * Mute is owned by the navigation controller (the banner's button toggles it
 * there, and voice prompts read it); this hook only mirrors it to storage and
 * restores it at startup. The orientation is owned here, because the two apps
 * feed it to different camera implementations — and it is kept per mode
 * *class*: driving modes and walking modes each remember their own choice,
 * with walking defaulting to north-up. Widgets follow the same shape: one
 * saved strip wins everywhere, but until the user curates one the defaults
 * track the trip's mode (a hike leads with climb, not speed).
 */
export function useNavPrefs(settings: NavPrefsSettings, nav: NavPrefsTarget): NavPrefsController {
  const { status, getSetting, setSetting } = settings;
  const [driveFollow, setDriveFollow] = useState<NavFollowMode>('course');
  const [walkFollow, setWalkFollow] = useState<NavFollowMode>('north');
  /** The user's saved strip, or null while the defaults apply. */
  const [customWidgets, setCustomWidgets] = useState<NavWidgetId[] | null>(null);

  const walking = isWalking(nav.profile);
  const followMode = walking ? walkFollow : driveFollow;
  const widgets = customWidgets ?? defaultNavWidgetsFor(nav.profile);

  // Read through a ref: a controller that hands out a fresh setMuted each
  // render would otherwise re-run the load effect and clobber a live toggle.
  const setMutedRef = useRef(nav.setMuted);
  setMutedRef.current = nav.setMuted;
  const setHeadingSourceRef = useRef(nav.setHeadingSource);
  setHeadingSourceRef.current = nav.setHeadingSource;

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void getSetting(MUTED_SETTING).then((raw) => {
      if (!cancelled && raw != null) setMutedRef.current(raw === 'true');
    });
    void getSetting(FOLLOW_SETTING).then((raw) => {
      const mode = parseFollow(raw);
      if (!cancelled && mode) setDriveFollow(mode);
    });
    void getSetting(FOLLOW_WALK_SETTING).then((raw) => {
      const mode = parseFollow(raw);
      if (!cancelled && mode) setWalkFollow(mode);
    });
    void getSetting(WIDGETS_SETTING).then((raw) => {
      if (!cancelled) setCustomWidgets(parseStoredWidgets(raw));
    });
    void getSetting(HEADING_SOURCE_SETTING).then((raw) => {
      const source = parseHeadingSource(raw);
      if (!cancelled && source) setHeadingSourceRef.current(source);
    });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const walkingRef = useRef(walking);
  walkingRef.current = walking;

  const setFollowMode = useCallback(
    (mode: NavFollowMode) => {
      if (walkingRef.current) {
        setWalkFollow(mode);
        setSetting(FOLLOW_WALK_SETTING, mode);
      } else {
        setDriveFollow(mode);
        setSetting(FOLLOW_SETTING, mode);
      }
    },
    [setSetting],
  );

  const toggleFollowMode = useCallback(() => {
    const apply = (setState: typeof setDriveFollow, key: string) =>
      setState((mode) => {
        const next = mode === 'course' ? 'north' : 'course';
        setSetting(key, next);
        return next;
      });
    if (walkingRef.current) apply(setWalkFollow, FOLLOW_WALK_SETTING);
    else apply(setDriveFollow, FOLLOW_SETTING);
  }, [setSetting]);

  const setHeadingSource = useCallback(
    (source: HeadingSource) => {
      setHeadingSourceRef.current(source);
      setSetting(HEADING_SOURCE_SETTING, source);
    },
    [setSetting],
  );

  // The first toggle materialises the mode's defaults as a saved strip; from
  // then on the one curated strip applies to every mode.
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  const toggleWidget = useCallback(
    (widget: NavWidgetId) => {
      const current = widgetsRef.current;
      const next = current.includes(widget)
        ? current.filter((item) => item !== widget)
        : current.length < MAX_NAV_WIDGETS
          ? [...current, widget]
          : current;
      setCustomWidgets(next);
      setSetting(WIDGETS_SETTING, JSON.stringify(next));
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

  return {
    followMode,
    setFollowMode,
    toggleFollowMode,
    headingSource: nav.headingSource,
    setHeadingSource,
    widgets,
    toggleWidget,
  };
}
