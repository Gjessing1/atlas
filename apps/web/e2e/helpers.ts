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

/** Open route planning through the user-facing map-pin → Directions flow. */
export async function openRoutePlannerAt(page: Page, lat: number, lng: number): Promise<void> {
  const [x, y] = await project(page, lat, lng);
  await page.mouse.click(x, y, { button: 'right' });
  await page.getByRole('button', { name: 'Directions' }).click();
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
            address: 'Preikestolvegen 521, 4105 Jørpeland',
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
export async function mockRouting(
  page: Page,
  options: { alternatives?: boolean } = {},
): Promise<void> {
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
            surface: 'paved_smooth',
          },
        ],
      },
    });
  });
  await page.route('**/api/elevation/profile', (route) => {
    const body = route.request().postDataJSON() as { points?: unknown[] };
    const points = body.points ?? [];
    return route.fulfill({
      json: {
        samples: points.map((_, index) => ({
          elevationM: 100 + Math.sin((index / Math.max(points.length - 1, 1)) * Math.PI) * 40,
        })),
      },
    });
  });
  await page.route('**/api/route', (route) => {
    const body = route.request().postDataJSON() as {
      locations?: { lat: number; lon: number }[];
      alternates?: number;
    };
    const locs = body.locations ?? [];
    if (locs.length < 2) {
      return route.fulfill({ status: 400, json: { message: 'need two locations' } });
    }
    const coords = locs.map((l) => [l.lat, l.lon] as [number, number]);
    const lats = coords.map((c) => c[0]);
    const lngs = coords.map((c) => c[1]);
    const trip = {
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
    };
    const alternateCoords: [number, number][] = [
      coords[0]!,
      [(coords[0]![0] + coords.at(-1)![0]) / 2 + 0.003, (coords[0]![1] + coords.at(-1)![1]) / 2],
      coords.at(-1)!,
    ];
    return route.fulfill({
      json: {
        trip,
        ...(options.alternatives && body.alternates
          ? {
              alternates: [
                {
                  trip: {
                    units: 'kilometers',
                    legs: [{ shape: encodeShape(alternateCoords) }],
                    summary: {
                      length: 13.1,
                      time: 1200,
                      min_lat: Math.min(...alternateCoords.map((point) => point[0])),
                      min_lon: Math.min(...alternateCoords.map((point) => point[1])),
                      max_lat: Math.max(...alternateCoords.map((point) => point[0])),
                      max_lon: Math.max(...alternateCoords.map((point) => point[1])),
                    },
                  },
                },
              ],
            }
          : {}),
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

/**
 * Dismiss the place editor that saving a coordinate-named pin opens. Escape is
 * sent only once focus is inside the dialog: it is visible a frame before its
 * effects attach the Escape listener — in the same pass that focuses the Name
 * field — and a key sent in that gap is lost, leaving the dialog's backdrop
 * over the page to swallow every later click.
 */
export async function closePlaceEditor(page: Page): Promise<void> {
  const dialog = page.locator('.place-edit-dialog');
  await dialog.waitFor({ timeout: 10_000 });
  await page.waitForFunction(
    () => Boolean(document.activeElement?.closest('.place-edit-dialog')),
    undefined,
    { timeout: 10_000 },
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
}
