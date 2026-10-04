import { GARMIN_ACTIVITY_TAG, GARMIN_COURSE_TAG, garminSportFolder } from '@atlas/core';
import type { TrackRecord } from '@atlas/storage';

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

export function libraryTrackKind(track: TrackRecord): 'course' | 'activity' | 'track' {
  if (track.tags.some((tag) => tag.startsWith(GARMIN_ACTIVITY_TAG))) return 'activity';
  if (track.tags.some((tag) => tag.startsWith(GARMIN_COURSE_TAG))) return 'course';
  return 'track';
}

export function libraryTrackSport(track: TrackRecord): string | null {
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
): TrackRecord[] {
  return tracks
    .filter((track) => {
      const kind = libraryTrackKind(track);
      if (view === 'activities' ? kind !== 'activity' : kind === 'activity' || track.area !== null)
        return false;
      if (sport && libraryTrackSport(track) !== sport) return false;
      if (year && activityYear(track) !== year) return false;
      return true;
    })
    .sort((a, b) => {
      if (view === 'activities') {
        const date = (activityDate(b) ?? '').localeCompare(activityDate(a) ?? '');
        if (date) return date;
      }
      return b.createdAt - a.createdAt;
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
