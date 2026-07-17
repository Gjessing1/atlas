import fastifyJwt from '@fastify/jwt';
import { Type, type Static } from '@sinclair/typebox';
import type { SyncChange } from '@atlas/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword } from './passwords.js';
import type { Stores } from './stores.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
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
});
type AuthBody = Static<typeof AuthBodySchema>;

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
): Promise<void> {
  await app.register(fastifyJwt, { secret: jwtSecret, sign: { expiresIn: '90d' } });

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  app.post<{ Body: AuthBody }>(
    '/api/auth/register',
    { schema: { body: AuthBodySchema }, attachValidation: true },
    async (request, reply) => {
      if (request.validationError) {
        return reply.code(400).send({ error: 'invalid email or password' });
      }
      if (request.body.password.length < 8) {
        return reply.code(400).send({ error: 'password must be at least 8 characters' });
      }
      const email = request.body.email.trim().toLowerCase();
      const user = await stores.users.createUser(email, await hashPassword(request.body.password));
      if (!user) return reply.code(409).send({ error: 'account already exists' });
      return { token: app.jwt.sign({ sub: user.id, email: user.email }), email: user.email };
    },
  );

  app.post<{ Body: AuthBody }>(
    '/api/auth/login',
    { schema: { body: AuthBodySchema }, attachValidation: true },
    async (request, reply) => {
      const user = request.validationError
        ? null
        : await stores.users.findUserByEmail(request.body.email.trim().toLowerCase());
      if (!user || !(await verifyPassword(request.body.password, user.passwordHash))) {
        return reply.code(401).send({ error: 'wrong email or password' });
      }
      return { token: app.jwt.sign({ sub: user.id, email: user.email }), email: user.email };
    },
  );

  app.get('/api/auth/me', { preHandler: requireAuth }, (request) => ({
    email: request.user.email,
  }));

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
      const changes = request.body.changes as SyncChange[];
      return stores.sync.apply(request.user.sub, deviceId, changes);
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
}
