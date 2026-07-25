import { describe, expect, it } from 'vitest';
import {
  hasWikivoyage,
  localWikiLanguages,
  wikiLanguage,
  wikiLanguageChain,
} from './wiki-language.js';

const oslo = { lat: 59.9127, lng: 10.7461 };

describe('wikiLanguage', () => {
  it('reduces a device locale to a Wikipedia edition', () => {
    expect(wikiLanguage('en-GB')).toBe('en');
    expect(wikiLanguage('nb_NO')).toBe('no');
    expect(wikiLanguage('nn-NO')).toBe('nn');
  });

  it('falls back to English for a missing or nonsense locale', () => {
    expect(wikiLanguage(undefined)).toBe('en');
    expect(wikiLanguage('klingon-1')).toBe('en');
  });
});

describe('localWikiLanguages', () => {
  it('knows what is spoken where', () => {
    expect(localWikiLanguages(oslo)).toEqual(['no', 'nn']);
    expect(localWikiLanguages({ lat: 59.3293, lng: 18.0686 })).toEqual(['sv']);
    expect(localWikiLanguages({ lat: 55.6761, lng: 12.5683 })).toEqual(['da']);
  });

  it('prefers the smallest region containing the point', () => {
    // Geneva is inside the Swiss box, but Romandy's is smaller and French.
    expect(localWikiLanguages({ lat: 46.2044, lng: 6.1432 })).toEqual(['fr']);
    expect(localWikiLanguages({ lat: 47.3769, lng: 8.5417 })).toEqual(['de']);
    // Malmö is Swedish even though Denmark is a stone's throw west.
    expect(localWikiLanguages({ lat: 55.605, lng: 13.0038 })).toEqual(['sv']);
  });

  it('has no opinion where English is the local language anyway', () => {
    expect(localWikiLanguages({ lat: 40.7128, lng: -74.006 })).toEqual([]);
    expect(localWikiLanguages({ lat: 51.5072, lng: -0.1276 })).toEqual([]);
  });
});

describe('wikiLanguageChain', () => {
  it('reads in the reader’s language first, then the local one', () => {
    expect(wikiLanguageChain('en-US', oslo)).toEqual(['en', 'no', 'nn']);
  });

  it('keeps English as the second try for a local reader', () => {
    // Nynorsk is worth asking, but not before the edition everyone can read.
    expect(wikiLanguageChain('nb-NO', oslo)).toEqual(['no', 'en', 'nn']);
  });

  it('asks the reader’s, the local and the universal edition abroad', () => {
    expect(wikiLanguageChain('de-DE', oslo)).toEqual(['de', 'no', 'en']);
  });

  it('does not invent editions where the reader is already local', () => {
    expect(wikiLanguageChain('en-GB', { lat: 51.5072, lng: -0.1276 })).toEqual(['en']);
  });

  it('limits how many editions a caller may ask', () => {
    expect(wikiLanguageChain('en', oslo, 2)).toEqual(['en', 'no']);
  });
});

describe('hasWikivoyage', () => {
  it('knows the project is far smaller than Wikipedia', () => {
    expect(hasWikivoyage('en')).toBe(true);
    expect(hasWikivoyage('sv')).toBe(true);
    expect(hasWikivoyage('no')).toBe(false);
  });
});
