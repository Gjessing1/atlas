import {
  bestMediaWikiPlaceMatch,
  commonsPlacePhotos,
  hasWikivoyage,
  mediaWikiThumbnail,
  mergeNearbyMediaWikiPlaces,
  wikiLanguageChain,
  WIKIMEDIA_USER_AGENT,
  type MediaWikiImagePage,
  type MediaWikiPlacePage,
  type PlaceContent,
  type PlaceMatchStrength,
} from '@atlas/core';
import type { FastifyInstance } from 'fastify';

export interface PlaceContentApiOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface MediaWikiResponse {
  query?: { pages?: MediaWikiPlacePage[] | Record<string, MediaWikiPlacePage> };
}

interface MediaWikiImageResponse {
  query?: { pages?: MediaWikiImagePage[] | Record<string, MediaWikiImagePage> };
}

/** Coordinates a request has to carry, or 400. */
function coordinateOf(query: { lat?: string; lon?: string }): { lat: number; lon: number } | null {
  const lat = Number(query.lat);
  const lon = Number(query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Bounded radius (m) for the nearby lookups; Wikimedia's own ceiling is 10 km. */
function safeRadius(value: string | undefined, fallback: number): number {
  const radius = Number(value);
  return Number.isFinite(radius) ? Math.min(10_000, Math.max(100, radius)) : fallback;
}

function pagesOf(response: MediaWikiResponse): MediaWikiPlacePage[] {
  const pages = response.query?.pages;
  if (!pages) return [];
  return Array.isArray(pages) ? pages : Object.values(pages);
}

function imagePagesOf(response: MediaWikiImageResponse): MediaWikiImagePage[] {
  const pages = response.query?.pages;
  if (!pages) return [];
  return Array.isArray(pages) ? pages : Object.values(pages);
}

/** Wikipedia/Wikivoyage summaries for the shared place-card content model. */
export function registerPlaceContentApi(
  app: FastifyInstance,
  options: PlaceContentApiOptions = {},
): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? WIKIMEDIA_USER_AGENT;

  app.get<{
    Querystring: { name?: string; lat?: string; lon?: string; lang?: string };
  }>('/api/place-content', async (request, reply) => {
    const name = request.query.name?.trim();
    const lat = Number(request.query.lat);
    const lon = Number(request.query.lon);
    if (
      !name ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      return reply.code(400).send({ error: 'name, lat and lon are required' });
    }
    const at = { lat, lng: lon };
    const languages = wikiLanguageChain(request.query.lang, at);
    reply.header('Cache-Control', 'public, max-age=86400');

    /** A candidate article plus how well its title answered the place's name. */
    interface Candidate {
      content: PlaceContent;
      strength: PlaceMatchStrength;
    }

    const loadLanguage = async (
      source: PlaceContent['source'],
      project: 'wikipedia' | 'wikivoyage',
      contentLanguage: string,
    ): Promise<Candidate | null> => {
      const url = new URL(`https://${contentLanguage}.${project}.org/w/api.php`);
      for (const [key, value] of Object.entries({
        action: 'query',
        format: 'json',
        formatversion: '2',
        generator: 'geosearch',
        ggscoord: `${lat}|${lon}`,
        ggsradius: '5000',
        ggslimit: '12',
        prop: 'coordinates|extracts|info|pageimages',
        exintro: '1',
        explaintext: '1',
        exchars: '700',
        inprop: 'url',
        // The article's lead photo, in one round trip with the text. 640 px
        // covers a retina card without pulling the full-resolution original,
        // and pageimages' default `pilicense=free` keeps it to freely licensed
        // media — Wikimedia serves these straight to the client, so nothing
        // here has to be proxied.
        piprop: 'thumbnail',
        pithumbsize: '640',
      })) {
        url.searchParams.set(key, value);
      }
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': userAgent, 'Api-User-Agent': userAgent },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return null;
        const match = bestMediaWikiPlaceMatch(
          name,
          at,
          pagesOf((await response.json()) as MediaWikiResponse),
        );
        const page = match?.page;
        if (!match || !page?.title || !page.extract || !page.fullurl) return null;
        return {
          strength: match.strength,
          content: {
            source,
            title: page.title,
            extract: page.extract,
            url: page.fullurl,
            language: contentLanguage,
            image: mediaWikiThumbnail(page),
          },
        };
      } catch {
        return null;
      }
    };

    /**
     * The reader's language, then the local one, then English (see
     * `wikiLanguageChain`). Sequential: an edition that has the article usually
     * answers on the first or second try, and asking all of them in parallel
     * would triple the load on Wikimedia to discard most of it.
     *
     * An article actually *named* after the place ends the walk. A merely
     * broader one does not: a pin on "Asker rådhus" matches the article "Asker"
     * in every big edition, and stopping there would hand a reader the
     * municipality while the Norwegian article about the town hall itself sat
     * one request away. The broad hit is kept as a fallback — first one wins, so
     * it stays in the reader's own language — and used only if no edition names
     * the place.
     */
    const load = async (
      source: PlaceContent['source'],
      project: 'wikipedia' | 'wikivoyage',
    ): Promise<PlaceContent | null> => {
      let fallback: PlaceContent | null = null;
      for (const contentLanguage of languages) {
        if (project === 'wikivoyage' && !hasWikivoyage(contentLanguage)) continue;
        const found = await loadLanguage(source, project, contentLanguage);
        if (found?.strength === 'named') return found.content;
        if (found && !fallback) fallback = found.content;
      }
      return fallback;
    };

    const content = (
      await Promise.all([load('wikipedia', 'wikipedia'), load('wikivoyage', 'wikivoyage')])
    ).filter((item): item is PlaceContent => item !== null);
    return { content };
  });

  /**
   * Described places *around* a point, whether or not anything is named like
   * the selected POI. The card's own lookup can only answer "is this thing
   * itself an article?", which for most POIs is no — while three articles sit
   * within a few hundred metres. This is that list.
   */
  app.get<{
    Querystring: { lat?: string; lon?: string; lang?: string; radius?: string; limit?: string };
  }>('/api/place-content/nearby', async (request, reply) => {
    const at = coordinateOf(request.query);
    if (!at) return reply.code(400).send({ error: 'lat and lon are required' });
    const here = { lat: at.lat, lng: at.lon };
    const radiusM = safeRadius(request.query.radius, 2_000);
    const limit = Math.min(20, Math.max(1, Number(request.query.limit) || 12));
    reply.header('Cache-Control', 'public, max-age=86400');

    const loadLanguage = async (contentLanguage: string, counterpart: string | undefined) => {
      const url = new URL(`https://${contentLanguage}.wikipedia.org/w/api.php`);
      for (const [key, value] of Object.entries({
        action: 'query',
        format: 'json',
        formatversion: '2',
        generator: 'geosearch',
        ggscoord: `${at.lat}|${at.lon}`,
        ggsradius: String(Math.round(radiusM)),
        // Ask for more than we show: pages without an extract or coordinate are
        // dropped, and the list should still be full after that.
        ggslimit: String(Math.min(50, limit * 2)),
        prop: `coordinates|extracts|info|pageimages${counterpart ? '|langlinks' : ''}`,
        exintro: '1',
        explaintext: '1',
        // A row, not an article: two sentences is enough to choose from.
        exchars: '220',
        inprop: 'url',
        piprop: 'thumbnail',
        pithumbsize: '160',
        // What this edition calls a page that the leading edition may already
        // have listed — the merge drops the duplicate on the strength of it.
        ...(counterpart ? { lllang: counterpart } : {}),
      })) {
        url.searchParams.set(key, value);
      }
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': userAgent, 'Api-User-Agent': userAgent },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return { language: contentLanguage, pages: [] };
        return {
          language: contentLanguage,
          pages: pagesOf((await response.json()) as MediaWikiResponse),
        };
      } catch {
        return { language: contentLanguage, pages: [] };
      }
    };

    // Both editions are asked, not one after the other: outside the
    // English-speaking world the local Wikipedia is where the places actually
    // are, and a list drawn from both is close to twice as long as either.
    const languages = wikiLanguageChain(request.query.lang, here, 2);
    const groups = await Promise.all(
      languages.map((contentLanguage, index) =>
        loadLanguage(contentLanguage, index === 0 ? undefined : languages[0]),
      ),
    );
    return { places: mergeNearbyMediaWikiPlaces(here, groups, limit) };
  });

  /**
   * Geotagged Commons photos near a point — what a place *looks* like when it
   * has no article of its own (the common case, and the reason a town hall
   * showed nothing at all). Presented as nearby photos, never as the place's
   * own picture: the nearest photo may well be of the building across the road.
   */
  app.get<{
    Querystring: { lat?: string; lon?: string; radius?: string; limit?: string };
  }>('/api/place-photos', async (request, reply) => {
    const at = coordinateOf(request.query);
    if (!at) return reply.code(400).send({ error: 'lat and lon are required' });
    const radiusM = safeRadius(request.query.radius, 400);
    const limit = Math.min(12, Math.max(1, Number(request.query.limit) || 8));
    reply.header('Cache-Control', 'public, max-age=86400');

    const url = new URL('https://commons.wikimedia.org/w/api.php');
    for (const [key, value] of Object.entries({
      action: 'query',
      format: 'json',
      formatversion: '2',
      generator: 'geosearch',
      // Namespace 6 is File: — the photos themselves, not the pages using them.
      ggsnamespace: '6',
      ggscoord: `${at.lat}|${at.lon}`,
      ggsradius: String(Math.round(radiusM)),
      ggslimit: String(Math.min(30, limit * 3)),
      prop: 'coordinates|imageinfo',
      iiprop: 'url|extmetadata',
      // Commons renders the thumbnail for us; the originals are often 10 MB+.
      iiurlwidth: '480',
      iiextmetadatafilter: 'Artist|Credit|LicenseShortName',
    })) {
      url.searchParams.set(key, value);
    }
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': userAgent, 'Api-User-Agent': userAgent },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { photos: [] };
      return {
        photos: commonsPlacePhotos(
          { lat: at.lat, lng: at.lon },
          imagePagesOf((await response.json()) as MediaWikiImageResponse),
          limit,
        ),
      };
    } catch {
      // Commons unreachable: a card without photos, not a card with an error.
      return { photos: [] };
    }
  });
}
