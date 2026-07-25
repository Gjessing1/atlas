import type { LatLng } from './geo.js';

/** `[west, south, east, north, ...Wikipedia language codes]`. */
type LanguageBox = readonly [number, number, number, number, ...string[]];

/**
 * Which Wikipedia edition is the *local* one at a coordinate.
 *
 * Deliberately coarse — country-ish boxes, not borders. The stakes are low in
 * both directions: the language only decides which edition is *asked*, and an
 * answer still has to be an article near the point, so a wrong guess costs one
 * upstream request and never a wrong card. Boxes may overlap; the smallest one
 * containing the point wins, which is why the multilingual countries are split
 * into rough language regions (Romandy, Ticino, Flanders, Catalonia) and why
 * the continent-sized entries only take effect where nothing smaller matches.
 */
const LANGUAGE_BOXES: readonly LanguageBox[] = [
  // Nordics — Atlas's home ground, and the case this exists for: most places
  // in Norway are described in Norwegian and in no other language at all.
  [4.0, 57.8, 31.6, 71.4, 'no', 'nn'], // Norway
  [10.0, 74.0, 35.0, 81.0, 'no'], // Svalbard
  [10.9, 55.2, 24.2, 69.1, 'sv'], // Sweden
  [19.0, 59.7, 31.6, 70.1, 'fi', 'sv'], // Finland
  [8.0, 54.5, 12.9, 57.8, 'da'], // Denmark
  [14.6, 54.9, 15.3, 55.4, 'da'], // Bornholm
  [-24.6, 63.2, -13.4, 66.6, 'is'], // Iceland
  [-7.8, 61.3, -6.2, 62.5, 'fo'], // Faroe Islands
  [-73.0, 59.0, -11.0, 84.0, 'da', 'kl'], // Greenland

  // Western Europe
  [5.8, 47.2, 15.1, 55.1, 'de'], // Germany
  [9.5, 46.3, 17.2, 49.1, 'de'], // Austria
  [7.4, 45.8, 10.6, 47.9, 'de'], // Switzerland (German-speaking)
  [5.9, 45.8, 7.5, 47.0, 'fr'], // Switzerland (Romandy)
  [8.3, 45.8, 9.3, 46.6, 'it'], // Switzerland (Ticino)
  [-5.2, 41.3, 9.7, 51.2, 'fr'], // France
  [3.3, 50.7, 7.3, 53.6, 'nl'], // Netherlands
  [2.5, 50.65, 6.4, 51.6, 'nl', 'fr'], // Belgium (Flanders, Brussels)
  [2.8, 49.4, 6.5, 50.65, 'fr'], // Belgium (Wallonia)
  [5.7, 49.4, 6.6, 50.2, 'lb', 'fr', 'de'], // Luxembourg
  [-9.4, 35.9, 3.4, 43.8, 'es'], // Spain
  [0.15, 40.5, 3.4, 42.9, 'ca', 'es'], // Catalonia
  [-9.4, 41.8, -6.7, 43.8, 'gl', 'es'], // Galicia
  [-9.6, 36.9, -6.1, 42.2, 'pt'], // Portugal
  [6.6, 35.4, 18.6, 47.1, 'it'], // Italy

  // Central, eastern and southern Europe
  [14.1, 49.0, 24.2, 55.0, 'pl'], // Poland
  [12.0, 48.5, 18.9, 51.1, 'cs'], // Czechia
  [16.8, 47.7, 22.6, 49.7, 'sk'], // Slovakia
  [16.1, 45.7, 22.9, 48.6, 'hu'], // Hungary
  [20.2, 43.6, 29.7, 48.3, 'ro'], // Romania
  [22.3, 41.2, 28.7, 44.3, 'bg'], // Bulgaria
  [21.7, 57.5, 28.3, 59.8, 'et'], // Estonia
  [20.9, 55.6, 28.3, 58.1, 'lv'], // Latvia
  [20.9, 53.8, 26.9, 56.5, 'lt'], // Lithuania
  [22.1, 44.3, 40.3, 52.4, 'uk'], // Ukraine
  [23.1, 51.2, 32.8, 56.2, 'be', 'ru'], // Belarus
  [13.3, 45.4, 16.7, 46.9, 'sl'], // Slovenia
  [13.4, 42.3, 19.5, 46.6, 'hr'], // Croatia
  [18.8, 42.2, 23.1, 46.2, 'sr'], // Serbia
  [19.3, 34.7, 28.3, 41.8, 'el'], // Greece
  [25.6, 35.8, 44.9, 42.2, 'tr'], // Turkey
  [19.6, 41.1, 180.0, 82.0, 'ru'], // Russia

  // The largest editions elsewhere
  [122.9, 24.0, 153.9, 45.6, 'ja'], // Japan
  [125.9, 33.0, 129.7, 38.7, 'ko'], // South Korea
  [119.9, 21.8, 122.1, 25.4, 'zh'], // Taiwan
  [73.5, 18.1, 135.1, 53.6, 'zh'], // China
  [95.0, -11.1, 141.1, 6.1, 'id'], // Indonesia
  [97.3, 5.6, 105.7, 20.5, 'th'], // Thailand
  [102.1, 8.2, 109.5, 23.4, 'vi'], // Vietnam
  [68.1, 6.7, 97.4, 35.6, 'hi'], // India
  [34.2, 29.4, 35.9, 33.4, 'he'], // Israel
  [44.0, 25.0, 63.4, 39.8, 'fa'], // Iran
  [-17.1, 12.0, 60.0, 37.5, 'ar'], // Arabic-speaking north Africa and Levant
  [-74.0, -33.8, -34.8, 5.3, 'pt'], // Brazil
  [-118.5, -56.0, -34.0, 32.6, 'es'], // Spanish-speaking Americas
];

