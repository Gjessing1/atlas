import { describe, expect, it } from 'vitest';
import { parseNavWidgets } from './nav-widgets.js';

describe('parseNavWidgets', () => {
  it('validates, deduplicates and caps the stored selection', () => {
    expect(
      parseNavWidgets('["altitude","altitude","next-turn","remaining","speed","bogus"]'),
    ).toEqual(['altitude', 'next-turn', 'remaining']);
  });

  it('falls back for invalid storage', () => {
    expect(parseNavWidgets('nope')).toEqual(['speed']);
  });
});
