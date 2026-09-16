import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { tilePixelAt } from '@atlas/conditions';

import type { StatusRegistry } from './status.js';

/**
 * A day of MET radar, kept by Atlas because MET does not keep it.
 *
 * yr-maps publishes only its current run: radar observations reach back ~90
 * minutes, and a run's tiles stop answering within hours of being replaced
 * (measured 2026-09-16: a 17:36 run was 404 by 22:00, at every zoom). So a
 * precipitation timeline that goes back a day has to be written down as it
 * happens. Every few minutes this reads the live catalog and stores one frame
 * per `everyMs` — the upstream PNG tiles over the radar composite's bounds, at
 * every zoom the painter reads — and forgets frames older than `keepMs`.
 *
 * The stored tiles are MET's data PNGs, byte for byte, so the backend paints an
 * archived frame exactly as it paints a live one. One radar frame is ~135 tiles
 * and ~0.4 MB (dry night) to a few MB (a wet day); at a quarter-hour that is
 * ~96 frames and ~13 000 upstream requests a day.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const YR_MAPS_URL = 'https://prod.yr-maps.met.no/api';
/** MET asks for an identifying User-Agent; the archive and the live maps send the same one. */
export const METNO_MAPS_USER_AGENT =
  'atlas-maps/1.0 git.gjessing.io/gjessing1/atlas lars@gjessing.io';

export interface ArchiveDataset {
  /** yr-maps dataset name. */
  name: string;
  /** One frame per this interval, on the clock (…:00, :15, :30, :45 for 15 min). */
  everyMs: number;
  /** Deepest zoom stored. The painter reads this zoom for anything deeper. */
  maxzoom: number;
  /** Only frames at or before now are archived: history, not forecasts. */
  pastOnly: boolean;
}

export const RADAR_ARCHIVE_DATASET = 'precipitation-observations';
export const TEMPERATURE_ARCHIVE_DATASET = 'air-temperature';

export const WEATHER_ARCHIVE_DATASETS: readonly ArchiveDataset[] = [
  { name: RADAR_ARCHIVE_DATASET, everyMs: 15 * MINUTE, maxzoom: 6, pastOnly: true },
  // An archived radar picture still needs its snow/rain phase, which the
  // painter takes from the air temperature nearest in time.
  { name: TEMPERATURE_ARCHIVE_DATASET, everyMs: HOUR, maxzoom: 5, pastOnly: true },
];

export interface ArchivedFrame {
  dataset: string;
  /** Validity time, ISO-8601 UTC. */
  time: string;
  ms: number;
  /** Directory name, also the frame's stable key. */
  stamp: string;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
}

export interface WeatherArchive {
  /** Stored frames of a dataset inside the keep window, oldest first. */
  frames(dataset: string): Promise<ArchivedFrame[]>;
  /** A stored tile's PNG bytes; null where MET had none. */
  tile(
    frame: Pick<ArchivedFrame, 'dataset' | 'stamp'>,
    z: number,
    x: number,
    y: number,
  ): Promise<Buffer | null>;
  /** One capture-and-prune pass. Never throws. */
  capture(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface WeatherArchiveOptions {
  dir: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  now?: () => number;
  status?: StatusRegistry;
  log?: { warn: (obj: unknown, msg?: string) => void };
  keepMs?: number;
  intervalMs?: number;
  datasets?: readonly ArchiveDataset[];
  /** Upstream tile fetches at a time. MET's CDN is shared; be polite. */
  concurrency?: number;
}

interface YrDataset {
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  times: { time: string; tiles: { png?: string } }[];
}

/** `20260916T2030Z` — sortable, filesystem-safe, and the frame's key. */
export function archiveStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, '') + 'Z';
}

function stampMs(stamp: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(stamp);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi] = match.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!);
}

/** Every tile of the bounds at one zoom. */
export function tilesCovering(
  bounds: [number, number, number, number],
  z: number,
): { x: number; y: number }[] {
  const [w, s, e, n] = bounds;
  const nw = tilePixelAt(w, n, z);
  const se = tilePixelAt(e, s, z);
  const out: { x: number; y: number }[] = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({ x, y });
  return out;
}

function validDataset(value: unknown): YrDataset | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<YrDataset>;
  if (
    !Array.isArray(raw.bounds) ||
    raw.bounds.length !== 4 ||
    !raw.bounds.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    typeof raw.minzoom !== 'number' ||
    typeof raw.maxzoom !== 'number' ||
    !Array.isArray(raw.times)
  ) {
    return null;
  }
  return raw as YrDataset;
}

