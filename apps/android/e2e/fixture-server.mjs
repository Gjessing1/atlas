#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

// Rendered by `@atlas/transit`, from its built `dist/` — so a commute board and
// a widget board in this fixture are the ones the backend would send, not a
// second implementation of them. Needs `npm run build:packages` to have run,
// which every path that reaches the regression (the gate, both publish scripts)
// already has.
import {
  commuteFixtureResponse,
  lastWidgetBoard,
  widgetFixtureResponse,
} from './transit-fixture.mjs';
import { garminFixtureEnabled, handleGarminFixture } from './garmin-fixture.mjs';

const host = process.env.ATLAS_E2E_HOST ?? '0.0.0.0';
const port = Number(process.env.ATLAS_E2E_PORT ?? 3199);
const assetsRoot = process.env.ATLAS_E2E_ASSETS ?? '/mnt/data/atlas/assets';

const ORIGIN = { lat: 59.8337, lng: 10.4348 };
const DESTINATION = { lat: 59.9147, lng: 10.7333 };
const SAVED = { lat: 59.876, lng: 10.55 };
/** The commute's interchange — a corridor needs three stops to have a change. */
const INTERCHANGE = { lat: 59.8334, lng: 10.4343 };
const COMMUTE_STOPS = [
  { match: 'engelsrud', name: 'Engelsrud E2E', position: ORIGIN, stopId: 'NSR:StopPlace:59872' },
  { match: 'asker', name: 'Asker E2E', position: INTERCHANGE, stopId: 'NSR:StopPlace:59873' },
  { match: 'oslo', name: 'Oslo E2E', position: DESTINATION, stopId: 'NSR:StopPlace:58404' },
];
const routeQueries = [];

