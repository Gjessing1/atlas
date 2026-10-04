import fastifyJwt from '@fastify/jwt';
import { Type, type Static } from '@sinclair/typebox';
import type { SyncChange } from '@atlas/storage';
import { parseGpx } from '@atlas/gpx';
import { clampFutureStamps } from '@atlas/sync';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword } from './passwords.js';
import {
  GarminAuthError,
  GarminBridgeError,
  GarminSignInExpiredError,
  type GarminActivity,
  type GarminDevice,
  type GarminProfile,
} from './garmin-bridge.js';
import type { Stores } from './stores.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // `epoch` is the token's issue epoch, checked against the user's
    // tokenEpoch so a password change invalidates every older token.
    payload: { sub: string; email: string; epoch: number };
    user: { sub: string; email: string; epoch: number };
  }
}

/** Who may create an account on this instance (REGISTRATION env). */
export type RegistrationMode = 'open' | 'invite' | 'closed';

export interface SyncApiOptions {
  /** Defaults to 'open' — or 'invite' when an invite code is configured. */
  registration?: RegistrationMode;
  /** Required in `invite` mode (REGISTRATION_INVITE_CODE). */
  inviteCode?: string;
  /** Auth attempts per IP per window. Test seam; false disables limiting. */
  authRateLimit?: false | { max: number; timeWindow: string | number };
  garmin?: {
    status(userId: string): Promise<boolean>;
    connect(userId: string, email: string, password: string): Promise<'connected' | 'mfa'>;
    completeMfa(userId: string, code: string): Promise<void>;
    disconnect(userId: string): Promise<void>;
    uploadCourse(
      userId: string,
      name: string,
      profile: GarminProfile,
      gpx: string,
      deviceId?: string,
    ): Promise<{ id: number; url: string; queued: boolean }>;
    devices(userId: string): Promise<GarminDevice[]>;
    activities(userId: string, start: number): Promise<GarminActivity[]>;
    activityGpx(userId: string, id: string): Promise<string>;
  };
}

/**
 * Login/register are scrypt oracles — unlimited attempts mean offline-speed
 * brute force and registration spam. Deliberately tight: a human signing in
 * needs a handful of tries, not dozens.
 *
 * Note this is a budget *per auth route* per client, not one shared pool
 * (@fastify/rate-limit keeps a store per route). That's the meaningful control
 * anyway: password guessing only goes through /login and signup spam only
 * through /register, so each attack faces the full limit on its own path.
 */
const DEFAULT_AUTH_RATE_LIMIT = { max: 20, timeWindow: '5 minutes' };

/**
 * Registration mode from explicit options or env. An invite code without an
 * explicit mode implies `invite` — configuring a code and staying open would
 * be a silent no-op.
 */
export function resolveRegistrationMode(opts: SyncApiOptions): RegistrationMode {
  if (opts.registration) return opts.registration;
  return opts.inviteCode ? 'invite' : 'open';
}

/**
 * Parse the REGISTRATION env var. An unset value means "not configured" (the
 * invite code then decides); anything unrecognised is a misconfiguration and
 * fails closed rather than silently leaving registration open.
 */
export function parseRegistrationMode(raw: string | undefined): RegistrationMode | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'open' || value === 'invite' || value === 'closed') return value;
  throw new Error(`REGISTRATION must be open, invite or closed (got ${JSON.stringify(raw)})`);
}

const MAX_CHANGES_PER_PUSH = 500;
/** GPX documents ride inside push payloads; allow well beyond typical track sizes. */
const PUSH_BODY_LIMIT = 32 * 1024 * 1024;

// JSON-schema (TypeBox) validators, compiled by Fastify's AJV. Routes use
// attachValidation so a failed validation still answers with the same
// friendly `{ error }` bodies the clients show verbatim.

const AuthBodySchema = Type.Object({
  // Whitespace padding is tolerated (then trimmed) to match the old
  // trim-first validation; the handler normalizes to lower case.
  email: Type.String({ pattern: '^\\s*\\S+@\\S+\\.\\S+\\s*$', maxLength: 254 }),
  password: Type.String(),
  /** Only read in `invite` registration mode; ignored elsewhere. */
  invite: Type.Optional(Type.String({ maxLength: 256 })),
});
type AuthBody = Static<typeof AuthBodySchema>;

const ChangePasswordSchema = Type.Object({
  currentPassword: Type.String(),
  newPassword: Type.String(),
});
type ChangePasswordBody = Static<typeof ChangePasswordSchema>;

