import { expect, test } from '@playwright/test';
import { encodeShape, mockRouting, project, startNavigationFromCard, waitForMap } from './helpers';

/**
 * Turn-by-turn web navigation: geolocation is mocked at the browser level and
 * routing at the network level, so the spec exercises the real hook, banner,
 * map layers and camera-follow logic.
 */
test.use({
  geolocation: { latitude: 59.91, longitude: 10.75 },
  permissions: ['geolocation'],
});

test('Explorer mode follows live GPS without creating a route', async ({ page, context }) => {
  let routeRequests = 0;
  await page.route('**/api/route', (route) => {
    routeRequests++;
    return route.fulfill({ status: 500, json: { message: 'Explorer must not route' } });
  });
  await page.goto('/#map=13/59.91/10.75');
  await waitForMap(page);

  await page.locator('.topbar button[aria-label="Route"]').click();
  await page.getByRole('button', { name: 'Hike' }).click();
  await page.getByRole('button', { name: 'Follow my position · no destination' }).click();

  await expect(page.getByText('Explorer mode')).toBeVisible();
  await expect(page.getByText('Hike · Following your position')).toBeVisible();
  await expect(page.getByText('No destination or turn-by-turn guidance')).toBeVisible();
  await expect(page.locator('.nav-puck')).toBeVisible();
  await expect(page.locator('.nav-widget')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Add a stop' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show route overview' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mute guidance' })).toHaveCount(0);
  expect(routeRequests).toBe(0);
  expect(await page.evaluate(() => Boolean(window.__atlasMap!.getSource('atlas-nav')))).toBe(false);

  await context.setGeolocation({ latitude: 59.915, longitude: 10.755 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const center = window.__atlasMap!.getCenter();
        return Math.abs(center.lat - 59.915) < 0.001 && Math.abs(center.lng - 10.755) < 0.001;
      }),
    )
    .toBe(true);

  await page.getByRole('button', { name: 'End' }).click();
  await expect(page.locator('.nav-banner')).toHaveCount(0);
  await expect(page.locator('.topbar')).toBeVisible();
});

test('navigate to a dropped pin: banner, route line, live progress, End', async ({
  page,
  context,
}) => {
  await mockRouting(page);
  // An ATK camera mid-route: the amber chip must appear once guidance starts
  // (the fetch is fire-and-forget beside the enrichment pass).
  await page.route('**/api/route/nvdb-cameras', (route) =>
    route.fulfill({ json: { cameras: { points: [{ atM: 500, name: 'ATK' }], sections: [] } } }),
  );
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);

  // Directions from the pin's place card opens the planner; Start navigation
  // there offers the route choices, and Start commits to the selected one.
  await page.locator('.place-marker').click();
  await startNavigationFromCard(page);
  await expect(page.locator('.nav-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.nav-preview')).toHaveCount(0);

  // Banner up, guidance summary showing, route drawn, puck snapped to the line.
  await expect(page.locator('.nav-banner')).toBeVisible();
  // Time left leads the banner as a bare number (no "left" label, Android
  // parity) — assert the shape, since the value depends on the mocked trip.
  await expect(page.locator('.nav-eta')).toHaveText(/^\d+ (min|h( \d+ min)?)$/);
  await expect(page.locator('.nav-summary')).toContainText('arrival');
  await expect(page.locator('.topbar')).toBeHidden();
  await page.waitForFunction(() => Boolean(window.__atlasMap!.getSource('atlas-nav')));
  await expect(page.locator('.nav-puck')).toBeVisible();
  await expect(page.locator('.nav-dest-marker')).toBeVisible();

  // The posted limit arrives from the enrichment pass a moment after guidance
  // starts (it is fetched in parallel, never blocking Start).
  await expect(page.locator('.nav-speed-limit')).toHaveText('60');
  // So does the speed-camera warning, from its own NVDB dataset fetch.
  await expect(page.locator('.nav-camera-chip')).toHaveText(/Speed camera · \d+ m/);

  // A fix near the destination arrives → the session declares arrival.
  await context.setGeolocation({ latitude: 59.9199, longitude: 10.7599 });
  await expect(page.locator('.nav-maneuver')).toContainText('You have arrived');

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.nav-banner')).toHaveCount(0);
});

