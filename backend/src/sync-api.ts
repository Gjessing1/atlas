import fastifyJwt from '@fastify/jwt';
import type { SyncChange, SyncEntity } from '@atlas/storage';
import type { AuthCredentials, SyncPushRequest } from '@atlas/sync';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword } from './passwords.js';
import type { Stores } from './stores.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

const ENTITIES: ReadonlySet<string> = new Set<SyncEntity>([
  'collection',
  'place',
  'track',
  'setting',
]);

const MAX_CHANGES_PER_PUSH = 500;
/** GPX documents ride inside push payloads; allow well beyond typical track sizes. */
const PUSH_BODY_LIMIT = 32 * 1024 * 1024;

function isValidChange(c: unknown): c is SyncChange {
  if (typeof c !== 'object' || c === null) return false;
  const v = c as Record<string, unknown>;
  return (
    typeof v['entity'] === 'string' &&
    ENTITIES.has(v['entity']) &&
    typeof v['id'] === 'string' &&
    v['id'].length > 0 &&
    v['id'].length <= 512 &&
    typeof v['updatedAt'] === 'number' &&
    Number.isFinite(v['updatedAt']) &&
    typeof v['deleted'] === 'boolean' &&
    (v['data'] === null || (typeof v['data'] === 'object' && !Array.isArray(v['data'])))
  );
}

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

  const credentials = (body: unknown): { email: string; password: string } | null => {
    const { email, password } = (body ?? {}) as Partial<AuthCredentials>;
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!/^\S+@\S+\.\S+$/.test(normalized) || normalized.length > 254) return null;
    if (typeof password !== 'string') return null;
    return { email: normalized, password };
  };

  app.post('/api/auth/register', async (request, reply) => {
    const creds = credentials(request.body);
    if (!creds) return reply.code(400).send({ error: 'invalid email or password' });
    if (creds.password.length < 8) {
      return reply.code(400).send({ error: 'password must be at least 8 characters' });
    }
    const user = await stores.users.createUser(creds.email, await hashPassword(creds.password));
    if (!user) return reply.code(409).send({ error: 'account already exists' });
    return { token: app.jwt.sign({ sub: user.id, email: user.email }), email: user.email };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const creds = credentials(request.body);
    const user = creds ? await stores.users.findUserByEmail(creds.email) : null;
    if (!user || !(await verifyPassword(creds!.password, user.passwordHash))) {
      return reply.code(401).send({ error: 'wrong email or password' });
    }
    return { token: app.jwt.sign({ sub: user.id, email: user.email }), email: user.email };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, (request) => ({
    email: request.user.email,
  }));

  app.post(
    '/api/sync/push',
    { preHandler: requireAuth, bodyLimit: PUSH_BODY_LIMIT },
    async (request, reply) => {
      const body = request.body as Partial<SyncPushRequest> | null;
      const changes = Array.isArray(body?.changes) ? body.changes : null;
      const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
      if (!changes || changes.length > MAX_CHANGES_PER_PUSH || !changes.every(isValidChange)) {
        return reply.code(400).send({ error: 'invalid push payload' });
      }
      return stores.sync.apply(request.user.sub, deviceId, changes);
    },
  );

  app.get<{
    Querystring: { since?: string; device?: string; limit?: string };
  }>('/api/sync/pull', { preHandler: requireAuth }, (request) => {
    const since = Math.max(Number(request.query.since) || 0, 0);
    const device = (request.query.device ?? '').slice(0, 64);
    const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), MAX_CHANGES_PER_PUSH);
    return stores.sync.changesSince(request.user.sub, since, device, limit);
  });
}