/** Only MET's own map host with the three placeholders ever becomes a fetch. */
function safeTemplate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    if (new URL(raw).origin !== new URL(YR_MAPS_URL).origin) return null;
  } catch {
    return null;
  }
  return raw.includes('{z}') && raw.includes('{x}') && raw.includes('{y}') ? raw : null;
}

/**
 * `work` over `items`, `size` at a time. The first failure stops new work and is
 * thrown only once every running item has finished, so a caller cleaning up
 * after a failure never races a write still in flight.
 */
async function inBatches<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  // An array, not a `let`: the workers write it from closures TypeScript cannot follow.
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (failures.length === 0 && next < items.length) {
        try {
          await work(items[next++]!);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length > 0) throw failures[0];
}

export function createWeatherArchive(options: WeatherArchiveOptions): WeatherArchive {
  const fetchImpl = options.fetchImpl ?? fetch;
  const userAgent = options.userAgent ?? process.env.METNO_USER_AGENT ?? METNO_MAPS_USER_AGENT;
  const now = options.now ?? Date.now;
  const keepMs = options.keepMs ?? 24 * HOUR + 30 * MINUTE;
  const intervalMs = options.intervalMs ?? 5 * MINUTE;
  const datasets = options.datasets ?? WEATHER_ARCHIVE_DATASETS;
  const concurrency = options.concurrency ?? 4;
  const PROBE = 'weather-archive';
  options.status?.register(PROBE, 'Radar history (24 h)', 'Weather');

  /** dataset → stamp → frame. */
  const index = new Map<string, Map<string, ArchivedFrame>>();
  let loaded: Promise<void> | null = null;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;

  const datasetDir = (name: string) => path.join(options.dir, name);

  function load(): Promise<void> {
    loaded ??= (async () => {
      for (const dataset of datasets) {
        const frames = new Map<string, ArchivedFrame>();
        index.set(dataset.name, frames);
        let entries: string[] = [];
        try {
          entries = await readdir(datasetDir(dataset.name));
        } catch {
          continue;
        }
        for (const stamp of entries) {
          if (!Number.isFinite(stampMs(stamp))) continue;
          try {
            const frame = JSON.parse(
              await readFile(path.join(datasetDir(dataset.name), stamp, 'frame.json'), 'utf8'),
            ) as ArchivedFrame;
            if (frame.stamp === stamp && frame.dataset === dataset.name) frames.set(stamp, frame);
          } catch {
            // No frame.json: a capture that never finished. Pruned below.
          }
        }
      }
    })();
    return loaded;
  }

  async function fetchDataset(name: string): Promise<YrDataset | null> {
    const res = await fetchImpl(`${YR_MAPS_URL}/${name}/available.json`, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`yr-maps ${name} available.json ${res.status}`);
    return validDataset(await res.json());
  }

  /** Stores one frame whole, or not at all. */
  async function store(
    dataset: ArchiveDataset,
    ms: number,
    template: string,
    bounds: [number, number, number, number],
    minzoom: number,
    maxzoom: number,
  ): Promise<ArchivedFrame> {
    const stamp = archiveStamp(ms);
    const finalDir = path.join(datasetDir(dataset.name), stamp);
    const partialDir = `${finalDir}.partial`;
    await rm(partialDir, { recursive: true, force: true });
    const tiles: { z: number; x: number; y: number }[] = [];
    for (let z = minzoom; z <= maxzoom; z++) {
      for (const tile of tilesCovering(bounds, z)) tiles.push({ z, ...tile });
    }
    try {
      await inBatches(tiles, concurrency, async ({ z, x, y }) => {
        const url = template
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(y));
        const res = await fetchImpl(url, {
          headers: { 'User-Agent': userAgent, Accept: 'image/png' },
          signal: AbortSignal.timeout(15_000),
        });
        // No tile is MET's way of saying "no data here": remember it as absent.
        if (res.status === 404 || res.status === 204) return;
        if (!res.ok) throw new Error(`yr-maps tile ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        const file = path.join(partialDir, String(z), String(x), `${y}.png`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes);
      });
      const frame: ArchivedFrame = {
        dataset: dataset.name,
        time: new Date(ms).toISOString(),
        ms,
        stamp,
        bounds,
        minzoom,
        maxzoom,
      };
      await mkdir(partialDir, { recursive: true });
      // Written last: its presence is what makes a directory a frame.
      await writeFile(path.join(partialDir, 'frame.json'), JSON.stringify(frame));
      await rm(finalDir, { recursive: true, force: true });
      await rename(partialDir, finalDir);
      return frame;
    } catch (error) {
      await rm(partialDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Runs inside a pass, after its captures: a partial directory left now is a crashed one. */
  async function prune(): Promise<void> {
    const cutoff = now() - keepMs;
    for (const dataset of datasets) {
      let entries: string[] = [];
      try {
        entries = await readdir(datasetDir(dataset.name));
      } catch {
        continue;
      }
      const frames = index.get(dataset.name);
      for (const entry of entries) {
        const partial = entry.endsWith('.partial');
        const stamp = partial ? entry.slice(0, -'.partial'.length) : entry;
        const ms = stampMs(stamp);
        if (!Number.isFinite(ms)) continue;
        if (!partial && ms >= cutoff && frames?.has(stamp)) continue;
        await rm(path.join(datasetDir(dataset.name), entry), { recursive: true, force: true });
        if (!partial) frames?.delete(stamp);
      }
    }
  }

  async function pass(): Promise<void> {
    await load();
    const at = now();
    let bounds: [number, number, number, number] | null = null;
    const failures: string[] = [];
    // Radar first: every dataset is kept over the radar composite's bounds
    // (history is a radar feature, and a global temperature archive would be
    // most of a disk), so without its catalog nothing else is captured.
    const ordered = [...datasets].sort(
      (a, b) => Number(b.name === RADAR_ARCHIVE_DATASET) - Number(a.name === RADAR_ARCHIVE_DATASET),
    );
    for (const dataset of ordered) {
      try {
        const live = await fetchDataset(dataset.name);
        if (!live) throw new Error(`yr-maps ${dataset.name} catalog unreadable`);
        if (dataset.name === RADAR_ARCHIVE_DATASET) bounds = live.bounds;
        if (!bounds) throw new Error('no radar bounds to archive within');
        const frames = index.get(dataset.name) ?? new Map<string, ArchivedFrame>();
        index.set(dataset.name, frames);
        for (const entry of live.times) {
          const ms = Date.parse(entry.time);
          if (!Number.isFinite(ms) || ms % dataset.everyMs !== 0) continue;
          if (ms < at - keepMs || (dataset.pastOnly && ms > at)) continue;
          if (frames.has(archiveStamp(ms))) continue;
          const template = safeTemplate(entry.tiles?.png);
          if (!template) continue;
          const frame = await store(
            dataset,
            ms,
            template,
            bounds,
            Math.max(0, live.minzoom),
            Math.min(dataset.maxzoom, live.maxzoom),
          );
          frames.set(frame.stamp, frame);
        }
      } catch (error) {
        failures.push(dataset.name);
        options.log?.warn({ err: error, dataset: dataset.name }, 'weather archive capture failed');
      }
    }
    await prune().catch((error) =>
      options.log?.warn({ err: error }, 'weather archive prune failed'),
    );
    options.status?.record(
      PROBE,
      failures.length === 0,
      failures.length > 0 ? `capture failed: ${failures.join(', ')}` : undefined,
    );
    // How far back the timeline can reach right now: what a stalled archive
    // shows first, since a pass that stores nothing still succeeds.
    const radar = [...(index.get(RADAR_ARCHIVE_DATASET)?.values() ?? [])];
    const oldest = Math.min(...radar.map((frame) => frame.ms));
    const newest = Math.max(...radar.map((frame) => frame.ms));
    options.status?.setDetail(
      PROBE,
      radar.length === 0
        ? 'no radar frames kept yet'
        : `${radar.length} radar frames, ${((at - oldest) / HOUR).toFixed(1)} h back, newest ${Math.round((at - newest) / MINUTE)} min old`,
    );
  }

  const archive: WeatherArchive = {
    async frames(dataset) {
      await load();
      const cutoff = now() - keepMs;
      return [...(index.get(dataset)?.values() ?? [])]
        .filter((frame) => frame.ms >= cutoff)
        .sort((a, b) => a.ms - b.ms);
    },
    async tile(frame, z, x, y) {
      if (!Number.isFinite(stampMs(frame.stamp))) return null;
      if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0)) return null;
      try {
        return await readFile(
          path.join(datasetDir(frame.dataset), frame.stamp, String(z), String(x), `${y}.png`),
        );
      } catch {
        return null;
      }
    },
    capture() {
      running ??= pass()
        .catch((error) => options.log?.warn({ err: error }, 'weather archive pass failed'))
        .finally(() => {
          running = null;
        });
      return running;
    },
    start() {
      if (timer) return;
      // Not at boot: the first pass downloads a few hundred tiles.
      first = setTimeout(() => void archive.capture(), 20_000);
      first.unref?.();
      timer = setInterval(() => void archive.capture(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
  return archive;
}
