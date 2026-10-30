import type { CollectionRecord, PlaceRecord, TrackRecord } from '@atlas/storage';
import { expect, it } from 'vitest';
import {
  libraryEditableTags,
  mergeLibraryTags,
  libraryPlaceName,
  libraryPlaces,
  libraryPlaceLine,
  libraryVisibility,
  isQuickAccess,
  quickAccessTags,
  plannedRouteMetadata,
  activityYear,
  activityYearCounts,
  isAreaTrack,
  librarySportCounts,
  libraryTrackKind,
  libraryTrackSport,
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

it('keeps iNatur permit areas, old saves included, out of Routes & courses', () => {
  const legacy = { ...track('legacy', [], '', 1), name: 'iNatur – Delområde Sleikebekk' };
  const tagged = track('tagged', ['iNatur permit'], '', 2);
  const overlay: TrackRecord = {
    ...track('overlay', [], '', 3),
    area: { kind: 'area', source: 'inatur', sourceId: 'x', polygons: [], bbox: [0, 0, 1, 1] },
  };
  const route = track('ridge', [], '', 4);
  expect(
    libraryTracks([legacy, tagged, overlay, route], 'courses', null, null).map((t) => t.id),
  ).toEqual(['ridge']);
  expect([legacy, tagged, overlay, route].map(isAreaTrack)).toEqual([true, true, true, false]);
});

it('sorts activities by recording date in both directions and routes by distance or name', () => {
  const a = {
    ...track('Alpine', ['garmin:1', 'running'], 'Recorded 2024-06-01', 50),
    stats: { distanceM: 5000 },
  };
  const b = {
    ...track('Beach', ['garmin:2', 'running'], 'Recorded 2025-06-01', 1),
    stats: { distanceM: 2000 },
  };
  expect(libraryTracks([a, b], 'activities', null, null, 'oldest').map((t) => t.id)).toEqual([
    'Alpine',
    'Beach',
  ]);
  expect(libraryTracks([a, b], 'activities', null, null, 'newest').map((t) => t.id)).toEqual([
    'Beach',
    'Alpine',
  ]);
  expect(libraryTracks([a, b], 'activities', null, null, 'distance').map((t) => t.id)).toEqual([
    'Alpine',
    'Beach',
  ]);
});

it('places use readable context, independent shortcuts and deterministic sort orders', () => {
  const folder = { id: 'f', name: 'Cabins', parentId: null, visible: false } as CollectionRecord;
  const home = {
    id: 'h',
    name: 'Home',
    collectionId: 'f',
    tags: ['family'],
    visible: true,
    address: '',
    notes: 'By the lake',
    createdAt: 1,
    sortIndex: 1,
  } as PlaceRecord;
  const work = { ...home, id: 'w', name: 'Work', collectionId: null, createdAt: 2, sortIndex: 0 };
  expect(libraryPlaces([work, home], [folder], 'name').map((p) => p.id)).toEqual(['h', 'w']);
  expect(libraryPlaces([home, work], [folder], 'recent').map((p) => p.id)).toEqual(['w', 'h']);
  expect(libraryPlaces([home, work], [folder], 'folder').map((p) => p.id)).toEqual(['w', 'h']);
  expect(libraryPlaceLine(home, [folder])).toBe('Cabins · By the lake');
  expect(isQuickAccess(home)).toBe(false);
  const pinned = { ...home, tags: quickAccessTags(home) };
  expect(isQuickAccess(pinned)).toBe(true);
  expect(quickAccessTags(pinned)).toEqual(['family']);
  expect(home.tags).toEqual(['family']);
  expect(libraryPlaceName({ ...home, name: '59.9149, 10.7153' })).toBe('By the lake');
  expect(
    libraryEditableTags(['atlas-profile:bike', 'garmin:12', 'quick-access', 'family']),
  ).toEqual(['family']);
  expect(mergeLibraryTags(['atlas-profile:bike', 'quick-access', 'family'], ['cabin'])).toEqual([
    'atlas-profile:bike',
    'quick-access',
    'cabin',
  ]);
  expect(libraryVisibility(home, [folder])).toBe('Hidden by Cabins');
  expect(libraryVisibility({ ...home, visible: false }, [folder])).toBe('Hidden from map');
  expect(libraryVisibility(work, [folder])).toBe('On map');
  expect(libraryVisibility(home, [{ ...folder, visible: true, parentId: 'f' }])).toBe('On map');
});

it('new planner routes retain travel mode and estimated duration without exposing metadata tags', () => {
  const metadata = plannedRouteMetadata({ profile: 'bike', durationMs: 3600000 });
  const saved = {
    ...track('Ride', metadata.tags, '', 1),
    stats: { distanceM: 20000, ...metadata.stats },
  };
  expect(libraryTrackSport(saved)).toBe('Cycling');
  expect(libraryTrackLine(saved)).toContain('Cycling');
  expect(libraryTrackTags(saved)).toEqual([]);
  expect(plannedRouteMetadata({ profile: 'car', durationMs: NaN }).stats).toEqual({});
});
