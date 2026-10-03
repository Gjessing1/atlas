import { describe, expect, it } from 'vitest';
import {
  NO_PIN_LABELS,
  PIN_LABELS_SETTING,
  folderHasPinLabels,
  parsePinLabelPrefs,
  pinLabelFeatures,
  placeHasPinLabel,
  readSetting,
  tagHasPinLabels,
  toggleFolderPinLabels,
  toggleTagPinLabels,
  type PinLabelFolder,
} from './index.js';

// family → kids; stands (unrelated)
const folders = new Map<string, PinLabelFolder>([
  ['family', { parentId: null }],
  ['kids', { parentId: 'family' }],
  ['stands', { parentId: null }],
]);

const place = (
  id: string,
  collectionId: string | null,
  tags: string[] = [],
  sortIndex = 0,
  name = id,
) => ({ id, name, lat: 60, lng: 10, collectionId, tags, sortIndex });

describe('pin label switches', () => {
  it('labels a folder and everything under it, and nothing else', () => {
    const prefs = toggleFolderPinLabels(NO_PIN_LABELS, 'family');
    expect(placeHasPinLabel(place('mum', 'family'), prefs, folders)).toBe(true);
    expect(placeHasPinLabel(place('school', 'kids'), prefs, folders)).toBe(true);
    expect(placeHasPinLabel(place('stand', 'stands'), prefs, folders)).toBe(false);
    expect(placeHasPinLabel(place('loose', null), prefs, folders)).toBe(false);
  });

  it('labels a tag across folders, in any spelling', () => {
    const prefs = toggleTagPinLabels(NO_PIN_LABELS, 'Stand');
    expect(placeHasPinLabel(place('a', 'stands', ['stand']), prefs, folders)).toBe(true);
    expect(placeHasPinLabel(place('b', null, ['STAND']), prefs, folders)).toBe(true);
    expect(placeHasPinLabel(place('c', 'stands', ['spot']), prefs, folders)).toBe(false);
    expect(tagHasPinLabels(prefs, ' stand ')).toBe(true);
  });

  it('toggles off again, a tag regardless of the spelling that turned it on', () => {
    const on = toggleFolderPinLabels(toggleTagPinLabels(NO_PIN_LABELS, 'Hunt'), 'family');
    expect(folderHasPinLabels(on, 'family')).toBe(true);
    const off = toggleFolderPinLabels(toggleTagPinLabels(on, 'hunt'), 'family');
    expect(off).toEqual(NO_PIN_LABELS);
  });

  it('ignores a blank tag', () => {
    expect(toggleTagPinLabels(NO_PIN_LABELS, '  ')).toBe(NO_PIN_LABELS);
  });

  it('does not loop on a cyclic folder chain', () => {
    const cyclic = new Map<string, PinLabelFolder>([
      ['a', { parentId: 'b' }],
      ['b', { parentId: 'a' }],
    ]);
    const prefs = toggleFolderPinLabels(NO_PIN_LABELS, 'family');
    expect(placeHasPinLabel(place('x', 'a'), prefs, cyclic)).toBe(false);
  });
});

describe('pin label features', () => {
  it('draws nothing while no switch is on', () => {
    expect(pinLabelFeatures([place('mum', 'family')], NO_PIN_LABELS, folders).features).toEqual([]);
  });

  it('ranks labels by the list order, so the higher one wins a collision', () => {
    const prefs = toggleFolderPinLabels(NO_PIN_LABELS, 'family');
    const { features } = pinLabelFeatures(
      [
        place('cabin', 'family', [], 3),
        place('mum', 'family', [], 1),
        place('stand', 'stands', [], 0),
        place('nameless', 'family', [], 2, '  '),
      ],
      prefs,
      folders,
    );
    expect(features.map((f) => [f.properties.name, f.properties.rank])).toEqual([
      ['mum', 0],
      ['cabin', 1],
    ]);
    expect(features[0]!.geometry.coordinates).toEqual([10, 60]);
  });
});

describe('pin label setting', () => {
  it('is synced and reads a corrupt row as nothing labelled', () => {
    expect(PIN_LABELS_SETTING.scope).toBe('synced');
    expect(readSetting(PIN_LABELS_SETTING, 'not json')).toEqual(NO_PIN_LABELS);
    expect(readSetting(PIN_LABELS_SETTING, null)).toEqual(NO_PIN_LABELS);
  });

  it('keeps the usable entries of a partly broken row', () => {
    expect(parsePinLabelPrefs({ folders: ['a', 3, ''], tags: 'hunt' })).toEqual({
      folders: ['a'],
      tags: [],
    });
  });

  it('round-trips through its encoding', () => {
    const prefs = { folders: ['family'], tags: ['Stand'] };
    expect(readSetting(PIN_LABELS_SETTING, PIN_LABELS_SETTING.encode(prefs))).toEqual(prefs);
  });
});
