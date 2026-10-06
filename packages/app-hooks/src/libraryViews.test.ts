import type { TrackRecord } from '@atlas/storage';
import { expect, it } from 'vitest';
import {
  activityYear,
  activityYearCounts,
  librarySportCounts,
  libraryTrackKind,
  libraryTrackLine,
  libraryTrackTags,
  libraryTracks,
} from './libraryViews.js';

const track = (id: string, tags: string[], notes: string, createdAt: number): TrackRecord => ({
  id,
  name: id,
  tags,
  notes,
  createdAt,
  updatedAt: createdAt,
  stats: {},
  collectionId: null,
  visible: true,
  area: null,
});

it('filters recordings by their recorded year and sport, not their import date', () => {
  const tracks = [
    track(
      'run-this-year',
      ['garmin:1', 'trail_running'],
      'Recorded 2026-05-01 in Garmin Connect',
      1,
    ),
    track('run-last-year', ['garmin:2', 'running'], 'Recorded 2025-09-01 in Garmin Connect', 9),
    track(
      'skate-last-year',
      ['garmin:3', 'skating_ws'],
      'Recorded 2025-01-02 in Garmin Connect',
      10,
    ),
    track('undated', ['garmin:4', 'running'], 'Garmin Connect activity', 11),
    track('saved-course', ['garmin-course:5', 'running'], 'Copied from Garmin Connect', 12),
  ];
  expect(libraryTracks(tracks, 'activities', 'Running', 2026).map((item) => item.id)).toEqual([
    'run-this-year',
  ]);
  expect(libraryTracks(tracks, 'activities', 'Skating', 2025).map((item) => item.id)).toEqual([
    'skate-last-year',
  ]);
  expect(activityYear(tracks[3]!)).toBeNull();
  expect(libraryTrackKind(tracks[4]!)).toBe('course');
  expect(libraryTracks(tracks, 'courses', null, null).map((item) => item.id)).toEqual([
    'saved-course',
  ]);
});

it("never reads a plain track's own tags as a sport", () => {
  const tracks = [
    track('stand-walk', ['hunt', 'cabin'], '', 1),
    track('run-a', ['garmin:1', 'running'], 'Recorded 2026-05-01 in Garmin Connect', 2),
    track('run-b', ['garmin:2', 'trail_running'], 'Recorded 2025-05-01 in Garmin Connect', 3),
    track('skate', ['garmin:3', 'skating_ws'], 'Recorded 2025-01-02 in Garmin Connect', 4),
  ];
  expect(librarySportCounts(tracks)).toEqual([
    { sport: 'Running', count: 2 },
    { sport: 'Skating', count: 1 },
  ]);
  expect(libraryTracks(tracks, 'courses', null, null).map((item) => item.id)).toEqual([
    'stand-walk',
  ]);
  expect(activityYearCounts(tracks)).toEqual([
    { year: 2026, count: 1 },
    { year: 2025, count: 2 },
  ]);
});

it('says each fact about a track once on its row', () => {
  const now = new Date(2026, 9, 6).getTime();
  const run = {
    ...track(
      'run',
      ['garmin:1', 'trail_running', 'race'],
      'Recorded 2026-05-01 in Garmin Connect',
      1,
    ),
    stats: { distanceM: 10_200, startTime: new Date(2026, 4, 1, 7).getTime() },
  };
  expect(libraryTrackLine(run, now)).toBe('1 May · Running · 10.2 km');
  expect(libraryTrackTags(run)).toEqual(['race']);
  const course = {
    ...track('course', ['garmin-course:9', 'hiking'], 'Copied from Garmin Connect', 1),
    stats: { distanceM: 9_800 },
  };
  expect(libraryTrackLine(course, now)).toBe('Garmin course · Hiking · 9.8 km');
  expect(libraryTrackTags(track('own', ['hunt'], '', 1))).toEqual(['hunt']);
});
