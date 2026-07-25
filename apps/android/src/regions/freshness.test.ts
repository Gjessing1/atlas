import { describe, expect, it } from 'vitest';

import { stalePackIds } from './freshness';

describe('stalePackIds', () => {
  it('flags a downloaded pack the server has rebuilt', () => {
    const stale = stalePackIds(
      [
        { id: 'norway-south', version: 3 },
        { id: 'oslo', version: 7 },
      ],
      [
        { id: 'norway-south', version: 5 },
        { id: 'oslo', version: 7 },
      ],
    );
    expect([...stale]).toEqual(['norway-south']);
  });

  it('says nothing about a pack the server no longer publishes', () => {
    // A custom drawn region: its job artifacts expire, so there is no update to
    // offer and a warning would only be noise.
    expect(
      stalePackIds([{ id: 'custom-abc', version: 1 }], [{ id: 'oslo', version: 9 }]).size,
    ).toBe(0);
  });

  it('never treats a newer local pack as stale', () => {
    expect(stalePackIds([{ id: 'oslo', version: 9 }], [{ id: 'oslo', version: 8 }]).size).toBe(0);
  });
});