test('Start refreshes a preview route from the latest position', async ({ page, context }) => {
  const routeOrigins: Array<{ lat: number; lon: number }> = [];
  await mockRouting(page);
  await page.route('**/api/route', async (route) => {
    const body = route.request().postDataJSON() as {
      locations?: { lat: number; lon: number }[];
    };
    const origin = body.locations?.[0];
    if (origin) routeOrigins.push(origin);
    await route.fallback();
  });
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);

  await page.locator('.place-marker').click();
  await page.getByRole('button', { name: 'Directions' }).click();
  await expect(page.locator('.route-stats')).toBeVisible();
  await page.getByRole('button', { name: 'Start navigation' }).click();
  await expect(page.locator('.nav-preview')).toBeVisible();

  // Move while considering the preview. The second route request made by
  // Start must use this position, not the fix that opened the preview.
  await context.setGeolocation({ latitude: 59.915, longitude: 10.755 });
  const before = [...routeOrigins];
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.nav-banner')).toBeVisible();

  // The planner routes the plan and each mode chip's trip time from the same
  // endpoint, so counting requests proves nothing — the origins do: nothing
  // asked from the moved position until Start, and Start did.
  expect(before.every((o) => o.lat === 59.91 && o.lon === 10.75)).toBe(true);
  expect(routeOrigins).toContainEqual({ lat: 59.915, lon: 10.755 });
});

test('a long motorway leg leads with the road, keeping the distant turn secondary', async ({
  page,
}) => {
  await mockRouting(page);
  // Override the ordinary instruction-less route fixture with a ~21 km E18
  // leg. Registered last, so it owns /api/route while the shared enrichment
  // mock continues to provide the speed limit.
  await page.route('**/api/route', (route) => {
    const body = route.request().postDataJSON() as {
      locations?: { lat: number; lon: number }[];
    };
    const locs = body.locations ?? [];
    const coords = locs.map((l) => [l.lat, l.lon] as [number, number]);
    if (coords.length < 2) {
      return route.fulfill({ status: 400, json: { message: 'need two locations' } });
    }
    return route.fulfill({
      json: {
        trip: {
          units: 'kilometers',
          legs: [
            {
              shape: encodeShape(coords),
              maneuvers: [
                {
                  type: 1,
                  instruction: 'Drive north on E18.',
                  street_names: ['E18'],
                  length: 21,
                  time: 900,
                  begin_shape_index: 0,
                  end_shape_index: 1,
                  verbal_pre_transition_instruction: 'Drive north on E18.',
                  verbal_post_transition_instruction: 'Continue on E18 for 21 kilometers.',
                },
                {
                  type: 4,
                  instruction: 'You have arrived.',
                  length: 0,
                  time: 0,
                  begin_shape_index: 1,
                  end_shape_index: 1,
                  verbal_pre_transition_instruction: 'You have arrived.',
                },
              ],
            },
          ],
          summary: {
            length: 21,
            time: 900,
            min_lat: Math.min(...coords.map((c) => c[0])),
            min_lon: Math.min(...coords.map((c) => c[1])),
            max_lat: Math.max(...coords.map((c) => c[0])),
            max_lon: Math.max(...coords.map((c) => c[1])),
          },
        },
      },
    });
  });
  await page.goto('/#map=9/60.01/10.75&pin=60.10/10.75');
  await waitForMap(page);

  await page.locator('.place-marker').click();
  await startNavigationFromCard(page);
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page.locator('.nav-distance-to')).toContainText('Continue for');
  await expect(page.locator('.nav-maneuver')).toHaveText('E18');
  await expect(page.locator('.nav-then-row')).toContainText('Then');
  await expect(page.locator('.nav-then-row')).toContainText('You have arrived');
});

