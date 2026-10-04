import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { GarminAuthError, GarminBridgeError } from './garmin-bridge.js';
import type { SyncApiOptions } from './sync-api.js';

let app: FastifyInstance;
let dataDir: string;
const connections = new Set<string>();
const garmin: NonNullable<SyncApiOptions['garmin']> = {
  status: vi.fn(async (userId) => connections.has(userId)),
  connect: vi.fn(async (userId) => {
    connections.add(userId);
    return 'mfa' as const;
  }),
  completeMfa: vi.fn(async () => {}),
  disconnect: vi.fn(async (userId) => {
    connections.delete(userId);
  }),
  uploadCourse: vi.fn(async () => ({
    id: 123,
    url: 'https://connect.garmin.com/modern/course/123',
    queued: true,
  })),
  devices: vi.fn(async () => [{ id: '456', name: 'Forerunner' }]),
  activities: vi.fn(async () => [{ id: '42', name: 'Run', date: null, type: 'running' }]),
  activityGpx: vi.fn(async () => '<gpx/>'),
};

async function account(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'correct horse' },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { token: string }).token;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-garmin-api-'));
  app = await buildApp({
    dataDir,
    databaseUrl: 'memory',
    jwtSecret: 'test-secret',
    syncApi: { authRateLimit: false, garmin },
  });
});

afterAll(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

it('requires an Atlas account and keeps Garmin state scoped to that account', async () => {
  const a = await account('garmin-a@example.com');
  const b = await account('garmin-b@example.com');
  expect((await app.inject({ url: '/api/garmin/status' })).statusCode).toBe(401);
  const connect = await app.inject({
    method: 'POST',
    url: '/api/garmin/connect',
    headers: { authorization: `Bearer ${a}` },
    payload: { email: 'runner@example.com', password: 'secret' },
  });
  expect(connect.json()).toEqual({ connected: false, mfaRequired: true });
  expect(
    (
      await app.inject({ url: '/api/garmin/status', headers: { authorization: `Bearer ${a}` } })
    ).json(),
  ).toEqual({ connected: true });
  expect(
    (
      await app.inject({ url: '/api/garmin/status', headers: { authorization: `Bearer ${b}` } })
    ).json(),
  ).toEqual({ connected: false });
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/garmin/mfa',
        headers: { authorization: `Bearer ${a}` },
        payload: { code: '123456' },
      })
    ).json(),
  ).toEqual({ connected: true });
  const aId = vi.mocked(garmin.connect).mock.calls.at(-1)![0];
  expect(vi.mocked(garmin.completeMfa).mock.calls.at(-1)![0]).toBe(aId);
});

it('validates course input and returns the verified Garmin course', async () => {
  const token = await account('course@example.com');
  const headers = { authorization: `Bearer ${token}` };
  const bad = await app.inject({
    method: 'POST',
    url: '/api/garmin/course',
    headers,
    payload: {
      name: 'Run',
      profile: 'car',
      gpx: '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></trkseg></trk></gpx>',
    },
  });
  expect(bad.statusCode).toBe(400);
  const good = await app.inject({
    method: 'POST',
    url: '/api/garmin/course',
    headers,
    payload: {
      name: 'Sunday run',
      profile: 'run',
      gpx: '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></trkseg></trk></gpx>',
      deviceId: '456',
    },
  });
  expect(good.statusCode).toBe(200);
  expect(good.json()).toEqual({
    id: 123,
    url: 'https://connect.garmin.com/modern/course/123',
    queued: true,
  });
  expect(vi.mocked(garmin.uploadCourse).mock.calls.at(-1)?.slice(1)).toEqual([
    'Sunday run',
    'run',
    '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></trkseg></trk></gpx>',
    '456',
  ]);
});

it('serves activity metadata and GPX only to an authenticated user', async () => {
  const token = await account('activity@example.com');
  const headers = { authorization: `Bearer ${token}` };
  expect((await app.inject({ url: '/api/garmin/devices', headers })).json()).toEqual({
    devices: [{ id: '456', name: 'Forerunner' }],
  });
  expect((await app.inject({ url: '/api/garmin/activities', headers })).json()).toEqual({
    activities: [{ id: '42', name: 'Run', date: null, type: 'running' }],
  });
  expect((await app.inject({ url: '/api/garmin/activities/42/gpx', headers })).json()).toEqual({
    gpx: '<gpx/>',
  });
  expect(
    (await app.inject({ url: '/api/garmin/activities/not-an-id/gpx', headers })).statusCode,
  ).toBe(400);
  expect((await app.inject({ url: '/api/garmin/activities?start=30', headers })).statusCode).toBe(
    200,
  );
  expect(vi.mocked(garmin.activities).mock.calls.at(-1)?.[1]).toBe(30);
});

it('reports a refused password as 401 but a broken bridge as unavailable', async () => {
  const token = await account('garmin-errors@example.com');
  const connect = () =>
    app.inject({
      method: 'POST',
      url: '/api/garmin/connect',
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'runner@example.com', password: 'secret' },
    });
  vi.mocked(garmin.connect).mockRejectedValueOnce(new GarminAuthError('rejected'));
  const refused = await connect();
  expect(refused.statusCode).toBe(401);
  expect(refused.json()).toEqual({ error: 'Garmin rejected the email or password' });
  // The v0.246.0 image could not load libssl, so the bridge died before replying.
  vi.mocked(garmin.connect).mockRejectedValueOnce(
    new Error('Garmin connection ended unexpectedly'),
  );
  const broken = await connect();
  expect(broken.statusCode).toBe(502);
  expect(broken.json()).toEqual({ error: 'Garmin Connect is unavailable or needs reconnecting' });
  vi.mocked(garmin.connect).mockRejectedValueOnce(
    new GarminBridgeError('Garmin is rate-limiting this server; try again later'),
  );
  const limited = await connect();
  expect(limited.statusCode).toBe(502);
  expect(limited.json()).toEqual({ error: 'Garmin is rate-limiting this server; try again later' });
});
