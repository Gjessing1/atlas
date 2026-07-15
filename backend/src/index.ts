import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// In the container this is /data (bind-mounted from /mnt/data/atlas on the host).
// In dev, point ATLAS_DATA_DIR at the host data dir or symlink backend/data to it.
const dataDir = process.env.ATLAS_DATA_DIR || path.resolve(here, '../data');
const publicDir = path.resolve(here, '../public');

const app = await buildApp({
  dataDir,
  publicDir: existsSync(publicDir) ? publicDir : undefined,
  logger: true,
});

// Default 3100: port 3000 is taken by Forgejo on this host.
const port = Number(process.env.PORT || 3100);
await app.listen({ port, host: '0.0.0.0' });
