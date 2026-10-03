import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface } from 'node:readline';

export type GarminProfile = 'run' | 'bike' | 'hike' | 'foot';
export interface GarminActivity {
  id: string;
  name: string;
  date: string | null;
  type: string | null;
  hasRoute?: boolean;
}
export interface GarminDevice {
  id: string;
  name: string;
}
type Reply = Record<string, unknown>;

class Worker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly queue: string[] = [];
  private waiting: ((line: string) => void) | null = null;
  private failed: ((error: Error) => void) | null = null;
  private closed = false;

  constructor(python: string, script: string) {
    this.child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Upstream diagnostics may contain account details. Drain without logging.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.close());
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      if (this.waiting) {
        const take = this.waiting;
        this.waiting = null;
        this.failed = null;
        take(line);
      } else this.queue.push(line);
    });
    this.child.on('error', () => this.close());
    this.child.on('exit', () => this.close());
  }

  private close(): void {
    this.closed = true;
    this.failed?.(new Error('Garmin connection ended unexpectedly'));
    this.waiting = null;
    this.failed = null;
  }

  async request(value: Record<string, unknown>, timeoutMs = 30_000): Promise<Reply> {
    if (this.closed) throw new Error('Garmin connection ended unexpectedly');
    const response = new Promise<string>((resolve, reject) => {
      const queued = this.queue.shift();
      if (queued !== undefined) resolve(queued);
      else {
        this.waiting = resolve;
        this.failed = reject;
      }
    });
    this.child.stdin.write(JSON.stringify(value) + '\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        response,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Garmin Connect timed out')), timeoutMs);
        }),
      ]);
      const reply = JSON.parse(raw) as Reply;
      if (typeof reply['error'] === 'string') throw new Error(reply['error']);
      return reply;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  stop(): void {
    this.child.kill();
    this.lines.close();
  }
}

/** The server owns Garmin tokens per Atlas account; credentials never enter an app database. */
export class GarminBridge {
  private readonly script = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../garmin/bridge.py',
  );
  private readonly pending = new Map<
    string,
    { worker: Worker; expires: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly dataDir: string,
    private readonly python = process.env.GARMIN_PYTHON || '/opt/garmin-venv/bin/python',
  ) {}

  private tokenFile(userId: string): string {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(userId)) {
      throw new Error('Invalid account');
    }
    return path.join(this.dataDir, 'garmin', userId, 'garmin_tokens.json');
  }

  private async run(
    userId: string,
    action: string,
    extra: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<Reply> {
    const worker = new Worker(this.python, this.script);
    try {
      return await worker.request({ dataDir: this.dataDir, userId, action, ...extra }, timeoutMs);
    } finally {
      worker.stop();
    }
  }

  async status(userId: string): Promise<boolean> {
    try {
      await access(this.tokenFile(userId));
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(userId: string): Promise<void> {
    this.clearPending(userId);
    await unlink(this.tokenFile(userId)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  async connect(userId: string, email: string, password: string): Promise<'connected' | 'mfa'> {
    this.clearPending(userId);
    await this.disconnect(userId);
    const worker = new Worker(this.python, this.script);
    try {
      const response = await worker.request(
        { dataDir: this.dataDir, userId, action: 'connect', email, password },
        60_000,
      );
      if (response['connected'] === true) return 'connected';
      if (response['mfaRequired'] !== true) throw new Error('Garmin did not confirm sign-in');
      const expires = setTimeout(() => this.clearPending(userId), 5 * 60_000);
      this.pending.set(userId, { worker, expires });
      return 'mfa';
    } finally {
      if (!this.pending.has(userId)) worker.stop();
    }
  }

  async completeMfa(userId: string, code: string): Promise<void> {
    const pending = this.pending.get(userId);
    if (!pending) throw new Error('Garmin sign-in expired; start again');
    try {
      const response = await pending.worker.request({ code }, 60_000);
      if (response['connected'] !== true) throw new Error('Garmin did not confirm sign-in');
    } finally {
      this.clearPending(userId);
    }
  }

  private clearPending(userId: string): void {
    const pending = this.pending.get(userId);
    if (!pending) return;
    clearTimeout(pending.expires);
    pending.worker.stop();
    this.pending.delete(userId);
  }

  async uploadCourse(
    userId: string,
    name: string,
    profile: GarminProfile,
    gpx: string,
    deviceId?: string,
  ): Promise<{ id: number; url: string; queued: boolean }> {
    const result = await this.run(userId, 'uploadCourse', { name, profile, gpx, deviceId }, 90_000);
    if (typeof result['id'] !== 'number' || typeof result['url'] !== 'string') {
      throw new Error('Garmin did not confirm the course');
    }
    return { id: result['id'], url: result['url'], queued: result['queued'] === true };
  }

  async devices(userId: string): Promise<GarminDevice[]> {
    const result = await this.run(userId, 'devices');
    if (!Array.isArray(result['devices'])) throw new Error('Invalid Garmin device response');
    return result['devices'] as GarminDevice[];
  }

  async activities(userId: string, start = 0): Promise<GarminActivity[]> {
    const result = await this.run(userId, 'activities', { start });
    if (!Array.isArray(result['activities'])) throw new Error('Invalid Garmin activity response');
    return result['activities'] as GarminActivity[];
  }

  async activityGpx(userId: string, id: string): Promise<string> {
    const result = await this.run(userId, 'activityGpx', { id });
    if (typeof result['gpx'] !== 'string') throw new Error('Garmin did not return GPX');
    return result['gpx'];
  }
}