const DeleteAccountSchema = Type.Object({
  password: Type.String(),
});
type DeleteAccountBody = Static<typeof DeleteAccountSchema>;

const SyncChangeSchema = Type.Object({
  entity: Type.Union([
    Type.Literal('collection'),
    Type.Literal('place'),
    Type.Literal('track'),
    Type.Literal('setting'),
  ]),
  id: Type.String({ minLength: 1, maxLength: 512 }),
  updatedAt: Type.Number(),
  deleted: Type.Boolean(),
  // Arbitrary entity payload — never stripped (no additionalProperties:false).
  data: Type.Union([Type.Null(), Type.Object({}, { additionalProperties: true })]),
  partial: Type.Optional(Type.Boolean()),
});

const PushBodySchema = Type.Object({
  changes: Type.Array(SyncChangeSchema, { maxItems: MAX_CHANGES_PER_PUSH }),
  deviceId: Type.Optional(Type.String({ maxLength: 64 })),
});
type PushBody = Static<typeof PushBodySchema>;

const PullQuerySchema = Type.Object({
  since: Type.Optional(Type.Number({ minimum: 0 })),
  device: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CHANGES_PER_PUSH })),
});
type PullQuery = Static<typeof PullQuerySchema>;

const GarminConnectSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 254 }),
  password: Type.String({ minLength: 1, maxLength: 1024 }),
});
type GarminConnectBody = Static<typeof GarminConnectSchema>;
const GarminMfaSchema = Type.Object({ code: Type.String({ minLength: 1, maxLength: 32 }) });
type GarminMfaBody = Static<typeof GarminMfaSchema>;
const GarminCourseSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  profile: Type.Union([
    Type.Literal('run'),
    Type.Literal('bike'),
    Type.Literal('hike'),
    Type.Literal('foot'),
  ]),
  gpx: Type.String({ minLength: 20, maxLength: 4_000_000 }),
  deviceId: Type.Optional(Type.String({ pattern: '^\\d{1,20}$' })),
});
type GarminCourseBody = Static<typeof GarminCourseSchema>;
const GarminActivitiesQuery = Type.Object({
  start: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
});
type GarminActivitiesQuery = Static<typeof GarminActivitiesQuery>;

/**
 * Account + sync endpoints (Phase 5): JWT auth over the user store, plain REST
 * last-write-wins sync over the sync store. Registered only when the server
 * has a database and JWT secret — without them Atlas stays anonymous
 * local-only and these routes simply don't exist.
 */
