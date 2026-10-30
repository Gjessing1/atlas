import {
  fmtShortDate,
  GARMIN_ACTIVITY_TAG,
  GARMIN_COURSE_TAG,
  garminSportFolder,
  trackListLine,
  trackSummary,
  userTags,
} from '@atlas/core';
import { isRoutingProfile, type RoutingProfile } from '@atlas/routing';
import type { CollectionRecord, PlaceRecord, TrackRecord } from '@atlas/storage';

export type LibraryView = 'folders' | 'places' | 'courses' | 'activities';

/** Imported recordings use their Garmin recording date, never their Atlas import date. */
export function activityYear(track: TrackRecord): number | null {
  if (!track.tags.some((tag) => tag.startsWith(GARMIN_ACTIVITY_TAG))) return null;
  const match = /^Recorded (\d{4})-\d{2}-\d{2}/.exec(track.notes);
  const year = match ? Number(match[1]) : NaN;
  return Number.isInteger(year) && year >= 1900 && year <= 9999 ? year : null;
}

export function activityDate(track: TrackRecord): string | null {
  if (libraryTrackKind(track) !== 'activity') return null;
  return /^Recorded (\d{4}-\d{2}-\d{2})/.exec(track.notes)?.[1] ?? null;
}

/**
 * A saved area (an iNatur permit boundary), not a line to follow. Saves since the area overlay
 * carry `area`; older ones (Sleikebekk) have only the tag or the `iNatur …` name, and were
 * listed among Routes & courses.
 */
export function isAreaTrack(track: TrackRecord): boolean {
  return (
    track.area !== null ||
    track.tags.some((tag) => tag.toLowerCase() === 'inatur permit') ||
    track.name.toLowerCase().startsWith('inatur')
  );
}

export function libraryTrackKind(track: TrackRecord): 'course' | 'activity' | 'track' {
  if (track.tags.some((tag) => tag.startsWith(GARMIN_ACTIVITY_TAG))) return 'activity';
  if (track.tags.some((tag) => tag.startsWith(GARMIN_COURSE_TAG))) return 'course';
  return 'track';
}

/**
 * The sport folder of a Garmin activity or course copy. A plain Atlas track has none: its tags
 * are the user's own words (`hunt`, `cabin`), and reading them as sports put a "Hunt" chip in
 * the Routes sport filter.
 */
export function libraryTrackSport(track: TrackRecord): string | null {
  if (libraryTrackKind(track) === 'track') {
    const profile = track.tags
      .find((tag) => tag.startsWith('atlas-profile:'))
      ?.slice('atlas-profile:'.length);
    return profile && isRoutingProfile(profile) ? ROUTE_SPORTS[profile] : null;
  }
  const type = track.tags.find(
    (tag) => tag && !tag.startsWith(GARMIN_ACTIVITY_TAG) && !tag.startsWith(GARMIN_COURSE_TAG),
  );
  return type ? garminSportFolder(type) : null;
}

export function libraryTracks(
  tracks: readonly TrackRecord[],
  view: 'courses' | 'activities',
  sport: string | null,
  year: number | null,
  sort: LibraryTrackSort = 'newest',
): TrackRecord[] {
  return tracks
    .filter((track) => {
      const kind = libraryTrackKind(track);
      if (view === 'activities' ? kind !== 'activity' : kind === 'activity' || isAreaTrack(track))
        return false;
      if (sport && libraryTrackSport(track) !== sport) return false;
      if (year && activityYear(track) !== year) return false;
      return true;
    })
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      if (sort === 'distance')
        return (
          (b.stats['distanceM'] ?? 0) - (a.stats['distanceM'] ?? 0) || a.name.localeCompare(b.name)
        );
      if (view === 'activities') {
        const date = (activityDate(b) ?? '').localeCompare(activityDate(a) ?? '');
        if (date) return sort === 'oldest' ? -date : date;
      }
      return (
        (sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt) ||
        a.name.localeCompare(b.name)
      );
    });
}

export function librarySports(tracks: readonly TrackRecord[]): string[] {
  return [
    ...new Set(tracks.map(libraryTrackSport).filter((sport): sport is string => !!sport)),
  ].sort();
}

export function activityYears(tracks: readonly TrackRecord[]): number[] {
  return [
    ...new Set(tracks.map(activityYear).filter((year): year is number => year !== null)),
  ].sort((a, b) => b - a);
}

/** Sport filters with how many tracks each holds, largest first — the order a thumb wants. */
export function librarySportCounts(
  tracks: readonly TrackRecord[],
): { sport: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    const sport = libraryTrackSport(track);
    if (sport) counts.set(sport, (counts.get(sport) ?? 0) + 1);
  }
  return [...counts]
    .map(([sport, count]) => ({ sport, count }))
    .sort((a, b) => b.count - a.count || a.sport.localeCompare(b.sport));
}

/** Year filters with their activity counts, newest first. */
export function activityYearCounts(
  tracks: readonly TrackRecord[],
): { year: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const track of tracks) {
    const year = activityYear(track);
    if (year !== null) counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return [...counts].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year);
}

/**
 * A track row's one line under its name. An activity leads with the day it was recorded and its
 * sport; a course copy says it came from Garmin. Each fact once: the row used to repeat the
 * provenance ("Garmin recording · Atlas copy"), the date (recorded and GPX start) and the sport
 * (text and tag chip), which wrapped to three lines on a phone.
 */
