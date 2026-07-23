import { describe, expect, it } from 'vitest';

import { shortManeuverText } from './instructions.js';

describe('shortManeuverText', () => {
  it('reduces a roundabout to the exit to count and the road it leads to', () => {
    expect(
      shortManeuverText({
        text: 'Enter the roundabout and take the 2nd exit onto Drammensveien.',
        exitNumber: 2,
      }),
    ).toBe('2nd exit onto Drammensveien');
  });

  it('falls back to the maneuver street when the prose names no road', () => {
    expect(shortManeuverText({ text: 'Enter the roundabout.', exitNumber: 3 })).toBe('3rd exit');
    expect(
      shortManeuverText({ text: 'Enter the roundabout.', exitNumber: 1, streetName: 'Storgata' }),
    ).toBe('1st exit onto Storgata');
  });

  it('ordinals the teens the English way', () => {
    expect(shortManeuverText({ text: 'Enter the roundabout.', exitNumber: 11 })).toBe('11th exit');
    expect(shortManeuverText({ text: 'Enter the roundabout.', exitNumber: 22 })).toBe('22nd exit');
  });

  it('drops the roundabout preamble even without an exit count', () => {
    expect(shortManeuverText({ text: 'Enter the roundabout and take the exit onto E18.' })).toBe(
      'Exit onto E18',
    );
  });

  it('drops the side of the road — the turn icon already shows it', () => {
    expect(shortManeuverText({ text: 'Take exit 24 on the right onto 283.' })).toBe(
      'Take exit 24 onto 283',
    );
  });

  it('drops signed destinations that the exit-sign chip repeats', () => {
    expect(
      shortManeuverText({
        text: 'Take exit 24 on the right onto 283 toward Drammen.',
        exitSign: { exits: ['24'], toward: ['Drammen'] },
      }),
    ).toBe('Take exit 24 onto 283');
  });

  it('keeps the destination when no exit sign carries it', () => {
    expect(shortManeuverText({ text: 'Keep right to take E18 toward Drammen.' })).toBe(
      'Keep right to take E18 toward Drammen',
    );
  });

  it('keeps only the first cue of a merged instruction', () => {
    expect(shortManeuverText({ text: 'Turn right onto Dronningens gate. Then turn left.' })).toBe(
      'Turn right onto Dronningens gate',
    );
  });

  it('leaves an already short instruction alone, minus its full stop', () => {
    expect(shortManeuverText({ text: 'Turn left onto Storgata.' })).toBe('Turn left onto Storgata');
    expect(shortManeuverText({ text: '' })).toBe('');
  });
});