export async function registerSyncApi(
  app: FastifyInstance,
  stores: Stores,
  jwtSecret: string,
  opts: SyncApiOptions = {},
): Promise<void> {
  await app.register(fastifyJwt, { secret: jwtSecret, sign: { expiresIn: '90d' } });

  const registration = resolveRegistrationMode(opts);
  if (registration === 'invite' && !opts.inviteCode) {
    throw new Error('REGISTRATION=invite requires REGISTRATION_INVITE_CODE');
  }
  const authLimit =
    opts.authRateLimit === false
      ? undefined
      : { rateLimit: opts.authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT };

  const signFor = (user: { id: string; email: string; tokenEpoch: number }) =>
    app.jwt.sign({ sub: user.id, email: user.email, epoch: user.tokenEpoch });

  /**
   * Verify the JWT, then confirm it still corresponds to a live account whose
   * token epoch has not moved past it. The extra lookup is what makes password
   * change and account deletion actually revoke sessions on other devices.
   */
  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const user = await stores.users.findUserById(request.user.sub);
    // Tokens minted before `epoch` existed carry undefined; those pre-date any
    // password change (epoch 0 for migrated rows), so they stay valid.
    if (!user || user.tokenEpoch > (request.user.epoch ?? 0)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  app.post<{ Body: AuthBody }>(
    '/api/auth/register',
    { schema: { body: AuthBodySchema }, attachValidation: true, config: authLimit },
    async (request, reply) => {
      if (registration === 'closed') {
        return reply.code(403).send({ error: 'registration is closed on this server' });
      }
      if (request.validationError) {
        return reply.code(400).send({ error: 'invalid email or password' });
      }
      if (registration === 'invite' && request.body.invite !== opts.inviteCode) {
        return reply.code(403).send({ error: 'invalid invite code' });
      }
      if (request.body.password.length < 8) {
        return reply.code(400).send({ error: 'password must be at least 8 characters' });
      }
      const email = request.body.email.trim().toLowerCase();
      const user = await stores.users.createUser(email, await hashPassword(request.body.password));
      if (!user) return reply.code(409).send({ error: 'account already exists' });
      return { token: signFor(user), email: user.email };
    },
  );

  app.post<{ Body: AuthBody }>(
    '/api/auth/login',
    { schema: { body: AuthBodySchema }, attachValidation: true, config: authLimit },
    async (request, reply) => {
      const user = request.validationError
        ? null
        : await stores.users.findUserByEmail(request.body.email.trim().toLowerCase());
      if (!user || !(await verifyPassword(request.body.password, user.passwordHash))) {
        return reply.code(401).send({ error: 'wrong email or password' });
      }
      return { token: signFor(user), email: user.email };
    },
  );

  app.get('/api/auth/me', { preHandler: requireAuth }, (request) => ({
    email: request.user.email,
  }));

  /**
   * Change password. Returns a fresh token for *this* device: bumping the
   * epoch invalidates the caller's own token too, so without the swap the user
   * would be signed out by their own password change.
   */
  app.post<{ Body: ChangePasswordBody }>(
    '/api/auth/password',
    {
      preHandler: requireAuth,
      schema: { body: ChangePasswordSchema },
      attachValidation: true,
      config: authLimit,
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.code(400).send({ error: 'invalid request' });
      }
      if (request.body.newPassword.length < 8) {
        return reply.code(400).send({ error: 'password must be at least 8 characters' });
      }
      const user = await stores.users.findUserById(request.user.sub);
      if (!user || !(await verifyPassword(request.body.currentPassword, user.passwordHash))) {
        return reply.code(401).send({ error: 'wrong password' });
      }
      // Strictly greater than the current epoch, never merely "now": two
      // changes inside one clock tick (or a clock that stepped backwards) must
      // still invalidate the previous token.
      const tokenEpoch = Math.max(Date.now(), user.tokenEpoch + 1);
      await stores.users.updatePassword(
        user.id,
        await hashPassword(request.body.newPassword),
        tokenEpoch,
      );
      return { token: signFor({ ...user, tokenEpoch }), email: user.email };
    },
  );

  /**
   * Delete the account and every synced record with it (password-confirmed).
   * Local data on each device is untouched — signing out is the client's job.
   */
  app.post<{ Body: DeleteAccountBody }>(
    '/api/auth/delete',
    {
      preHandler: requireAuth,
      schema: { body: DeleteAccountSchema },
      attachValidation: true,
      config: authLimit,
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.code(400).send({ error: 'invalid request' });
      }
      const user = await stores.users.findUserById(request.user.sub);
      if (!user || !(await verifyPassword(request.body.password, user.passwordHash))) {
        return reply.code(401).send({ error: 'wrong password' });
      }
      // Garmin refresh tokens grant access independently of Atlas's JWT.
      // Account deletion must remove the per-user token file as well.
      if (opts.garmin) await opts.garmin.disconnect(user.id);
      await stores.users.deleteUser(user.id);
      return { deleted: true };
    },
  );

  app.post<{ Body: PushBody }>(
    '/api/sync/push',
    {
      preHandler: requireAuth,
      bodyLimit: PUSH_BODY_LIMIT,
      schema: { body: PushBodySchema },
      attachValidation: true,
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.code(400).send({ error: 'invalid push payload' });
      }
      const deviceId = request.body.deviceId ?? '';
      // The schema mirrors SyncChange, minus `data`'s exact record type.
      // Stamps claiming to be implausibly far in the future are clamped —
      // one mis-set device clock must not permanently out-rank every later
      // edit from correctly configured devices (see @atlas/sync).
      const changes = clampFutureStamps(request.body.changes as SyncChange[], Date.now());
      const result = await stores.sync.apply(request.user.sub, deviceId, changes);
      // An empty push doubles as a backwards-compatible capability probe:
      // older servers accept it but omit this flag, so new clients keep
      // sending complete track records until the active backend confirms it
      // can materialize metadata-only changes.
      return changes.length === 0 ? { ...result, acceptsTrackMetadata: true as const } : result;
    },
  );

  app.get<{ Querystring: PullQuery }>(
    '/api/sync/pull',
    { preHandler: requireAuth, schema: { querystring: PullQuerySchema }, attachValidation: true },
    (request, reply) => {
      if (request.validationError) {
        return reply.code(400).send({ error: 'invalid pull query' });
      }
      const since = request.query.since ?? 0;
      const device = request.query.device ?? '';
      const limit = request.query.limit ?? 100;
      return stores.sync.changesSince(request.user.sub, since, device, limit);
    },
  );

  if (opts.garmin) {
    const garmin = opts.garmin;
    const upstreamError = (reply: FastifyReply) =>
      reply.code(502).send({ error: 'Garmin Connect is unavailable or needs reconnecting' });

    app.get('/api/garmin/status', { preHandler: requireAuth }, async (request, reply) => {
      try {
        return { connected: await garmin.status(request.user.sub) };
      } catch {
        return upstreamError(reply);
      }
    });

    app.post<{ Body: GarminConnectBody }>(
      '/api/garmin/connect',
      {
        preHandler: requireAuth,
        schema: { body: GarminConnectSchema },
        attachValidation: true,
        config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
      },
      async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'invalid credentials' });
        try {
          const state = await garmin.connect(
            request.user.sub,
            request.body.email,
            request.body.password,
          );
          return { connected: state === 'connected', mfaRequired: state === 'mfa' };
        } catch (error) {
          // Only Garmin's own refusal is a 401: a bridge that cannot start or reach
          // Garmin must not tell the user their password is wrong.
          if (error instanceof GarminAuthError) {
            return reply.code(401).send({ error: 'Garmin rejected the email or password' });
          }
          if (error instanceof GarminBridgeError) {
            return reply.code(502).send({ error: error.message });
          }
          return upstreamError(reply);
        }
      },
    );

    app.post<{ Body: GarminMfaBody }>(
      '/api/garmin/mfa',
      {
        preHandler: requireAuth,
        schema: { body: GarminMfaSchema },
        attachValidation: true,
        config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      },
      async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'invalid code' });
        try {
          await garmin.completeMfa(request.user.sub, request.body.code);
          return { connected: true };
        } catch (error) {
          if (error instanceof GarminAuthError || error instanceof GarminSignInExpiredError) {
            return reply.code(401).send({ error: 'Garmin code was rejected or sign-in expired' });
          }
          return upstreamError(reply);
        }
      },
    );

    app.post('/api/garmin/disconnect', { preHandler: requireAuth }, async (request, reply) => {
      try {
        await garmin.disconnect(request.user.sub);
        return { connected: false };
      } catch {
        return upstreamError(reply);
      }
    });

    app.post<{ Body: GarminCourseBody }>(
      '/api/garmin/course',
      {
        preHandler: requireAuth,
        bodyLimit: 4_200_000,
        schema: { body: GarminCourseSchema },
        attachValidation: true,
      },
      async (request, reply) => {
        if (
          request.validationError ||
          !request.body.name.trim() ||
          /<!DOCTYPE|<!ENTITY/i.test(request.body.gpx)
        ) {
          return reply.code(400).send({ error: 'invalid GPX course' });
        }
        try {
          const data = parseGpx(request.body.gpx);
          if (data.segments.every((segment) => segment.length < 2)) {
            return reply.code(400).send({ error: 'GPX course needs at least two points' });
          }
        } catch {
          return reply.code(400).send({ error: 'invalid GPX course' });
        }
        try {
          return await garmin.uploadCourse(
            request.user.sub,
            request.body.name.trim(),
            request.body.profile,
            request.body.gpx,
            request.body.deviceId,
          );
        } catch {
          return upstreamError(reply);
        }
      },
    );

    app.get('/api/garmin/devices', { preHandler: requireAuth }, async (request, reply) => {
      try {
        return { devices: await garmin.devices(request.user.sub) };
      } catch {
        return upstreamError(reply);
      }
    });

    app.get<{ Querystring: GarminActivitiesQuery }>(
      '/api/garmin/activities',
      {
        preHandler: requireAuth,
        schema: { querystring: GarminActivitiesQuery },
        attachValidation: true,
      },
      async (request, reply) => {
        if (request.validationError)
          return reply.code(400).send({ error: 'invalid activity offset' });
        try {
          return {
            activities: await garmin.activities(request.user.sub, request.query.start ?? 0),
          };
        } catch {
          return upstreamError(reply);
        }
      },
    );

    app.get<{ Params: { id: string } }>(
      '/api/garmin/activities/:id/gpx',
      { preHandler: requireAuth },
      async (request, reply) => {
        if (!/^\d{1,20}$/.test(request.params.id)) {
          return reply.code(400).send({ error: 'invalid activity id' });
        }
        try {
          return { gpx: await garmin.activityGpx(request.user.sub, request.params.id) };
        } catch {
          return upstreamError(reply);
        }
      },
    );
  }
}
