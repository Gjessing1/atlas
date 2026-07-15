import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { APP_NAME } from '@atlas/core';
import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/api/health', () => ({
  status: 'ok',
  app: APP_NAME,
  gitSha: process.env.GIT_SHA || 'dev',
}));

// In production the built web app is copied to backend/public (see backend/Dockerfile)
// and served same-origin. In dev, Vite serves the web app and proxies /api here.
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
if (existsSync(publicDir)) {
  await app.register(fastifyStatic, { root: publicDir });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    // SPA fallback: client-side routes all resolve to the app shell.
    return reply.sendFile('index.html');
  });
}

// Default 3100: port 3000 is taken by Forgejo on this host.
const port = Number(process.env.PORT || 3100);
await app.listen({ port, host: '0.0.0.0' });