const json = (response, body, status = 200) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function encodeShape(points) {
  const factor = 1_000_000;
  let previousLat = 0;
  let previousLng = 0;
  let result = '';
  const encode = (current, previous) => {
    let value = (Math.round(current * factor) - Math.round(previous * factor)) << 1;
    if (value < 0) value = ~value;
    let encoded = '';
    while (value >= 0x20) {
      encoded += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    return encoded + String.fromCharCode(value + 63);
  };
  for (const point of points) {
    result += encode(point.lat, previousLat);
    result += encode(point.lng, previousLng);
    previousLat = point.lat;
    previousLng = point.lng;
  }
  return result;
}

function routeTrip(points, time = 780) {
  const from = points[0] ?? ORIGIN;
  const to = points.at(-1) ?? DESTINATION;
  const middle = {
    lat: (from.lat + to.lat) / 2 + 0.002,
    lng: (from.lng + to.lng) / 2 - 0.002,
  };
  const shape = [from, middle, to];
  return {
    trip: {
      units: 'kilometers',
      summary: { length: 19.4, time },
      legs: [
        {
          shape: encodeShape(shape),
          maneuvers: [
            {
              type: 1,
              instruction: 'Drive east on E2E Road.',
              verbal_succinct_transition_instruction: 'Drive east.',
              verbal_pre_transition_instruction: 'Drive east on E2E Road.',
              verbal_post_transition_instruction: 'Continue for 9 kilometers.',
              street_names: ['E2E Road'],
              length: 9,
              time: Math.round(time / 2),
              begin_shape_index: 0,
              end_shape_index: 1,
            },
            {
              type: 10,
              instruction: 'Turn right onto Fixture Street.',
              verbal_succinct_transition_instruction: 'Turn right.',
              verbal_pre_transition_instruction: 'Turn right onto Fixture Street.',
              verbal_post_transition_instruction: 'Continue for 10 kilometers.',
              street_names: ['Fixture Street'],
              length: 10.4,
              time: Math.round(time / 2),
              begin_shape_index: 1,
              end_shape_index: 2,
            },
            {
              type: 4,
              instruction: 'You have arrived at E2E Destination.',
              length: 0,
              time: 0,
              begin_shape_index: 2,
              end_shape_index: 2,
            },
          ],
        },
      ],
    },
  };
}

function searchResults(query, transit = false) {
  const lower = query.toLowerCase();
  if (lower.includes('origin')) {
    return [
      {
        name: 'E2E Origin',
        label: 'Asker, Norway',
        position: ORIGIN,
        ...(transit ? { transitStopId: 'NSR:StopPlace:59872' } : {}),
      },
    ];
  }
  if (lower.includes('destination')) {
    return [
      {
        name: 'E2E Destination',
        label: 'Oslo, Norway',
        position: DESTINATION,
        ...(transit ? { transitStopId: 'NSR:StopPlace:58404' } : {}),
      },
    ];
  }
  // The commute corridor's three stops. Named for real places
  // rather than "E2E Origin" for one reason that shows on the widget: the
  // selector's chip is the *first word* of the far end (`directionShort`), so a
  // corridor whose ends both begin "E2E" would draw two chips reading "TO E2E"
  // and the regression could not tell the two directions apart.
  const stop = COMMUTE_STOPS.find((entry) => lower.includes(entry.match));
  if (stop) {
    return [
      {
        name: stop.name,
        label: 'Fixture, Norway',
        position: stop.position,
        ...(transit ? { transitStopId: stop.stopId } : {}),
      },
    ];
  }
  if (lower.includes('saved')) {
    return [{ name: 'E2E Saved Place', label: 'Fixture, Norway', position: SAVED }];
  }
  return [];
}

function transitResult() {
  const start = Date.now() + 5 * 60_000;
  const board = start + 3 * 60_000;
  const arrive = board + 18 * 60_000;
  const end = arrive + 4 * 60_000;
  const origin = { name: 'E2E Origin', position: ORIGIN };
  const asker = {
    name: 'Asker stasjon',
    position: { lat: 59.8334, lng: 10.4343 },
    quay: { id: 'NSR:Quay:700', publicCode: '2' },
  };
  const oslo = {
    name: 'Nationaltheatret stasjon',
    position: { lat: 59.9154, lng: 10.7276 },
    quay: { id: 'NSR:Quay:477', publicCode: '3' },
  };
  const destination = { name: 'E2E Destination', position: DESTINATION };
  return {
    trips: [
      {
        startMs: start,
        endMs: end,
        durationMs: end - start,
        walkDistanceM: 520,
        legs: [
          {
            mode: 'foot',
            distanceM: 180,
            durationMs: board - start,
            aimedStartMs: start,
            expectedStartMs: start,
            aimedEndMs: board,
            expectedEndMs: board,
            realtime: false,
            from: origin,
            to: asker,
            intermediateStops: [],
            points: [ORIGIN, asker.position],
            situations: [],
          },
          {
            mode: 'rail',
            distanceM: 21_500,
            durationMs: arrive - board,
            aimedStartMs: board,
            expectedStartMs: board,
            aimedEndMs: arrive,
            expectedEndMs: arrive,
            realtime: true,
            from: asker,
            to: oslo,
            line: {
              id: 'VYG:Line:R14',
              publicCode: 'R14',
              name: 'Asker–Oslo',
              operator: 'Vy',
              headsign: 'Oslo S',
              colour: '#00685e',
              textColour: '#ffffff',
            },
            intermediateStops: [
              { name: 'Sandvika', position: { lat: 59.89, lng: 10.52 } },
              { name: 'Lysaker', position: { lat: 59.913, lng: 10.637 } },
            ],
            points: [asker.position, { lat: 59.89, lng: 10.57 }, oslo.position],
            situations: [],
          },
          {
            mode: 'foot',
            distanceM: 340,
            durationMs: end - arrive,
            aimedStartMs: arrive,
            expectedStartMs: arrive,
            aimedEndMs: end,
            expectedEndMs: end,
            realtime: false,
            from: oslo,
            to: destination,
            intermediateStops: [],
            points: [oslo.position, DESTINATION],
            situations: [],
          },
        ],
      },
    ],
    problems: [],
  };
}

function assetPath(urlPath) {
  const relative = normalize(decodeURIComponent(urlPath.slice('/assets/'.length))).replace(
    /^(\.\.(\/|\\|$))+/,
    '',
  );
  return join(assetsRoot, relative);
}

function serveAsset(requestPath, response) {
  const file = assetPath(requestPath);
  if (
    !file.startsWith(`${normalize(assetsRoot)}/`) ||
    !existsSync(file) ||
    !statSync(file).isFile()
  ) {
    json(response, { error: 'asset not found' }, 404);
    return;
  }
  const contentTypes = {
    '.json': 'application/json',
    '.pbf': 'application/x-protobuf',
    '.png': 'image/png',
  };
  response.writeHead(200, {
    'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/assets/')) return serveAsset(url.pathname, response);
    if (url.pathname.startsWith('/api/tiles/')) {
      response.writeHead(200, { 'content-type': 'application/vnd.mapbox-vector-tile' });
      return response.end(Buffer.alloc(0));
    }
    if (url.pathname === '/api/health') {
      return json(response, {
        status: 'ok',
        app: 'Atlas E2E',
        gitSha: 'android-regression-fixture',
        sync: garminFixtureEnabled,
        registration: garminFixtureEnabled ? 'open' : 'closed',
      });
    }
    if (await handleGarminFixture(url, request, response, { json, readJson })) return;
    if (url.pathname === '/api/layers') return json(response, { layers: [] });
    if (url.pathname === '/api/regions') return json(response, { regions: [] });
    if (url.pathname === '/api/app/version') return json(response, null, 404);
    if (url.pathname === '/api/search') {
      return json(response, { results: searchResults(url.searchParams.get('q') ?? '') });
    }
    if (url.pathname === '/api/search/reverse') {
      return json(response, {
        result: { name: 'E2E map point', label: 'Fixture, Norway', position: SAVED },
      });
    }
    if (url.pathname === '/api/transit/stops') {
      return json(response, {
        results: searchResults(url.searchParams.get('q') ?? '', true),
      });
    }
    if (url.pathname === '/api/transit' && request.method === 'POST') {
      await readJson(request);
      return json(response, transitResult());
    }
    // The commute board and the home-screen widget. Both boards
    // come back rendered by `@atlas/transit`, so what the regression reads off
    // the launcher is what the backend would have sent.
    if (url.pathname === '/api/transit/commute' && request.method === 'POST') {
      return json(response, commuteFixtureResponse(await readJson(request), Date.now()));
    }
    if (url.pathname === '/api/transit/widget' && request.method === 'POST') {
      const board = widgetFixtureResponse(await readJson(request), Date.now());
      return json(response, board, board?.error ? 400 : 200);
    }
    // What the widget was last *told* to paint. The regression asserts the home
    // screen against this rather than against a copy of the expected rows kept
    // in the test, which would be a second thing to keep true.
    //
    // Answered with `connection: close`. The regression drives adb through
    // synchronous child processes, so its event loop can sit blocked past this
    // server's 5 s keep-alive timeout; the next fetch then reuses a socket the
    // server already closed and fails with `UND_ERR_SOCKET other side closed`
    // — which failed v0.243.0's stop-widget step twice, identically.
    if (url.pathname === '/api/e2e/widget-board') {
      response.setHeader('connection', 'close');
      return json(response, lastWidgetBoard(url.searchParams.get('variant') ?? 'v2'));
    }
    if (url.pathname === '/api/e2e/route-queries') {
      response.setHeader('connection', 'close');
      if (url.searchParams.has('clear')) routeQueries.length = 0;
      return json(response, routeQueries);
    }
    if (url.pathname === '/api/transit/stop-lines') {
      return json(response, {
        stop: { id: url.searchParams.get('stopId') ?? '', name: 'E2E stop' },
        lines: [
          { id: 'RUT:Line:280', publicCode: '280', name: 'Asker – Engelsrud', mode: 'bus' },
          { id: 'VYG:Line:R14', publicCode: 'R14', name: 'Asker – Oslo', mode: 'rail' },
        ],
      });
    }
    if (url.pathname === '/api/route' && request.method === 'POST') {
      const body = await readJson(request);
      routeQueries.push(body);
      if (routeQueries.length > 100) routeQueries.shift();
      const locations = Array.isArray(body.locations) ? body.locations : [];
      const points = locations.flatMap((point) =>
        typeof point?.lat === 'number' && typeof point?.lon === 'number'
          ? [{ lat: point.lat, lng: point.lon }]
          : [],
      );
      if (points.length < 2) return json(response, { message: 'two route points required' }, 400);
      const primary = routeTrip(points, 780);
      return json(response, {
        ...primary,
        ...(body.alternates ? { alternates: [routeTrip(points, 900)] } : {}),
      });
    }
    if (url.pathname === '/api/route/attributes' && request.method === 'POST') {
      const body = await readJson(request);
      const shape = Array.isArray(body.shape) ? body.shape : [];
      return json(response, {
        edges: [
          {
            begin_shape_index: 0,
            end_shape_index: Math.max(1, shape.length - 1),
            speed_limit: 80,
            road_class: 'primary',
            surface: 'paved_smooth',
            names: ['E2E Road'],
          },
        ],
      });
    }
    if (url.pathname === '/api/elevation/profile' && request.method === 'POST') {
      const body = await readJson(request);
      const points = Array.isArray(body.points) ? body.points : [];
      return json(response, {
        samples: points.map((_, index) => ({ elevationM: 100 + index * 5, source: 'E2E' })),
      });
    }
    if (url.pathname === '/api/elevation')
      return json(response, { elevationM: 120, source: 'E2E' });
    if (url.pathname === '/api/traffic/closures' && request.method === 'POST') {
      await readJson(request);
      return json(response, { closures: [] });
    }
    if (url.pathname === '/api/traffic/travel-times' && request.method === 'POST') {
      await readJson(request);
      return json(response, { delayMs: 0, segments: [], measuredAt: new Date().toISOString() });
    }
    if (url.pathname === '/api/traffic/road-weather' && request.method === 'POST') {
      await readJson(request);
      return json(response, { checkedAt: new Date().toISOString(), matchedSites: 0, warnings: [] });
    }
    if (url.pathname === '/api/route/nvdb-limits' && request.method === 'POST') {
      await readJson(request);
      return json(response, { overrides: [] });
    }
    if (url.pathname === '/api/route/nvdb-lanes' && request.method === 'POST') {
      await readJson(request);
      return json(response, { overrides: [] });
    }
    if (url.pathname === '/api/route/nvdb-cameras' && request.method === 'POST') {
      await readJson(request);
      return json(response, { cameras: { points: [], sections: [] } });
    }
    return json(response, { error: 'fixture route not found', path: url.pathname }, 404);
  } catch (error) {
    return json(response, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`Atlas Android fixture server listening on http://${host}:${port}`);
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