test('lane guidance requests Valhalla lanes and highlights the carrying lane on approach', async ({
  page,
}) => {
  await mockRouting(page);
  let requestedTurnLanes = false;
  await page.route('**/api/route', (route) => {
    const body = route.request().postDataJSON() as {
      locations?: { lat: number; lon: number }[];
      turn_lanes?: boolean;
    };
    requestedTurnLanes ||= body.turn_lanes === true;
    const coords = (body.locations ?? []).map((l) => [l.lat, l.lon] as [number, number]);
    if (coords.length < 2) {
      return route.fulfill({ status: 400, json: { message: 'need two locations' } });
    }
    return route.fulfill({
      json: {
        trip: {
          units: 'kilometers',
          legs: [
            {
              shape: encodeShape(coords),
              maneuvers: [
                {
                  type: 1,
                  instruction: 'Drive east on Kirkeveien.',
                  length: 0.25,
                  time: 30,
                  begin_shape_index: 0,
                  end_shape_index: 0,
                },
                {
                  type: 10,
                  instruction: 'Turn right onto Geitmyrsveien.',
                  length: 0,
                  time: 0,
                  begin_shape_index: 1,
                  end_shape_index: 1,
                  lanes: [
                    { directions: 8 },
                    { directions: 2 },
                    { directions: 66, active: 64 },
                    { directions: 2 },
                  ],
                },
                {
                  type: 4,
                  instruction: 'You have arrived.',
                  length: 0,
                  time: 0,
                  begin_shape_index: 1,
                  end_shape_index: 1,
                },
              ],
            },
          ],
          summary: {
            length: 0.25,
            time: 30,
            min_lat: Math.min(...coords.map((c) => c[0])),
            min_lon: Math.min(...coords.map((c) => c[1])),
            max_lat: Math.max(...coords.map((c) => c[0])),
            max_lon: Math.max(...coords.map((c) => c[1])),
          },
        },
      },
    });
  });

  await page.goto('/#map=15/59.91/10.75&pin=59.912/10.752');
  await waitForMap(page);
  await page.locator('.place-marker').click();
  await startNavigationFromCard(page);
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page.locator('.nav-lanes')).toBeVisible();
  await expect(page.locator('.nav-lane')).toHaveCount(4);
  await expect(page.locator('.nav-lane-active')).toHaveCount(1);
  await expect(page.getByLabel('Lane 3: straight or right, use this lane')).toBeVisible();
  expect(requestedTurnLanes).toBe(true);
});

test('a fix too poor to arrive on still lets the driver finish the trip', async ({
  page,
  context,
}) => {
  await mockRouting(page);
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);

  await page.locator('.place-marker').click();
  await startNavigationFromCard(page);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.nav-banner')).toBeVisible();

  // 100 m short of the destination on the route line, with an 80 m error
  // radius — the multi-storey-car-park case. Too imprecise for the accuracy
  // gate (30 m) and outside the loiter radius (80 m), so neither automatic
  // rule can fire and guidance would otherwise announce a destination the
  // driver is standing on, forever.
  await context.setGeolocation({
    latitude: 59.919196,
    longitude: 10.759196,
    accuracy: 80,
  });
  await expect(page.getByRole('button', { name: "I've arrived" })).toBeVisible();
  await expect(page.locator('.nav-maneuver')).not.toContainText('You have arrived');

  // The manual hatch completes the trip rather than abandoning it: the arrival
  // card and its trip summary, exactly as a detected arrival produces.
  await page.getByRole('button', { name: "I've arrived" }).click();
  await expect(page.locator('.nav-maneuver')).toContainText('You have arrived');
  await expect(page.locator('.nav-arrival-summary')).toBeVisible();

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.nav-banner')).toHaveCount(0);
});

test('the arrival hatch stays hidden far from the destination', async ({ page }) => {
  await mockRouting(page);
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);

  await page.locator('.place-marker').click();
  await startNavigationFromCard(page);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.nav-banner')).toBeVisible();
  // Still ~1.2 km out at the start fix — offering "I've arrived" here would be
  // an invitation to end the trip by accident.
  await expect(page.getByRole('button', { name: "I've arrived" })).toHaveCount(0);
});

test('a multi-stop plan is driven through its via stops', async ({ page }) => {
  await mockRouting(page);
  const navLocations: number[] = [];
  await page.route('**/api/route', async (route) => {
    const body = route.request().postDataJSON() as { locations?: { lat: number }[] };
    // Guidance requests start from the live fix (lat 59.91); the planner's own
    // requests start from the plan's first stop and don't count here.
    if (Math.abs((body.locations?.[0]?.lat ?? 0) - 59.91) < 1e-6) {
      navLocations.push(body.locations?.length ?? 0);
    }
    await route.fallback();
  });
  // A four-stop plan restored from the share hash; the two middle stops are
  // the via points guidance must keep.
  await page.goto(
    '/#map=13/59.91/10.75&route=car/59.905,10.745/59.913,10.752/59.916,10.756/59.92,10.76',
  );
  await waitForMap(page);
  await expect(page.locator('.route-stats')).toBeVisible();

  await page.getByRole('button', { name: 'Start navigation' }).click();
  await expect(page.locator('.nav-preview')).toBeVisible();
  // Route requests for guidance carry fix + two vias + destination.
  expect(navLocations.every((n) => n === 4)).toBe(true);
  expect(navLocations.length).toBeGreaterThan(0);
  // The via stops show as dots through the preview and the drive; the finish
  // keeps its flag.
  await expect(page.locator('.nav-via-marker')).toHaveCount(2);

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.nav-banner')).toBeVisible();
  await expect(page.locator('.nav-via-marker')).toHaveCount(2);
  await expect(page.locator('.nav-dest-marker')).toBeVisible();

  await page.getByRole('button', { name: 'End' }).click();
  await expect(page.locator('.nav-banner')).toHaveCount(0);
  await expect(page.locator('.nav-via-marker')).toHaveCount(0);
});

