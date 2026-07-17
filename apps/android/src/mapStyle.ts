import { resolveStyleTemplate } from '@atlas/core';
import * as FileSystem from 'expo-file-system/legacy';

import { getServerOrigin } from './serverOrigin';

// Self-hosted style template written by infrastructure/tiles/fetch-map-assets.sh,
// served by the backend; same template the web app uses (see apps/web MapView).
const STYLE_TEMPLATE_PATH = '/assets/styles/liberty.json';
// Public fallback so the map still renders without the self-hosted stack.
export const FALLBACK_STYLE_URL = 'https://demotiles.maplibre.org/style.json';

/** Local copy of the style template, kept for offline starts. */
const TEMPLATE_CACHE = `${FileSystem.documentDirectory}style-template.json`;

async function readCachedTemplate(): Promise<string | null> {
  try {
    return await FileSystem.readAsStringAsync(TEMPLATE_CACHE);
  } catch {
    return null;
  }
}

/**
 * Fetch the self-hosted style template (caching it for offline starts), or
 * fall back to the cached copy when the server is unreachable.
 */
export async function loadStyleTemplate(): Promise<string | null> {
  try {
    const res = await fetch(`${getServerOrigin()}${STYLE_TEMPLATE_PATH}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`style template: HTTP ${res.status}`);
    const template = await res.text();
    await FileSystem.writeAsStringAsync(TEMPLATE_CACHE, template).catch(() => undefined);
    return template;
  } catch {
    return readCachedTemplate();
  }
}

/** Online style: template with {origin} pointed at the Atlas server. */
export function buildOnlineStyle(template: string): string {
  return resolveStyleTemplate(template, getServerOrigin());
}

/**
 * Offline style: same template, but the vector source reads the downloaded
 * pack's PMTiles straight from disk (MapLibre Native has native PMTiles
 * support — `pmtiles://file://…` needs no local HTTP server), and glyphs +
 * sprites come from the pack's unzipped assets.
 */
export function buildOfflineStyle(template: string, packDir: string): string {
  // packDir is a file:// URI (expo-file-system documentDirectory-based).
  const dir = packDir.replace(/\/+$/, '');
  const style = JSON.parse(template) as {
    sources: Record<string, { type: string; url?: string; tiles?: string[] }>;
    glyphs?: string;
    sprite?: string;
  };
  for (const source of Object.values(style.sources)) {
    // The template's basemap source is either a z/x/y tiles array (the
    // backend's merged /api/tiles endpoint) or a pmtiles:// url (older
    // templates); offline, both become the pack's local PMTiles.
    if (source.type === 'vector' && (source.tiles || source.url?.startsWith('pmtiles://'))) {
      delete source.tiles;
      source.url = `pmtiles://${dir}/basemap.pmtiles`;
    }
  }
  // The pack's assets.zip unpacks to <dir>/assets/{fonts,sprites}, mirroring
  // the server's /assets layout so the template paths keep working.
  style.glyphs = `${dir}/assets/fonts/{fontstack}/{range}.pbf`;
  style.sprite = `${dir}/assets/sprites/ofm`;
  return JSON.stringify(style);
}
