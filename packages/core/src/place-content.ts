import { haversineM, type LatLng } from './geo.js';

/** A short, attributed article attached to a place card. */
export interface PlaceContent {
  source: 'wikipedia' | 'wikivoyage';
  title: string;
  extract: string;
  url: string;
  language: string;
  /** True when the article came from a downloaded Android region pack. */
  offline?: boolean;
}

/** The part of a MediaWiki query page used by Atlas's content proxy. */
export interface MediaWikiPlacePage {
  title?: string;
  extract?: string;
  fullurl?: string;
  coordinates?: { lat?: number; lon?: number; primary?: string }[];
}

function normaliseName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Pick the page that most plausibly describes the selected POI.
 *
 * Nearby-page APIs can return a church, district, station and monument in the
 * same few hundred metres. An exact/contained title wins; otherwise a page is
 * accepted only when it is very close to the selected point. That keeps a
 * dropped pin beside a landmark from claiming the landmark's article.
 */
export function bestMediaWikiPlacePage(
  placeName: string,
  at: LatLng,
  pages: readonly MediaWikiPlacePage[],
): MediaWikiPlacePage | null {
  const wanted = normaliseName(placeName);
  // Bare coordinate pins are place-card titles too, but never article names.
  if (!wanted || !/\p{L}/u.test(wanted)) return null;
  const wantedTokens = new Set(wanted.split(' '));
  let best: { page: MediaWikiPlacePage; score: number } | null = null;

  for (const page of pages) {
    if (!page.title?.trim() || !page.extract?.trim() || !page.fullurl) continue;
    const title = normaliseName(page.title);
    const coordinate = page.coordinates?.[0];
    const distanceM =
      typeof coordinate?.lat === 'number' && typeof coordinate.lon === 'number'
        ? haversineM(at, { lat: coordinate.lat, lng: coordinate.lon })
        : Number.POSITIVE_INFINITY;
    const titleTokens = new Set(title.split(' '));
    let overlap = 0;
    for (const token of wantedTokens) if (titleTokens.has(token)) overlap++;
    const similarity = overlap / Math.max(wantedTokens.size, titleTokens.size, 1);
    const exact = title === wanted;
    const contains = title.includes(wanted) || wanted.includes(title);

    // A fuzzy title is useful only at the POI itself. Exact names can tolerate
    // a larger coordinate mismatch because large features often pin their
    // Wikipedia coordinate at an entrance or centroid.
    if (!exact && !contains && (similarity < 0.5 || distanceM > 90)) continue;
    if (!exact && distanceM > 1_500) continue;

    const score =
      (exact ? 10_000 : contains ? 6_000 : similarity * 3_000) - Math.min(distanceM, 5_000);
    if (!best || score > best.score) best = { page, score };
  }
  return best?.page ?? null;
}
