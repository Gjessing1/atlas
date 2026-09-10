import { randomBytes } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const MAX_LOG_BYTES = 20 * 1024 * 1024;
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

export interface DiagnosticsApiOptions {
  now?: () => number;
  makeReference?: () => string;
}

function reference(): string {
  const raw = randomBytes(5).toString('hex').toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function validNavigationLog(body: string): boolean {
  const lines = body.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  try {
    return lines.every((line) => {
      const record = JSON.parse(line) as unknown;
      return (
        typeof record === 'object' &&
        record !== null &&
        typeof (record as { event?: unknown }).event === 'string'
      );
    });
  } catch {
    return false;
  }
}

async function removeExpired(dir: string, nowMs: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const file = path.join(dir, name);
        try {
          if (nowMs - (await stat(file)).mtimeMs > RETAIN_MS) await unlink(file);
        } catch {
          // A concurrent cleanup/upload may have removed it already.
        }
      }),
  );
}

/**
 * User-triggered navigation-log intake. There is deliberately no download
 * route: exact GPS history is private support material, not a public paste.
 */
export function registerDiagnosticsApi(
  app: FastifyInstance,
  dataDir: string,
  options: DiagnosticsApiOptions = {},
): void {
  const dir = path.join(dataDir, 'diagnostics');
  const now = options.now ?? Date.now;
  const makeReference = options.makeReference ?? reference;

  app.post<{ Body: string }>(
    '/api/diagnostics/navigation',
    {
      bodyLimit: MAX_LOG_BYTES,
      // Generous enough for a phone with auto-upload on: one POST per finished
      // trip, plus the retries a drive that ended out of coverage leaves
      // pending. Still low enough that this route cannot be used as storage.
      config: { rateLimit: { max: 40, timeWindow: '1 hour' } },
    },
    async (request, reply: FastifyReply) => {
      if (typeof request.body !== 'string' || !validNavigationLog(request.body)) {
        return reply.code(400).send({ error: 'invalid navigation diagnostic log' });
      }
      await mkdir(dir, { recursive: true });
      await removeExpired(dir, now());

      // `wx` makes the short support reference collision-safe without exposing
      // filesystem paths or allowing a caller to choose a filename.
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = makeReference();
        const filename = `${id.replaceAll('-', '')}.jsonl`;
        try {
          await writeFile(path.join(dir, filename), request.body, { flag: 'wx', mode: 0o600 });
          request.log.info(
            { reference: id, bytes: Buffer.byteLength(request.body) },
            'diagnostics uploaded',
          );
          return reply.code(201).send({ reference: id });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      throw new Error('could not allocate diagnostics reference');
    },
  );
}