test('a stop can be added mid-drive: quick category pick and tapped point', async ({ page }) => {
  await mockRouting(page);
  const navLocationCounts: number[] = [];
  await page.route('**/api/route', async (route) => {
    const body = route.request().postDataJSON() as { locations?: { lat: number }[] };
    // Guidance requests start from the live fix (lat 59.91).
    if (Math.abs((body.locations?.[0]?.lat ?? 0) - 59.91) < 1e-6) {
      navLocationCounts.push(body.locations?.length ?? 0);
    }
    await route.fallback();
  });
  // The quick-stop panel asks the explore endpoint for its category; one gas
  // station ahead on the line is enough — the corridor rules have unit tests.
  await page.route('**/api/explore**', (route) =>
    route.fulfill({
      json: {
        results: [
          { name: 'Circle K Kværner', label: 'Oslo', position: { lat: 59.915, lng: 10.755 } },
        ],
      },
    }),
  );
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);
  await page.locator('.place-marker').click();
  await startNavigationFromCard(page);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.nav-banner')).toBeVisible();
  await expect(page.locator('.nav-via-marker')).toHaveCount(0);

  // The banner's + opens the category panel; picking the station reroutes
  // through it (fix + stop + destination) and it appears as a via dot.
  await page.getByRole('button', { name: 'Add a stop', exact: true }).click();
  await expect(page.locator('.nav-add-stop')).toBeVisible();
  await page.locator('.nav-add-stop-list button').click();
  await expect(page.locator('.nav-add-stop')).toHaveCount(0);
  await expect(page.locator('.nav-via-marker')).toHaveCount(1);
  expect(navLocationCounts).toContain(3);

  // A point tapped on the map mid-drive asks one question — "stop here?" —
  // and adding it reroutes through both stops in route order.
  const [x, y] = await project(page, 59.9112, 10.7512);
  await page.locator('.maplibregl-canvas').click({ button: 'right', position: { x, y } });
  await expect(page.locator('.nav-stop-tap-card')).toBeVisible();
  await page.locator('.nav-stop-tap-add').click();
  await expect(page.locator('.nav-stop-tap-card')).toHaveCount(0);
  await expect(page.locator('.nav-via-marker')).toHaveCount(2);
  expect(navLocationCounts).toContain(4);

  await page.getByRole('button', { name: 'End' }).click();
  await expect(page.locator('.nav-banner')).toHaveCount(0);
});

test('geolocation denied shows an error state, End dismisses it', async ({ page, context }) => {
  await mockRouting(page);
  await context.clearPermissions();
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);

  await page.locator('.place-marker').click();
  await startNavigationFromCard(page);

  await expect(page.locator('.nav-error')).toBeVisible();
  await page.getByRole('button', { name: 'End' }).click();
  await expect(page.locator('.nav-banner')).toHaveCount(0);
});

test('a mapped tunnel names itself in the road chip and dims the map', async ({ page }) => {
  await mockRouting(page);
  // Registered after mockRouting, so this handler wins: the whole drive runs
  // through one named tunnel. Registering it here rather than in the shared
  // helper keeps the other nav tests on open road.
  await page.route('**/api/route/attributes', (route) => {
    const body = route.request().postDataJSON() as { shape?: unknown[] };
    const shape = body.shape ?? [];
    return route.fulfill({
      json: {
        edges: [
          {
            begin_shape_index: 0,
            end_shape_index: shape.length - 1,
            speed_limit: 70,
            tunnel: true,
            names: ['Brynstunnelen'],
          },
        ],
      },
    });
  });
  await page.goto('/#map=13/59.91/10.75&pin=59.92/10.76');
  await waitForMap(page);

  await page.locator('.place-marker').click();
  await startNavigationFromCard(page);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.nav-banner')).toBeVisible();

  // The chip names the tunnel and counts down to the far portal, instead of
  // the road underneath — and the map dims at the portal, from the route data
  // rather than after four seconds of dead reckoning.
  await expect(page.locator('.nav-road-chip')).toContainText('Brynstunnelen · ');
  await expect(page.locator('.tunnel-dim-on')).toHaveCount(1);
});