/** Wikivoyage exists in far fewer languages than Wikipedia. */
const WIKIVOYAGE_LANGUAGES = new Set([
  'en',
  'de',
  'fr',
  'it',
  'nl',
  'pl',
  'pt',
  'ru',
  'es',
  'sv',
  'he',
  'fa',
  'zh',
  'vi',
  'el',
  'uk',
  'hi',
  'bn',
  'eo',
  'fi',
  'ro',
  'ja',
  'tr',
  'id',
]);

/** True when `<language>.wikivoyage.org` is a real wiki worth asking. */
export function hasWikivoyage(language: string): boolean {
  return WIKIVOYAGE_LANGUAGES.has(language);
}

/** A Wikipedia language code from a device or browser locale ("nb-NO" → "no"). */
export function wikiLanguage(locale: string | undefined): string {
  const language = locale?.split(/[-_]/)[0]?.toLowerCase();
  // Bokmål is written `nb` by Android and `no` by Wikipedia; Nynorsk (`nn`)
  // really is its own edition and keeps its code.
  if (language === 'nb') return 'no';
  return language && /^[a-z]{2,3}$/.test(language) ? language : 'en';
}

/** The languages spoken where the point is, most local first ([] if unknown). */
export function localWikiLanguages(at: LatLng): string[] {
  let best: LanguageBox | null = null;
  for (const box of LANGUAGE_BOXES) {
    const [west, south, east, north] = box;
    if (at.lng < west || at.lng > east || at.lat < south || at.lat > north) continue;
    if (!best || (east - west) * (north - south) < (best[2] - best[0]) * (best[3] - best[1])) {
      best = box;
    }
  }
  return best ? best.slice(4).map(String) : [];
}

/**
 * The Wikipedia editions to ask about a place, best first.
 *
 * The reader's own language leads — an article they cannot read is barely an
 * article. Then the *local* language, which in Norway is the whole ballgame:
 * a coastal hamlet, a listed farm or a mountain hut is described on `no` and
 * nowhere else, so an English-only lookup reports "nothing here" while standing
 * between three articles. English sits third as the language of last resort
 * (and second whenever the reader is local), ahead of any remaining regional
 * editions.
 */
export function wikiLanguageChain(locale: string | undefined, at: LatLng, limit = 3): string[] {
  const [local, ...rest] = localWikiLanguages(at);
  const chain: string[] = [];
  for (const language of [wikiLanguage(locale), local, 'en', ...rest]) {
    if (language && !chain.includes(language)) chain.push(language);
  }
  return chain.slice(0, limit);
}