export function libraryTrackLine(track: TrackRecord, nowMs = Date.now()): string {
  const kind = libraryTrackKind(track);
  if (kind === 'track')
    return [libraryTrackSport(track), trackListLine(track.stats, nowMs)]
      .filter(Boolean)
      .join(' · ');
  const sport = libraryTrackSport(track);
  const recorded = activityDate(track);
  const parts: string[] = [];
  if (kind === 'activity' && recorded) {
    const [year, month, day] = recorded.split('-').map(Number) as [number, number, number];
    parts.push(fmtShortDate(new Date(year, month - 1, day).getTime(), nowMs));
  } else if (kind === 'course') parts.push('Garmin course');
  if (sport) parts.push(sport);
  const summary =
    kind === 'activity' && recorded ? trackSummary(track.stats) : trackListLine(track.stats, nowMs);
  if (summary) parts.push(summary);
  return parts.join(' · ');
}

/**
 * The tags a track row offers as filters: the user's own. A Garmin copy also carries its raw
 * type (`trail_running`), which the row already says as its sport.
 */
export function libraryTrackTags(track: TrackRecord): string[] {
  const tags = userTags(track.tags).filter((tag) => !tag.startsWith('atlas-profile:'));
  if (libraryTrackKind(track) === 'track') return tags;
  const type = track.tags.find(
    (tag) => tag && !tag.startsWith(GARMIN_ACTIVITY_TAG) && !tag.startsWith(GARMIN_COURSE_TAG),
  );
  return tags.filter((tag) => tag !== type);
}

export type LibraryTrackSort = 'newest' | 'oldest' | 'name' | 'distance';
export type LibraryPlaceSort = 'manual' | 'name' | 'recent' | 'folder';

/** A normal exported/synced tag keeps shortcuts usable offline without a second place copy. */
export const QUICK_ACCESS_TAG = 'quick-access';
export const isQuickAccess = (place: Pick<PlaceRecord, 'tags'>): boolean =>
  place.tags.includes(QUICK_ACCESS_TAG);
export const quickAccessTags = (place: Pick<PlaceRecord, 'tags'>): string[] =>
  isQuickAccess(place)
    ? place.tags.filter((tag) => tag !== QUICK_ACCESS_TAG)
    : [...place.tags, QUICK_ACCESS_TAG];

export function libraryPlaces(
  places: readonly PlaceRecord[],
  folders: readonly CollectionRecord[],
  sort: LibraryPlaceSort,
): PlaceRecord[] {
  const names = new Map(folders.map((folder) => [folder.id, folder.name]));
  return [...places].sort((a, b) => {
    if (sort === 'recent') return b.createdAt - a.createdAt || a.name.localeCompare(b.name);
    if (sort === 'folder') {
      const folder = (names.get(a.collectionId ?? '') ?? '').localeCompare(
        names.get(b.collectionId ?? '') ?? '',
      );
      if (folder) return folder;
    }
    if (sort === 'manual') return a.sortIndex - b.sortIndex || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

/** Human context belongs in lists; coordinates remain in the place details. */
export function libraryPlaceLine(place: PlaceRecord, folders: readonly CollectionRecord[]): string {
  const folder = folders.find((item) => item.id === place.collectionId)?.name;
  return (
    [folder, place.address || place.notes.split('\n')[0]].filter(Boolean).join(' · ') ||
    'Saved place'
  );
}

/** Folder suppression is a map state, never a disabled or faded library item. */
export function libraryVisibility(
  item: { visible: boolean; collectionId: string | null },
  folders: readonly CollectionRecord[],
): string {
  if (!item.visible) return 'Hidden from map';
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const seen = new Set<string>();
  let id = item.collectionId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    if (!folder.visible) return `Hidden by ${folder.name}`;
    id = folder.parentId;
  }
  return 'On map';
}

export interface SavedRouteMetadata {
  profile: RoutingProfile;
  durationMs: number;
}
const ROUTE_SPORTS: Record<RoutingProfile, string> = {
  car: 'Driving',
  bike: 'Cycling',
  foot: 'Walking',
  hike: 'Hiking',
  run: 'Running',
};
export function plannedRouteMetadata(metadata?: SavedRouteMetadata): {
  tags: string[];
  stats: Record<string, number>;
} {
  if (!metadata) return { tags: [], stats: {} };
  return {
    tags: [`atlas-profile:${metadata.profile}`],
    stats:
      Number.isFinite(metadata.durationMs) && metadata.durationMs > 0
        ? { durationMs: metadata.durationMs }
        : {},
  };
}

/** Old unnamed pins used their coordinates as a generated name; keep that in details only. */
export function libraryPlaceName(place: Pick<PlaceRecord, 'name' | 'address' | 'notes'>): string {
  return /^[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?$/.test(place.name.trim())
    ? place.address || place.notes.split('\n')[0] || 'Saved place'
    : place.name;
}

/** Bookkeeping is kept in exports/sync, outside user-facing tag fields and suggestions. */
export function libraryEditableTags(tags: readonly string[]): string[] {
  return userTags([...tags]).filter(
    (tag) => tag !== QUICK_ACCESS_TAG && !tag.startsWith('atlas-profile:'),
  );
}
export function mergeLibraryTags(original: readonly string[], edited: readonly string[]): string[] {
  const editable = new Set(libraryEditableTags(original));
  return [...original.filter((tag) => !editable.has(tag)), ...libraryEditableTags(edited)];
}
