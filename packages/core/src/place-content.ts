import { haversineM, type LatLng } from './geo.js';

/**
 * Who Atlas says it is to Wikimedia — required, not decorative.
 *
 * `upload.wikimedia.org` answers 403 to requests with a generic or missing
 * User-Agent, which is exactly what a stock HTTP client sends: React Native's
 * image loader identifies itself as `okhttp/…`, so every Wikipedia thumbnail on
 * Android came back rejected and rendered as an empty (black) tile. Anything
 * that fetches Wikimedia — the backend proxy and the app's own `<Image>` tags —
 * sends this instead.
 */
export const WIKIMEDIA_USER_AGENT =
  'Atlas place content (self-hosted; https://git.gjessing.io/gjessing1/atlas)';

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
  /** The same subject's title in another edition (`prop=langlinks&lllang=…`). */
  langlinks?: { lang?: string; title?: string }[];
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

/** Whole-word containment: "asker" is inside "asker radhus", "ker" is not. */
function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * How well a page answers the name that was asked about.
 *
 * `named` — the article is about this place (same title, or a longer one that
 * spells the whole name out: "Preikestolen (fjell)"). `broader` — it is about
 * something the place merely belongs to, or a fuzzy neighbour: the article
 * "Asker" for a pin on *Asker rådhus* is the municipality, not the town hall.
 * Both are worth showing; only the first is worth stopping the search for.
 */
export type PlaceMatchStrength = 'named' | 'broader';

/** The chosen page and how confidently it was chosen. */
export interface MediaWikiPlaceMatch {
  page: MediaWikiPlacePage;
  strength: PlaceMatchStrength;
}

/**
 * Pick the page that most plausibly describes the selected POI.
 *
 * Nearby-page APIs can return a church, district, station and monument in the
 * same few hundred metres. A title that spells out the place's name wins;
 * otherwise a page is accepted only when it is very close to the selected
 * point, or when it names something the place is part of. That keeps a dropped
 * pin beside a landmark from claiming the landmark's article.
 *
 * The caller is told *which* of those it got, because the two deserve different
 * treatment when several Wikipedia editions are being asked in turn: an article
 * actually named after the place ends the search, while a broader one is only
 * a fallback worth keeping if no edition does better.
 */
export function bestMediaWikiPlaceMatch(
  placeName: string,
  at: LatLng,
  pages: readonly MediaWikiPlacePage[],
): MediaWikiPlaceMatch | null {
  const wanted = normaliseName(placeName);
  // Bare coordinate pins are place-card titles too, but never article names.
  if (!wanted || !/\p{L}/u.test(wanted)) return null;
  const wantedTokens = new Set(wanted.split(' '));
  let best: (MediaWikiPlaceMatch & { score: number }) | null = null;

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
    // Spells the name out (the article is at least as specific as the pin) …
    const covers = !exact && containsWords(title, wanted);
    // … or names something larger the pin sits inside.
    const inside = !exact && !covers && containsWords(wanted, title);

    // A fuzzy title is useful only at the POI itself. Exact names can tolerate
    // a larger coordinate mismatch because large features often pin their
    // Wikipedia coordinate at an entrance or centroid.
    if (!exact && !covers && !inside && (similarity < 0.5 || distanceM > 90)) continue;
    if (!exact && distanceM > 1_500) continue;

    const score =
      (exact ? 10_000 : covers ? 6_000 : inside ? 4_000 : similarity * 3_000) -
      Math.min(distanceM, 5_000);
    if (best && score <= best.score) continue;
    best = { page, strength: exact || covers ? 'named' : 'broader', score };
  }
  return best ? { page: best.page, strength: best.strength } : null;
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
    const place = nearbyPlaceOf(at, page);
    if (place) places.push(place);
  }
  return places.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
}

/** One geosearch page as a row, or null when there is nothing to show. */
function nearbyPlaceOf(at: LatLng, page: MediaWikiPlacePage): NearbyPlaceArticle | null {
  const coordinate = page.coordinates?.[0];
  if (!page.title?.trim() || !page.extract?.trim() || !page.fullurl) return null;
  if (typeof coordinate?.lat !== 'number' || typeof coordinate.lon !== 'number') return null;
  const position = { lat: coordinate.lat, lng: coordinate.lon };
  const image = mediaWikiThumbnail(page);
  return {
    title: page.title,
    extract: page.extract,
    url: page.fullurl,
    language: '',
    position,
    distanceM: Math.round(haversineM(at, position)),
    ...(image ? { image } : {}),
  };
}

/** A geosearch answer from one Wikipedia edition. */
export interface NearbyPlaceGroup {
  language: string;
  pages: readonly MediaWikiPlacePage[];
}

/**
 * One nearby list out of several language editions, best edition first.
 *
 * Norway is why this exists: ask English Wikipedia what is around a fjord-side
 * village and it knows almost nothing, while the Norwegian edition describes
 * the church, the farm and the ferry quay. Asking both roughly doubles what a
 * card can show — as long as the same subject does not appear twice under two
 * names, which is what the `langlinks` counterpart title in each page is for:
 * "Oslo domkirke" is recognised as the article already listed as "Oslo
 * Cathedral" and dropped, without a second round trip to find that out.
 */
export function mergeNearbyMediaWikiPlaces(
  at: LatLng,
  groups: readonly NearbyPlaceGroup[],
  limit = 12,
): NearbyPlaceArticle[] {
  const covered = new Set<string>();
  const places: NearbyPlaceArticle[] = [];
  for (const group of groups) {
    for (const page of group.pages) {
      const place = nearbyPlaceOf(at, page);
      if (!place) continue;
      const names = [page.title, ...(page.langlinks ?? []).map((link) => link.title)]
        .map((title) => (title ? normaliseName(title) : ''))
        .filter((title) => title.length > 0);
      if (names.some((name) => covered.has(name))) continue;
      for (const name of names) covered.add(name);
      places.push({ ...place, language: group.language });
    }
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
