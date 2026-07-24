import {
  bestMediaWikiPlacePage,
  mediaWikiThumbnail,
  type MediaWikiPlacePage,
  type PlaceContent,
} from '@atlas/core';
import type { FastifyInstance } from 'fastify';

export interface PlaceContentApiOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface MediaWikiResponse {
  query?: { pages?: MediaWikiPlacePage[] | Record<string, MediaWikiPlacePage> };
}

const DEFAULT_USER_AGENT =
  'Atlas place content (self-hosted; https://git.gjessing.io/gjessing1/atlas)';

function safeLanguage(value: string | undefined): string {
  const language = value?.split(/[-_]/)[0]?.toLowerCase();
  if (language === 'nb') return 'no';
  return language && /^[a-z]{2,3}$/.test(language) ? language : 'en';
}

function pagesOf(response: MediaWikiResponse): MediaWikiPlacePage[] {
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
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

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
    const language = safeLanguage(request.query.lang);
    const at = { lat, lng: lon };
    reply.header('Cache-Control', 'public, max-age=86400');

    const loadLanguage = async (
      source: PlaceContent['source'],
      project: 'wikipedia' | 'wikivoyage',
      contentLanguage: string,
    ): Promise<PlaceContent | null> => {
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
        const page = bestMediaWikiPlacePage(
          name,
          at,
          pagesOf((await response.json()) as MediaWikiResponse),
        );
        if (!page?.title || !page.extract || !page.fullurl) return null;
        return {
          source,
          title: page.title,
          extract: page.extract,
          url: page.fullurl,
          language: contentLanguage,
          image: mediaWikiThumbnail(page),
        };
      } catch {
        return null;
      }
    };

    const load = async (
      source: PlaceContent['source'],
      project: 'wikipedia' | 'wikivoyage',
    ): Promise<PlaceContent | null> =>
      (await loadLanguage(source, project, language)) ??
      (language === 'en' ? null : await loadLanguage(source, project, 'en'));

    const content = (
      await Promise.all([load('wikipedia', 'wikipedia'), load('wikivoyage', 'wikivoyage')])
    ).filter((item): item is PlaceContent => item !== null);
    return { content };
  });
}
