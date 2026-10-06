/**
 * A signed-in Atlas account with a connected Garmin Connect library, for looking at the Garmin
 * screens on the emulator without a real account or watch. Off unless `ATLAS_E2E_GARMIN=1`: the
 * release regression runs signed out, and its health check reports sync as unavailable.
 *
 * Sign in with any email and password. Sync accepts every push and never sends anything back,
 * so what the app saves stays on the device. The library is fixed: courses in seven sports, 205
 * GPS activities across five years (served 30 at a time, newest first, like Garmin), two
 * watches. Course edits change this process's copy only.
 */

const BASE = { lat: 59.94, lng: 10.72 };

const COURSE_SEED = [
  ['Nordmarka loop', 'trail_running', 18_040, 536],
  ['Sognsvann round', 'running', 3_320, 22],
  ['Holmenkollen intervals', 'running', 6_100, 140],
  ['Frognerseteren climb', 'road_biking', 24_500, 480],
  ['Krokskogen gravel', 'gravel_cycling', 61_200, 910],
  ['Vettakollen hike', 'hiking', 9_800, 390],
  ['Kolsås ridge', 'hiking', 12_300, 610],
  ['Bygdøy walk', 'walking', 5_400, 40],
  ['Sørkedalen classic', 'cross_country_skiing_ws', 21_000, 300],
  ['Maridalen lap', 'cycling', 32_700, 260],
  ['Lillomarka MTB', 'mountain_biking', 27_400, 640],
  ['Akerselva easy', 'running', 7_900, 60],
];

/**
 * The sport mix of a real account (2026-10): mostly runs, a long tail of sports with one to
 * fifteen activities each — the tail is what a sport filter has to fit on a phone.
 */
const ACTIVITY_MIX = [
  ['running', 'Run', 105],
  ['trail_running', 'Trail run', 55],
  ['hiking', 'Hike', 15],
  ['skating_ws', 'Ice skating', 8],
  ['walking', 'Walk', 6],
  ['cross_country_skiing_ws', 'Ski tour', 5],
  ['open_water_swimming', 'Open water swim', 4],
  ['hunting', 'Hunt', 2],
  ['rowing_v2', 'Row', 2],
  ['cycling', 'Ride', 1],
  ['kayaking_v2', 'Kayak', 1],
  ['multi_sport', 'Multisport', 1],
];
const ACTIVITY_TYPES = ACTIVITY_MIX.flatMap(([type, label, count]) =>
  Array.from({ length: count }, () => [type, label]),
);

const day = 86_400_000;
const now = Date.now();

let courses = COURSE_SEED.map(([name, type, distanceM, ascentM], index) => ({
  id: String(400_000 + index),
  name,
  type,
  distanceM,
  ascentM,
  updated: now - (index * 9 + 2) * day,
}));

/** 205 activities over almost five years, newest first, sports interleaved. */
const activities = Array.from({ length: ACTIVITY_TYPES.length }, (_, index) => {
  const [type, label] = ACTIVITY_TYPES[(index * 37) % ACTIVITY_TYPES.length];
  const date = new Date(now - (index * 8 + 1) * day).toISOString().slice(0, 10);
  return {
    id: String(9_000_000 + index),
    name: `${label} ${date.slice(5)}`,
    date,
    type,
    hasRoute: index % 17 !== 5,
  };
});

/** A small closed loop whose size and position vary with `seed`. */
function loopGpx(name, seed) {
  const radius = 0.006 + (seed % 7) * 0.002;
  const lat0 = BASE.lat + ((seed % 11) - 5) * 0.01;
  const lng0 = BASE.lng + ((seed % 13) - 6) * 0.02;
  const points = Array.from({ length: 40 }, (_, i) => {
    const angle = (i / 39) * Math.PI * 2;
    const lat = lat0 + Math.sin(angle) * radius;
    const lng = lng0 + Math.cos(angle) * radius * 1.8;
    const ele = 150 + Math.round(Math.sin(angle * 2) * 40);
    return `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"><ele>${ele}</ele></trkpt>`;
  });
  return (
    `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Atlas E2E" ` +
    `xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>` +
    `${points.join('')}</trkseg></trk></gpx>`
  );
}

const DEVICES = [
  { id: '3400001', name: 'Forerunner 965' },
  { id: '3400002', name: 'fēnix 7' },
];

export const garminFixtureEnabled = process.env.ATLAS_E2E_GARMIN === '1';

/**
 * Answers the account, sync and Garmin routes; returns false for anything else so the caller's
 * own routes run. `json` and `readJson` are the fixture server's helpers.
 */
export async function handleGarminFixture(url, request, response, { json, readJson }) {
  if (!garminFixtureEnabled) return false;
  const path = url.pathname;
  const method = request.method ?? 'GET';
  if ((path === '/api/auth/login' || path === '/api/auth/register') && method === 'POST') {
    const body = await readJson(request);
    json(response, { token: 'e2e-garmin-token', email: body.email || 'e2e@atlas.test' });
    return true;
  }
  if (path === '/api/sync/push' && method === 'POST') {
    const body = await readJson(request);
    json(response, {
      applied: body.changes?.length ?? 0,
      skipped: 0,
      acceptsTrackMetadata: true,
    });
    return true;
  }
  if (path === '/api/sync/pull') {
    json(response, { changes: [], cursor: 1, hasMore: false });
    return true;
  }
  if (!path.startsWith('/api/garmin/')) return false;

  if (path === '/api/garmin/status') return (json(response, { connected: true }), true);
  if (path === '/api/garmin/devices') return (json(response, { devices: DEVICES }), true);
  if (path === '/api/garmin/courses' && method === 'GET') {
    json(response, { courses });
    return true;
  }
  if (path === '/api/garmin/activities') {
    const start = Number(url.searchParams.get('start') ?? 0);
    json(response, { activities: activities.slice(start, start + 30) });
    return true;
  }
  let match = /^\/api\/garmin\/activities\/(\d+)\/gpx$/.exec(path);
  if (match) {
    const activity = activities.find((item) => item.id === match[1]);
    json(response, { gpx: loopGpx(activity?.name ?? 'Activity', Number(match[1])) });
    return true;
  }
  match = /^\/api\/garmin\/courses\/(\d+)(\/gpx|\/send)?$/.exec(path);
  if (match) {
    const [, id, action] = match;
    const course = courses.find((item) => item.id === id);
    if (!course) return (json(response, { error: 'Course not found.' }, 404), true);
    if (action === '/gpx') json(response, { gpx: loopGpx(course.name, Number(id)) });
    else if (action === '/send') json(response, { queued: true });
    else if (method === 'DELETE') {
      courses = courses.filter((item) => item.id !== id);
      json(response, { ok: true });
    } else if (method === 'PATCH') {
      const body = await readJson(request);
      if (typeof body.name === 'string') course.name = body.name;
      if (typeof body.sport === 'string') course.type = body.sport;
      course.updated = Date.now();
      json(response, { ok: true });
    } else json(response, { error: 'Unsupported.' }, 405);
    return true;
  }
  json(response, { error: 'garmin fixture route not found', path }, 404);
  return true;
}
