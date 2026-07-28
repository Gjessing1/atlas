import { describe, expect, it } from 'vitest';

import { SETTINGS_SECTIONS, settingsSectionsFor } from './settings.js';

describe('settings sections', () => {
  it('has one entry per id, each with a hint', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of SETTINGS_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.hint.length).toBeGreaterThan(0);
    }
  });

  it('drops only the sections a browser cannot have, keeping the order', () => {
    expect(settingsSectionsFor('android').map((s) => s.id)).toEqual([
      'appearance',
      'layers',
      'tiles',
      'profiles',
      'navigation',
      'offline',
      'account',
      'system',
    ]);
    expect(settingsSectionsFor('web').map((s) => s.id)).toEqual([
      'appearance',
      'layers',
      'profiles',
      'navigation',
      'account',
      'system',
    ]);
  });

  it('names each shared section identically on both clients', () => {
    const android = new Map(settingsSectionsFor('android').map((s) => [s.id, s.label]));
    for (const section of settingsSectionsFor('web')) {
      expect(section.label).toBe(android.get(section.id));
    }
  });
});
