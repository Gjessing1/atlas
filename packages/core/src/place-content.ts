import { haversineM, type LatLng } from './geo.js';

/**
 * The article's lead image, when the proxy found one online.
 *
 * Absent for offline pack articles: region packs carry text only (photos would
 * multiply their size for something the reader can live without), so the card
 * must render fine either way.
 */
export interface PlaceContentImage {
  url: string;
  width: number;
  height: number;
}

/** A short, attributed article attached to a place card. */
export interface PlaceContent {
  source: 'wikipedia' | 'wikivoyage';
  title: string;
  extract: string;
  url: string;
  language: string;
  /** Lead image of the article, sized for a card. Online lookups only. */
  image?: PlaceContentImage;
  /** True when the article came from a downloaded Android region pack. */
  offline?: boolean;
}

/** The part of a MediaWiki query page used by Atlas's content proxy. */
export interface MediaWikiPlacePage {
  title?: string;
  extract?: string;
  fullurl?: string;
  coordinates?: { lat?: number; lon?: number; primary?: string }[];
  /** `prop=pageimages` lead thumbnail, at the size the proxy asked for. */
  thumbnail?: { source?: string; width?: number; height?: number };
}

/**
 * A described place near the selected point: an article that exists *around
 * here*, rather than one matched to a name.
 *
 * This is the answer to "what is worth knowing about nearby?" — the question a
 * name lookup cannot answer at all, because most POIs are not the subject of an
 * article while standing a few hundred metres from three places that are.
 */
export interface NearbyPlaceArticle {
  title: string;
  /** A sentence or two — enough to decide whether to open it. */
  extract: string;
  url: string;
  language: string;
  /** The article's own coordinate, so the card can be re-aimed at it. */
  position: LatLng;
  distanceM: number;
  /** Row thumbnail; absent for offline pack articles and image-less pages. */
  image?: PlaceContentImage;
  /** True when the row came from a downloaded region pack. */
  offline?: boolean;
}

/** The part of a Commons `File:` page Atlas reads for the nearby-photo strip. */
export interface MediaWikiImagePage {
  title?: string;
  coordinates?: { lat?: number; lon?: number }[];
  imageinfo?: {
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: unknown } | undefined>;
  }[];
}

/**
 * A geotagged Wikimedia Commons photo taken near the selected point.
 *
 * Deliberately *not* presented as a photo of the place: most places have no
 * article and therefore no lead image, but somebody has usually photographed
 * the street corner. The strip is labelled as nearby photos so a picture of the
 * station across the road is useful context rather than a wrong caption.
 */
export interface PlacePhoto {
  /** Commons file title, minus the `File:` prefix — the strip's alt text. */
  title: string;
  /** Thumbnail URL at the width the proxy asked for. */
  url: string;
  width: number;
  height: number;
  /** Commons file page, where the full licence and author live. */
  pageUrl: string;
  distanceM: number | null;
  /** Author/licence one-liner when Commons supplied one. */
  credit?: string;
}

/** A page's lead thumbnail, dropped unless it is complete and https. */
export function mediaWikiThumbnail(page: MediaWikiPlacePage): PlaceContentImage | undefined {
  const { source, width, height } = page.thumbnail ?? {};
  if (!source?.startsWith('https://') || !width || !height) return undefined;
  return { url: source, width, height };
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

/**
 * Rank the geosearch answer into a nearby-articles list.
 *
 * Pages without an extract or a coordinate are dropped rather than shown as
 * empty rows, and everything is ordered by distance: "what is near me" is a
 * distance question, and MediaWiki's own ordering is not guaranteed to survive
 * a generator query.
 */
export function nearbyMediaWikiPlaces(
  at: LatLng,
  pages: readonly MediaWikiPlacePage[],
  limit = 12,
): NearbyPlaceArticle[] {
  const places: NearbyPlaceArticle[] = [];
  for (const page of pages) {
    const coordinate = page.coordinates?.[0];
    if (!page.title?.trim() || !page.extract?.trim() || !page.fullurl) continue;
    if (typeof coordinate?.lat !== 'number' || typeof coordinate.lon !== 'number') continue;
    const position = { lat: coordinate.lat, lng: coordinate.lon };
    const image = mediaWikiThumbnail(page);
    places.push({
      title: page.title,
      extract: page.extract,
      url: page.fullurl,
      language: '',
      position,
      distanceM: Math.round(haversineM(at, position)),
      ...(image ? { image } : {}),
    });
  }
  return places.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
}

/** Plain-text value of a Commons extmetadata field, HTML tags stripped. */
function metadataText(field: { value?: unknown } | undefined): string | undefined {
  const raw = field?.value;
  if (typeof raw !== 'string') return undefined;
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text.slice(0, 120) : undefined;
}

/**
 * Commons `File:` pages as a photo strip: thumbnail, file page and a short
 * credit. Files without a usable https thumbnail are dropped — a broken tile in
 * a photo row is worse than a shorter row.
 */
export function commonsPlacePhotos(
  at: LatLng,
  pages: readonly MediaWikiImagePage[],
  limit = 8,
): PlacePhoto[] {
  const photos: PlacePhoto[] = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const url = info.thumburl;
    if (!url?.startsWith('https://') || !info.thumbwidth || !info.thumbheight) continue;
    const coordinate = page.coordinates?.[0];
    const distanceM =
      typeof coordinate?.lat === 'number' && typeof coordinate.lon === 'number'
        ? Math.round(haversineM(at, { lat: coordinate.lat, lng: coordinate.lon }))
        : null;
    const credit =
      metadataText(info.extmetadata?.['Artist']) ?? metadataText(info.extmetadata?.['Credit']);
    const licence = metadataText(info.extmetadata?.['LicenseShortName']);
    photos.push({
      title: (page.title ?? '').replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, ''),
      url,
      width: info.thumbwidth,
      height: info.thumbheight,
      pageUrl: info.descriptionurl ?? url,
      distanceM,
      ...(credit || licence
        ? { credit: [credit, licence].filter((part) => part).join(' · ') }
        : {}),
    });
  }
  // Nearest first where Commons gave a coordinate; the rest keep their order.
  return photos
    .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity))
    .slice(0, limit);
}
