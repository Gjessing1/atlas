import type { Page } from '@playwright/test';
import type maplibregl from 'maplibre-gl';

/** MapView exposes the live map for tests as window.__atlasMap. */
declare global {
  interface Window {
    __atlasMap?: maplibregl.Map;
  }
}

/** Wait until the map exists and has finished its initial render. */
export async function waitForMap(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__atlasMap), undefined, { timeout: 30_000 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = window.__atlasMap!;
        if (map.loaded()) resolve();
        else map.once('idle', () => resolve());
      }),
  );
}

/** Screen pixel of a lat/lng through the live map's projection. */
export async function project(page: Page, lat: number, lng: number): Promise<[number, number]> {
  return page.evaluate(
    ([la, ln]) => {
      const p = window.__atlasMap!.project({ lat: la!, lng: ln! });
      return [p.x, p.y] as [number, number];
    },
    [lat, lng],
  );
}

/** The map's current { lat, lng, zoom } for camera assertions. */
export async function cameraState(page: Page): Promise<{ lat: number; lng: number; zoom: number }> {
  return page.evaluate(() => {
    const map = window.__atlasMap!;
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
  });
}

/**
 * Stub the Photon search proxy with one fixed result, so the suite never
 * depends on a running search index.
 */
export async function mockSearch(page: Page): Promise<void> {
  await page.route('**/api/search**', (route) =>
    route.fulfill({
      json: {
        results: [
          {
            name: 'Preikestolen',
            label: 'Strand, Rogaland, Norway',
            position: { lat: 58.9864, lng: 6.1904 },
            kind: 'tourism/attraction',
          },
        ],
      },
    }),
  );
}

/** Polyline6 encoder (inverse of @atlas/routing's decodeShape) for fixtures. */
export function encodeShape(coords: [number, number][], precision = 6): string {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  const enc = (delta: number): string => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    let s = '';
    while (value >= 0x20) {
      s += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    return s + String.fromCharCode(value + 63);
  };
  for (const [lat, lng] of coords) {
    const iLat = Math.round(lat * factor);
    const iLng = Math.round(lng * factor);
    out += enc(iLat - prevLat) + enc(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

/**
 * Stub the Valhalla routing proxy: answers every /api/route POST with a
 * straight-line trip through the requested locations, so route-planning UI
 * can be exercised without the routing engine.
 */
export async function mockRouting(page: Page): Promise<void> {
  // Route enrichment (speed limits) — a separate endpoint, so it needs its own
  // mock or it would fall through to whatever Valhalla the host happens to run.
  // One edge spanning the whole shape, so the limit holds for the entire drive.
  await page.route('**/api/route/attributes', (route) => {
    const body = route.request().postDataJSON() as { shape?: unknown[] };
    const shape = body.shape ?? [];
    if (shape.length < 2) {
      return route.fulfill({ status: 400, json: { message: 'need a shape' } });
    }
    return route.fulfill({
      json: {
        edges: [
          {
            begin_shape_index: 0,
            end_shape_index: shape.length - 1,
            speed_limit: 60,
            road_class: 'primary',
          },
        ],
      },
    });
  });
  await page.route('**/api/route', (route) => {
    const body = route.request().postDataJSON() as {
      locations?: { lat: number; lon: number }[];
    };
    const locs = body.locations ?? [];
    if (locs.length < 2) {
      return route.fulfill({ status: 400, json: { message: 'need two locations' } });
    }
    const coords = locs.map((l) => [l.lat, l.lon] as [number, number]);
    const lats = coords.map((c) => c[0]);
    const lngs = coords.map((c) => c[1]);
    return route.fulfill({
      json: {
        trip: {
          units: 'kilometers',
          legs: [{ shape: encodeShape(coords) }],
          summary: {
            length: 12.3,
            time: 900,
            min_lat: Math.min(...lats),
            min_lon: Math.min(...lngs),
            max_lat: Math.max(...lats),
            max_lon: Math.max(...lngs),
          },
        },
      },
    });
  });
}

/**
 * Place card → turn-by-turn, the way a user gets there since the card stopped
 * choosing a travel mode: "Directions" hands the point to the route planner
 * (the app's one mode picker, transit included) and guidance starts from the
 * planner's own button.
 */
export async function startNavigationFromCard(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Directions' }).click();
  await page.getByRole('button', { name: 'Start navigation' }).click();
}
