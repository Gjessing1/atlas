import type { TrackRecord } from '@atlas/storage';
import { expect, it } from 'vitest';
import { activityYear, libraryTrackKind, libraryTracks } from './libraryViews.js';

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
