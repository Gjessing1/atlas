import { createHash } from 'node:crypto';

import {
  AURORA_FORECAST_ID,
  closestFrameIndex,
  FROZEN_PRECIPITATION_MAX_C,
  LIGHTNING_BOUNDS,
  LIGHTNING_OBSERVATIONS_ID,
  lightningWindow,
  legendRowSwatches,
  normalizeMetAlerts,
  paintAuroraTile,
  paintWeatherTile,
  parseOvation,
  parseUalf,
  tilePixelAt,
  weatherGridZoom,
  weatherMapLegend,
  WEATHER_FIELD_GROUP,
  WEATHER_MAP_LAYER_IDS,
  WEATHER_MAP_LAYER_SPECS,
  WEATHER_TILE_OVERZOOM,
  WEATHER_WARNINGS_ID,
  weatherOverlayId,
  weatherTileFootprint,
  weatherValueAt,
  windFromDeg,
  windSpeed,
  asWeatherMapLayerId,
  type WeatherGridResponse,
  type WeatherMapFrame,
  type WeatherMapFrameKind,
  type WeatherMapLayer,
  type WeatherMapLayerId,
  type WeatherMapLegendStop,
  type WeatherMapsResponse,
  type WeatherMapTimeline,
  type WeatherMapTimelineId,
  type WeatherPointSample,
  type WeatherMosaic,
  type WeatherRaster,
  type LightningResponse,
  type OvationGrid,
  type AuroraForecastStatus,
} from '@atlas/conditions';
import type { LayerMeta } from '@atlas/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PNG } from 'pngjs';

import type { StatusRegistry } from './status.js';
import {
  METNO_MAPS_USER_AGENT,
  RADAR_ARCHIVE_DATASET,
  TEMPERATURE_ARCHIVE_DATASET,
  type ArchivedFrame,
  type WeatherArchive,
} from './weather-archive.js';

/**
 * Animated weather layers: MET Norway's map data (the tiles behind yr.no's
 * map), decoded and painted here so both clients can draw an ordinary raster.
 *
 * - `GET /api/weather/maps` — every layer's timelines (radar and forecast), with
 *   frame ids that change whenever MET publishes a new run, so a frame's tiles
 *   never change under its URL.
 * - `GET /api/weather/maps/:layer/:frame/:z/:x/:y.png` — one painted tile.
 * - `GET /api/weather/maps/:layer/:frame/grid` — values over a viewport, for the
 *   wind particles, wind arrows and temperature numbers.
 * - `GET /api/weather/maps/point` — every layer at one place and time (the tap card).
 * - `GET /api/overlay/weather-<layer>/:z/:x/:y.png` — the frame nearest now, for
 *   a client that draws the catalog row as a plain raster.
 * - `GET /api/overlay/weather-warnings/features` — MET's live CAP warnings.
 *
 * What the pixels mean, and the colours, live in `@atlas/conditions`
 * (weather-maps.ts); this module fetches, caches and serves.
 */

const YR_MAPS_URL = 'https://prod.yr-maps.met.no/api';
const METALERTS_URL = 'https://api.met.no/weatherapi/metalerts/2.0/current.json?lang=en';
const FROST_LIGHTNING_URL = 'https://frost.met.no/lightning/v0.ualf';
const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const VIIRS_LIGHTS_TEMPLATE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Night_Lights/default/' +
  '2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
const ATTRIBUTION = 'Weather maps © MET Norway (CC BY 4.0)';
/**
 * Bump when the painting changes: it rides on every tile URL, because the frame
 * ids alone stay the same for the same upstream run and browsers keep tiles.
 */
const PAINT_REV = 3;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface SourceDataset {
  name: string;
  kind: WeatherMapFrameKind;
}

/** Upstream datasets behind each layer's timelines. Radar splices observations into nowcast. */
const MAP_SOURCES: Record<
  WeatherMapLayerId,
  Partial<Record<WeatherMapTimelineId, readonly SourceDataset[]>>
> = {
  precipitation: {
    radar: [
      { name: 'precipitation-nowcast', kind: 'nowcast' },
      { name: 'precipitation-observations', kind: 'observation' },
    ],
    forecast: [{ name: 'precipitation-amount', kind: 'forecast' }],
  },
  temperature: { forecast: [{ name: 'air-temperature', kind: 'forecast' }] },
  wind: { forecast: [{ name: 'wind', kind: 'forecast' }] },
  clouds: { forecast: [{ name: 'cloud-area-fraction', kind: 'forecast' }] },
  'sea-temperature': { forecast: [{ name: 'sea-temperature', kind: 'forecast' }] },
};

/** How far back and forward each timeline reaches from now in MET's live catalog: Yr's ±90 minutes of radar. */
const WINDOWS: Record<WeatherMapTimelineId, readonly [number, number]> = {
  radar: [-95 * MINUTE, 125 * MINUTE],
  forecast: [-60 * MINUTE, 72 * HOUR],
};

/** How far back the radar timeline reaches when the archive (weather-archive.ts) has kept the pictures. */
const RADAR_HISTORY_MS = 24 * HOUR;

/** Frames further than this from a requested time are not the weather at that time. */
const POINT_TOLERANCE: Record<WeatherMapTimelineId, number> = {
  radar: 8 * MINUTE,
  forecast: 90 * MINUTE,
};

const CATALOG_TTL_MS = 4 * MINUTE;
const ALERTS_TTL_MS = 5 * MINUTE;
const DECODED_CACHE_ENTRIES = 96;
const PAINTED_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_GRID = 160;
/** Short: the newest strikes pulse for their first minute, so a minute of caching would hide it. */
const LIGHTNING_TTL_MS = 20_000;
const AURORA_TTL_MS = 5 * MINUTE;

export interface WeatherMapsApiOptions {
  userAgent?: string;
  fetchImpl?: typeof fetch;
  status?: StatusRegistry;
  now?: () => number;
  /** Frost credentials stay server-side. Open lightning needs the client id only. */
  frostClientId?: string;
  /** A day of radar kept on disk; without it the radar timeline is MET's live 90 minutes. */
  archive?: WeatherArchive;
}

interface YrMapDataset {
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  times: { time: string; tiles: { png?: string; webp?: string } }[];
}

/** A frame as the server knows it: where its pixels come from. */
interface FrameSource {
  layer: WeatherMapLayerId;
  timeline: WeatherMapTimelineId;
  frame: WeatherMapFrame;
  /** Validated upstream PNG template. */
  upstream: string;
  minzoom: number;
  maxzoom: number;
  /** Served from the archive rather than MET's live catalog. */
  archived?: boolean;
}

/** An archived frame's tiles, addressed like an upstream template so painting treats both alike. */
function archiveTemplate(frame: ArchivedFrame): string {
  return `archive:${frame.dataset}/${frame.stamp}/{z}/{x}/{y}.png`;
}

interface WeatherMapCatalog {
  response: WeatherMapsResponse;
  /** `layer/frameId` → source. */
  frames: Map<string, FrameSource>;
  /** Hourly air-temperature frames, live and archived, for precipitation's snow/rain phase. */
  temperature: FrameSource[];
  /** Per layer, the spliced frames an older client draws for "now". */
  legacy: Map<WeatherMapLayerId, FrameSource[]>;
  builtAt: number;
}

function safeDataset(value: unknown): YrMapDataset | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<YrMapDataset>;
  if (
    !Array.isArray(raw.bounds) ||
    raw.bounds.length !== 4 ||
    !raw.bounds.every((n) => typeof n === 'number') ||
    typeof raw.minzoom !== 'number' ||
    typeof raw.maxzoom !== 'number' ||
    !Array.isArray(raw.times)
  )
    return null;
  return {
    bounds: raw.bounds as [number, number, number, number],
    minzoom: raw.minzoom,
    maxzoom: raw.maxzoom,
    times: raw.times.filter(
      (entry): entry is YrMapDataset['times'][number] =>
        !!entry && typeof entry.time === 'string' && !!entry.tiles,
    ),
  };
}

/**
 * Only an upstream URL on MET's own map host, with the three tile placeholders,
 * ever becomes a fetch — the catalog is someone else's JSON, and this server
 * fetches what it says.
 */
function safeTileTemplate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(YR_MAPS_URL).origin) return null;
    if (!raw.includes('{z}') || !raw.includes('{x}') || !raw.includes('{y}')) return null;
    return raw;
  } catch {
    return null;
  }
}

function compactTime(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('.000', '')
    .replace('T', '-')
    .replace('Z', '');
}

/** Short and stable per upstream run, so a new run is a new URL. */
function runTag(upstream: string): string {
  return createHash('sha1').update(upstream).digest('hex').slice(0, 8);
}

function tilePath(layer: WeatherMapLayerId, frameId: string): string {
  return `/api/weather/maps/${layer}/${frameId}/{z}/{x}/{y}.png?v=${PAINT_REV}`;
}

/** The first release's flat legend chips, for bundles that still render them. */
function legacyLegend(layer: WeatherMapLayerId): WeatherMapLegendStop[] {
  const row = weatherMapLegend(layer).rows[0]!;
  if (row.ticks.length === 0) return [];
  const swatches = legendRowSwatches(row, 64);
  return row.ticks.map((tick) => ({
    label: tick.label,
    color: swatches[Math.min(63, Math.floor(tick.at * 64))]!,
  }));
}

/** The catalog rows that switch the weather layers on, plus live sky observations. */
export function weatherLayerMetas(frostClientId = process.env.FROST_CLIENT_ID): LayerMeta[] {
  const fields = WEATHER_MAP_LAYER_IDS.map((id): LayerMeta => {
    const spec = WEATHER_MAP_LAYER_SPECS.find((candidate) => candidate.id === id)!;
    return {
      id: weatherOverlayId(id),
      rev: PAINT_REV,
      title: spec.title,
      description: spec.description,
      group: 'Weather',
      attribution: ATTRIBUTION,
      metadataUrl: 'https://api.met.no/',
      // The upstream's finest zoom; the map overzooms past it (the fields are
      // a few kilometres per pixel at best).
      maxzoom: 5,
      defaultOpacity: spec.defaultOpacity,
      identify: false,
      coverageNote: spec.coverageNote,
      weather: { layer: id },
      exclusive: WEATHER_FIELD_GROUP,
    };
  });
  return [
    ...fields,
    ...(frostClientId
      ? [
          {
            id: LIGHTNING_OBSERVATIONS_ID,
            rev: 2,
            title: 'Lightning',
            description: 'Detected lightning strikes from the last hour, 12 hours or 24 hours.',
            group: 'Weather',
            attribution: 'Lightning observations © MET Norway',
            metadataUrl: 'https://frost.met.no/',
            minzoom: 4,
            maxzoom: 18,
            defaultOpacity: 1,
            identify: false,
            coverageNote:
              'Nordic detection network. The newest strikes pulse orange, then fade through magenta (to 15 min), violet (1 h) and grey (6 h) to a faint grey for the rest of the day.',
            vector: true,
          } satisfies LayerMeta,
        ]
      : []),
    {
      id: AURORA_FORECAST_ID,
      rev: 2,
      title: 'Aurora viewing chance',
      description:
        'NOAA’s 30-minute aurora probability adjusted for darkness, clouds and artificial light.',
      group: 'Weather',
      attribution: 'Aurora © NOAA SWPC · clouds © MET Norway · night lights © NASA',
      metadataUrl: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast',
      maxzoom: 5,
      defaultOpacity: 0.85,
      identify: false,
      refreshSeconds: 300,
      coverageNote:
        'A brighter, more opaque green band means a better viewing chance. Low/medium/high cloud, solar darkness and VIIRS artificial-light radiance reduce it.',
    },
    {
      id: WEATHER_WARNINGS_ID,
      rev: 1,
      title: 'Weather warnings',
      description:
        'MET’s yellow, orange and red warnings for wind, rain, snow, fire danger and more.',
      group: 'Weather',
      attribution: 'Warnings © MET Norway (CC BY 4.0)',
      metadataUrl: 'https://www.met.no/en/weather-and-climate/dangerous-weather-warnings',
      maxzoom: 18,
      defaultOpacity: 1,
      identify: false,
      coverageNote: 'Norway and its waters only. No area drawn means no warning is in force.',
      vector: true,
    },
  ];
}

/** Small insertion-ordered LRU. */
class Lru<V> {
  private readonly map = new Map<string, V>();
  private bytes = 0;
  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    private readonly size: (value: V) => number = () => 0,
  ) {}
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.bytes -= this.size(existing);
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += this.size(value);
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.size(this.map.get(oldest)!);
      this.map.delete(oldest);
    }
  }
  delete(key: string): void {
    const existing = this.map.get(key);
    if (existing === undefined) return;
    this.bytes -= this.size(existing);
    this.map.delete(key);
  }
}

function validTile(z: number, x: number, y: number): boolean {
  return (
    Number.isInteger(z) &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    z >= 0 &&
    z <= 22 &&
    x >= 0 &&
    y >= 0 &&
    x < 2 ** z &&
    y < 2 ** z
  );
}

export function registerWeatherMapsApi(
  app: FastifyInstance,
  opts: WeatherMapsApiOptions = {},
): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const status = opts.status;
  const now = opts.now ?? Date.now;
  const userAgent = opts.userAgent ?? process.env.METNO_USER_AGENT ?? METNO_MAPS_USER_AGENT;
  const frostClientId = opts.frostClientId ?? process.env.FROST_CLIENT_ID;
  const MAPS_PROBE = 'yr-maps';
  const ALERTS_PROBE = 'metalerts';
  const LIGHTNING_PROBE = 'frost-lightning';
  const AURORA_PROBE = 'noaa-ovation';
  status?.register(MAPS_PROBE, 'MET Norway (weather maps)', 'Weather');
  status?.register(ALERTS_PROBE, 'MET Norway (weather warnings)', 'Weather');
  if (frostClientId) status?.register(LIGHTNING_PROBE, 'MET Norway (lightning)', 'Weather');
  status?.register(AURORA_PROBE, 'NOAA SWPC (aurora forecast)', 'Weather');

  // ------------------------------------------------------------- catalog ---

  let catalogCache: WeatherMapCatalog | null = null;
  let previousFrames = new Map<string, FrameSource>();
  let catalogInflight: Promise<WeatherMapCatalog> | null = null;

  async function fetchDataset(name: string): Promise<YrMapDataset | null> {
    const res = await fetchImpl(`${YR_MAPS_URL}/${name}/available.json`, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return safeDataset(await res.json());
  }

  async function buildCatalog(): Promise<WeatherMapCatalog> {
    const names = [
      ...new Set(
        Object.values(MAP_SOURCES).flatMap((timelines) =>
          Object.values(timelines).flatMap((sources) => sources.map((s) => s.name)),
        ),
      ),
    ];
    const settled = await Promise.allSettled(names.map((name) => fetchDataset(name)));
    const datasets = new Map<string, YrMapDataset>();
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) datasets.set(names[index]!, result.value);
    });

    const at = now();
    const [archivedRadar, archivedTemperature] = opts.archive
      ? await Promise.all([
          opts.archive.frames(RADAR_ARCHIVE_DATASET).catch(() => []),
          opts.archive.frames(TEMPERATURE_ARCHIVE_DATASET).catch(() => []),
        ])
      : [[], []];
    const frames = new Map<string, FrameSource>();
    const legacy = new Map<WeatherMapLayerId, FrameSource[]>();
    const layers: WeatherMapLayer[] = [];

    for (const spec of WEATHER_MAP_LAYER_SPECS) {
      const timelines: WeatherMapTimeline[] = [];
      const sourcesByTimeline: FrameSource[][] = [];
      for (const timelineId of ['radar', 'forecast'] as const) {
        const sources = MAP_SOURCES[spec.id][timelineId];
        if (!sources) continue;
        const [back, ahead] = WINDOWS[timelineId];
        // Later sources replace earlier ones at the same instant: observed
        // radar is listed last, so it beats the nowcast at "now".
        const byTime = new Map<string, FrameSource>();
        let reference: Pick<YrMapDataset, 'bounds' | 'minzoom' | 'maxzoom'> | undefined;
        for (const source of sources) {
          const dataset = datasets.get(source.name);
          if (!dataset) continue;
          reference ??= dataset;
          for (const entry of dataset.times) {
            const ms = Date.parse(entry.time);
            if (!Number.isFinite(ms) || ms < at + back || ms > at + ahead) continue;
            // PNG only: it is the lossless encoding the values survive in.
            const upstream = safeTileTemplate(entry.tiles.png);
            if (!upstream) continue;
            const id = `${source.kind}-${compactTime(ms)}-${runTag(upstream)}`;
            byTime.set(new Date(ms).toISOString(), {
              layer: spec.id,
              timeline: timelineId,
              frame: {
                id,
                time: new Date(ms).toISOString(),
                kind: source.kind,
                tilePath: tilePath(spec.id, id),
              },
              upstream,
              minzoom: dataset.minzoom,
              maxzoom: dataset.maxzoom,
            });
          }
        }
        // The day before MET's live window, from the archive: up to the first
        // live picture, so the two never overlap and never leave a gap.
        if (spec.id === 'precipitation' && timelineId === 'radar') {
          const earliestLive = Math.min(
            Number.POSITIVE_INFINITY,
            ...[...byTime.values()].map((source) => Date.parse(source.frame.time)),
          );
          for (const archived of archivedRadar) {
            if (archived.ms < at - RADAR_HISTORY_MS || archived.ms >= earliestLive) continue;
            if (archived.ms > at) continue;
            reference ??= archived;
            const upstream = archiveTemplate(archived);
            const id = `observation-${compactTime(archived.ms)}-${runTag(upstream)}`;
            byTime.set(new Date(archived.ms).toISOString(), {
              layer: spec.id,
              timeline: timelineId,
              frame: {
                id,
                time: new Date(archived.ms).toISOString(),
                kind: 'observation',
                tilePath: tilePath(spec.id, id),
              },
              upstream,
              minzoom: archived.minzoom,
              maxzoom: archived.maxzoom,
              archived: true,
            });
          }
        }
        const ordered = [...byTime.values()].sort(
          (a, b) => Date.parse(a.frame.time) - Date.parse(b.frame.time),
        );
        if (!reference || ordered.length === 0) continue;
        for (const source of ordered) frames.set(`${spec.id}/${source.frame.id}`, source);
        sourcesByTimeline.push(ordered);
        timelines.push({
          id: timelineId,
          bounds: reference.bounds,
          minzoom: reference.minzoom,
          // Painted deeper than the data, from interpolated values (see paintWeatherTile).
          maxzoom: reference.maxzoom + WEATHER_TILE_OVERZOOM,
          frames: ordered.map((source) => source.frame),
        });
      }
      if (timelines.length === 0) continue;

      // The first release's single timeline: radar where it has a picture,
      // the forecast elsewhere.
      const spliced = new Map<string, FrameSource>();
      for (const list of [...sourcesByTimeline].reverse()) {
        // Those bundles never had history; their single timeline stays MET's live window.
        for (const source of list) if (!source.archived) spliced.set(source.frame.time, source);
      }
      const legacyFrames = [...spliced.values()].sort(
        (a, b) => Date.parse(a.frame.time) - Date.parse(b.frame.time),
      );
      legacy.set(spec.id, legacyFrames);
      const primary = timelines.find((t) => t.id === 'forecast') ?? timelines[0]!;
      layers.push({
        ...spec,
        timelines,
        frames: legacyFrames.map((source) => source.frame),
        legend: legacyLegend(spec.id),
        bounds: primary.bounds,
        minzoom: primary.minzoom,
        maxzoom: primary.maxzoom,
      });
    }

    if (layers.length === 0) throw new Error('yr-maps returned no usable datasets');
    const temperature = [
      ...[...frames.values()].filter((source) => source.layer === 'temperature'),
      ...archivedTemperature.map((archived): FrameSource => {
        const upstream = archiveTemplate(archived);
        const id = `forecast-${compactTime(archived.ms)}-${runTag(upstream)}`;
        return {
          layer: 'temperature',
          timeline: 'forecast',
          frame: {
            id,
            time: new Date(archived.ms).toISOString(),
            kind: 'forecast',
            tilePath: tilePath('temperature', id),
          },
          upstream,
          minzoom: archived.minzoom,
          maxzoom: archived.maxzoom,
          archived: true,
        };
      }),
    ];
    return {
      response: {
        layers,
        attribution: ATTRIBUTION,
        lightning: {
          available: Boolean(frostClientId),
          reason: frostClientId
            ? 'Live observations are available as the Lightning layer.'
            : 'Live lightning is open data, but its supported Frost endpoint requires a client ID.',
        },
      },
      frames,
      temperature,
      legacy,
      builtAt: at,
    };
  }

  async function catalog(): Promise<WeatherMapCatalog> {
    if (catalogCache && now() - catalogCache.builtAt < CATALOG_TTL_MS) return catalogCache;
    if (catalogInflight) return catalogInflight;
    catalogInflight = buildCatalog()
      .then((built) => {
        // Frames that slid out of the window stay servable for one more
        // refresh: a map may be mid-way through loading their tiles.
        if (catalogCache) previousFrames = catalogCache.frames;
        catalogCache = built;
        status?.record(MAPS_PROBE, true);
        return built;
      })
      .catch((err) => {
        status?.record(MAPS_PROBE, false, 'unreachable');
        if (catalogCache) return catalogCache;
        throw err;
      })
      .finally(() => {
        catalogInflight = null;
      });
    return catalogInflight;
  }

  /** A frame by id — from the current catalog, or the one it replaced. */
  async function findFrame(layer: string, frameId: string): Promise<FrameSource | null> {
    const current = await catalog();
    const key = `${layer}/${frameId}`;
    return current.frames.get(key) ?? previousFrames.get(key) ?? null;
  }

  // --------------------------------------------------------------- tiles ---

  const decoded = new Lru<Promise<WeatherRaster | null>>(DECODED_CACHE_ENTRIES);

  /** One upstream tile decoded to raw channel values; null where MET has none. */
  function decodeUpstream(
    template: string,
    z: number,
    x: number,
    y: number,
  ): Promise<WeatherRaster | null> {
    const url = template
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const hit = decoded.get(url);
    if (hit) return hit;
    const task = (async () => {
      if (url.startsWith('archive:')) {
        const [dataset, stamp] = url.slice('archive:'.length).split('/');
        const bytes =
          opts.archive && dataset && stamp
            ? await opts.archive.tile({ dataset, stamp }, z, x, y)
            : null;
        if (!bytes) return null;
        const png = PNG.sync.read(bytes, { skipRescale: true });
        return { width: png.width, height: png.height, data: png.data } satisfies WeatherRaster;
      }
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': userAgent, Accept: 'image/png' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404 || res.status === 204) return null;
      if (!res.ok) throw new Error(`yr-maps tile ${res.status}`);
      // skipRescale keeps the 16-bit wind channels at full precision.
      const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()), { skipRescale: true });
      return { width: png.width, height: png.height, data: png.data } satisfies WeatherRaster;
    })();
    decoded.set(url, task);
    // A failure must not stay cached: the next request retries.
    task.catch(() => decoded.delete(url));
    return task;
  }

  /**
   * A dataset's tiles around a painted tile, decoded, as the mosaic the painter
   * reads: at the data's own zoom when the painted tile is deeper, with the
   * neighbours interpolation reaches into.
   */
  async function mosaicFor(
    source: FrameSource,
    z: number,
    x: number,
    y: number,
  ): Promise<WeatherMosaic & { empty: boolean }> {
    const sourceZ = Math.min(z, source.maxzoom);
    const tiles = new Map<string, WeatherRaster | null>();
    await Promise.all(
      weatherTileFootprint(z, x, y, sourceZ).map(async (t) => {
        tiles.set(`${t.x}/${t.y}`, await decodeUpstream(source.upstream, sourceZ, t.x, t.y));
      }),
    );
    return {
      z: sourceZ,
      tile: (tx, ty) => tiles.get(`${tx}/${ty}`) ?? null,
      empty: [...tiles.values()].every((tile) => tile === null),
    };
  }

  /** The air-temperature frame nearest a precipitation frame, for its snow/rain blend. */
  async function temperatureFor(source: FrameSource): Promise<FrameSource | null> {
    const frames = (await catalog()).temperature;
    if (frames.length === 0) return null;
    const target = Date.parse(source.frame.time);
    const nearest =
      frames[
        closestFrameIndex(
          frames.map((f) => f.frame),
          target,
        )
      ]!;
    return Math.abs(Date.parse(nearest.frame.time) - target) <= 90 * MINUTE ? nearest : null;
  }

  const painted = new Lru<Buffer>(4096, PAINTED_CACHE_BYTES, (b) => b.length);
  const paintInflight = new Map<string, Promise<Buffer>>();
  const EMPTY_TILE = PNG.sync.write(new PNG({ width: 256, height: 256 }));

  function paint(source: FrameSource, z: number, x: number, y: number): Promise<Buffer> {
    const key = `${PAINT_REV}|${source.upstream}|${z}/${x}/${y}`;
    const hit = painted.get(key);
    if (hit) return Promise.resolve(hit);
    const running = paintInflight.get(key);
    if (running) return running;
    const task = (async () => {
      const mosaic = await mosaicFor(source, z, x, y);
      // Empty only when no tile it reads has data: a neighbour can still reach
      // in and draw the soft edge of radar coverage.
      if (mosaic.empty) return EMPTY_TILE;
      let temperature: WeatherMosaic | undefined;
      if (source.layer === 'precipitation') {
        const air = await temperatureFor(source);
        temperature = air ? await mosaicFor(air, z, x, y).catch(() => undefined) : undefined;
      }
      const png = new PNG({ width: 256, height: 256 });
      png.data = Buffer.from(paintWeatherTile(source.layer, mosaic, z, x, y, temperature));
      const bytes = PNG.sync.write(png, { deflateLevel: 6 });
      painted.set(key, bytes);
      return bytes;
    })().finally(() => paintInflight.delete(key));
    paintInflight.set(key, task);
    return task;
  }

  async function sendTile(
    reply: FastifyReply,
    source: FrameSource,
    z: number,
    x: number,
    y: number,
  ) {
    if (z < source.minzoom || z > source.maxzoom + WEATHER_TILE_OVERZOOM) {
      return reply.code(404).send({ error: 'zoom outside this weather layer' });
    }
    const bytes = await paint(source, z, x, y);
    reply.header('content-type', 'image/png');
    // Frame ids change with every model run and PAINT_REV with the painting,
    // so a tile URL's content never changes.
    reply.header('cache-control', 'public, max-age=86400, immutable');
    return reply.send(bytes);
  }

  app.get('/api/weather/maps', async (request, reply) => {
    try {
      const cat = await catalog();
      reply.header('cache-control', 'public, max-age=60');
      return cat.response;
    } catch (err) {
      request.log.error({ err }, 'weather maps upstream failed');
      return reply.code(502).send({ error: 'weather maps unavailable' });
    }
  });

  app.get<{ Params: { layer: string; frame: string; z: string; x: string; y: string } }>(
    '/api/weather/maps/:layer/:frame/:z/:x/:y.png',
    async (request, reply) => {
      const z = Number(request.params.z);
      const x = Number(request.params.x);
      const y = Number(request.params.y);
      if (!validTile(z, x, y)) return reply.code(400).send({ error: 'invalid tile coordinate' });
      try {
        const source = await findFrame(request.params.layer, request.params.frame);
        if (!source) return reply.code(404).send({ error: 'weather map frame not found' });
        return await sendTile(reply, source, z, x, y);
      } catch (err) {
        request.log.error({ err }, 'weather map tile failed');
        return reply.code(502).send();
      }
    },
  );

  // A client that predates the weather field draws the catalog row as an
  // ordinary raster: give it the picture nearest now instead of a 404.
  for (const layer of WEATHER_MAP_LAYER_IDS) {
    app.get<{ Params: { z: string; x: string; y: string } }>(
      `/api/overlay/${weatherOverlayId(layer)}/:z/:x/:y.png`,
      async (request, reply) => {
        const z = Number(request.params.z);
        const x = Number(request.params.x);
        const y = Number(request.params.y);
        if (!validTile(z, x, y)) return reply.code(400).send({ error: 'invalid tile coordinate' });
        try {
          const frames = (await catalog()).legacy.get(layer) ?? [];
          if (frames.length === 0) return reply.code(404).send();
          const source =
            frames[
              closestFrameIndex(
                frames.map((f) => f.frame),
                now(),
              )
            ]!;
          if (z > source.maxzoom + WEATHER_TILE_OVERZOOM) return reply.code(404).send();
          const bytes = await paint(source, z, x, y);
          reply.header('content-type', 'image/png');
          reply.header('cache-control', 'public, max-age=300');
          return reply.send(bytes);
        } catch (err) {
          request.log.error({ err }, 'weather overlay tile failed');
          return reply.code(502).send();
        }
      },
    );
  }

  // ------------------------------------------------------- aurora forecast ---

  let aurora: { fetchedAt: number; grid: OvationGrid } | null = null;
  let auroraInflight: Promise<OvationGrid> | null = null;
  const auroraTiles = new Lru<Buffer>(64, 24 * 1024 * 1024, (value) => value.byteLength);

  async function currentAurora(): Promise<OvationGrid> {
    if (aurora && now() - aurora.fetchedAt < AURORA_TTL_MS) return aurora.grid;
    if (auroraInflight) return auroraInflight;
    auroraInflight = (async () => {
      try {
        const response = await fetchImpl(OVATION_URL, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new Error(`ovation ${response.status}`);
        const grid = parseOvation(await response.json());
        if (!grid) throw new Error('ovation returned an invalid grid');
        aurora = { fetchedAt: now(), grid };
        status?.record(AURORA_PROBE, true);
        return grid;
      } catch (error) {
        status?.record(AURORA_PROBE, false, 'unreachable');
        if (aurora) return aurora.grid;
        throw error;
      } finally {
        auroraInflight = null;
      }
    })();
    return auroraInflight;
  }

  app.get<{ Params: { z: string; x: string; y: string } }>(
    `/api/overlay/${AURORA_FORECAST_ID}/:z/:x/:y.png`,
    async (request, reply) => {
      const z = Number(request.params.z);
      const x = Number(request.params.x);
      const y = Number(request.params.y);
      if (!validTile(z, x, y) || z > 5)
        return reply.code(400).send({ error: 'invalid tile coordinate' });
      try {
        const grid = await currentAurora();
        const forecastMs = Date.parse(grid.forecastTime);
        let cloudSource: FrameSource | null = null;
        try {
          const cloudFrames = [...(await catalog()).frames.values()].filter(
            (source) => source.layer === 'clouds' && source.timeline === 'forecast',
          );
          if (cloudFrames.length > 0) {
            const candidate =
              cloudFrames[
                closestFrameIndex(
                  cloudFrames.map((source) => source.frame),
                  forecastMs,
                )
              ]!;
            if (Math.abs(Date.parse(candidate.frame.time) - forecastMs) <= 90 * MINUTE) {
              cloudSource = candidate;
            }
          }
        } catch {
          // OVATION still draws when the weather-map catalog is temporarily unavailable.
        }
        const key = `${grid.forecastTime}/${cloudSource?.frame.id ?? 'no-cloud'}/${z}/${x}/${y}`;
        let bytes = auroraTiles.get(key);
        if (!bytes) {
          const [clouds, lightPollution] = await Promise.all([
            cloudSource ? mosaicFor(cloudSource, z, x, y).catch(() => undefined) : undefined,
            decodeUpstream(VIIRS_LIGHTS_TEMPLATE, z, x, y).catch(() => null),
          ]);
          const png = new PNG({ width: 256, height: 256, colorType: 6 });
          png.data = Buffer.from(
            paintAuroraTile(grid, z, x, y, {
              ...(clouds ? { clouds } : {}),
              ...(lightPollution ? { lightPollution } : {}),
            }),
          );
          bytes = PNG.sync.write(png);
          auroraTiles.set(key, bytes);
        }
        reply.header('content-type', 'image/png');
        reply.header('cache-control', 'public, max-age=240');
        reply.header('x-atlas-forecast-time', grid.forecastTime);
        return reply.send(bytes);
      } catch (error) {
        request.log.error({ err: error }, 'aurora forecast upstream failed');
        return reply.code(502).send();
      }
    },
  );

  app.get('/api/weather/aurora', async (request, reply) => {
    try {
      const grid = await currentAurora();
      const response: AuroraForecastStatus = {
        observationTime: grid.observationTime,
        forecastTime: grid.forecastTime,
        factors: ['aurora', 'darkness', 'clouds', 'light-pollution'],
      };
      reply.header('cache-control', 'public, max-age=240');
      return reply.send(response);
    } catch (error) {
      request.log.error({ err: error }, 'aurora forecast metadata upstream failed');
      return reply.code(502).send({ error: 'aurora forecast unavailable' });
    }
  });

  // --------------------------------------------------- lightning observations ---

  // Keyed by snapped viewport and window, so bounded: a day of strikes over a
  // wide view is megabytes, and every pan to a new cell adds a key.
  const lightningCache = new Lru<{ fetchedAt: number; data: LightningResponse }>(
    128,
    48 * 1024 * 1024,
    (entry) => 256 + entry.data.features.length * 260,
  );

  const lightningBbox = (raw: string | undefined): [number, number, number, number] | null => {
    const value = (raw ?? '').split(',').map(Number);
    if (value.length !== 4 || value.some((n) => !Number.isFinite(n))) return null;
    const [w, s, e, n] = value as [number, number, number, number];
    if (w >= e || s >= n || e - w > 90 || n - s > 60) return null;
    const clipped: [number, number, number, number] = [
      Math.max(LIGHTNING_BOUNDS[0], Math.floor(w / 2) * 2),
      Math.max(LIGHTNING_BOUNDS[1], Math.floor(s / 2) * 2),
      Math.min(LIGHTNING_BOUNDS[2], Math.ceil(e / 2) * 2),
      Math.min(LIGHTNING_BOUNDS[3], Math.ceil(n / 2) * 2),
    ];
    return clipped[0] < clipped[2] && clipped[1] < clipped[3] ? clipped : null;
  };

  app.get<{ Querystring: { bbox?: string; window?: string } }>(
    `/api/overlay/${LIGHTNING_OBSERVATIONS_ID}/features`,
    async (request, reply) => {
      if (!frostClientId)
        return reply.code(503).send({ error: 'lightning observations are not configured' });
      const bbox = lightningBbox(request.query.bbox);
      if (!bbox) return reply.code(400).send({ error: 'valid bounded bbox required' });
      const selectedWindow = lightningWindow(request.query.window);
      const key = `${selectedWindow.id}/${bbox.join(',')}`;
      const cached = lightningCache.get(key);
      if (cached && now() - cached.fetchedAt < LIGHTNING_TTL_MS) return reply.send(cached.data);
      const [w, s, e, n] = bbox;
      const query = new URLSearchParams({
        referencetime: 'latest',
        maxage: selectedWindow.frostDuration,
        geometry: `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`,
      });
      try {
        const response = await fetchImpl(`${FROST_LIGHTNING_URL}?${query}`, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${frostClientId}:`).toString('base64')}`,
            'User-Agent': userAgent,
            Accept: 'text/plain',
          },
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new Error(`frost lightning ${response.status}`);
        const data = parseUalf(await response.text(), now(), 10_000, selectedWindow.minutes);
        lightningCache.set(key, { fetchedAt: now(), data });
        status?.record(LIGHTNING_PROBE, true);
        reply.header('cache-control', 'public, max-age=15');
        return reply.send(data);
      } catch (error) {
        status?.record(LIGHTNING_PROBE, false, 'unreachable');
        request.log.error({ err: error }, 'lightning observations upstream failed');
        if (cached) return reply.send(cached.data);
        return reply.code(502).send({ error: 'lightning observations unavailable' });
      }
    },
  );

  // ---------------------------------------------------------------- grid ---

  /** One layer's value at a point from a frame, read at the frame's finest zoom unless told otherwise. */
  async function valueAt(source: FrameSource, lng: number, lat: number, z = source.maxzoom) {
    const { x, y, px, py } = tilePixelAt(lng, lat, z);
    const raster = await decodeUpstream(source.upstream, z, x, y);
    return raster ? weatherValueAt(source.layer, raster, px, py) : null;
  }

  app.get<{
    Params: { layer: string; frame: string };
    Querystring: { bbox?: string; cols?: string; rows?: string };
  }>('/api/weather/maps/:layer/:frame/grid', async (request, reply) => {
    const layer = asWeatherMapLayerId(request.params.layer);
    const bbox = (request.query.bbox ?? '').split(',').map(Number);
    const cols = Number(request.query.cols);
    const rows = Number(request.query.rows);
    if (
      !layer ||
      bbox.length !== 4 ||
      !bbox.every(Number.isFinite) ||
      bbox[0]! >= bbox[2]! ||
      bbox[1]! >= bbox[3]! ||
      bbox[0]! < -180 ||
      bbox[2]! > 180 ||
      bbox[1]! < -90 ||
      bbox[3]! > 90 ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > MAX_GRID ||
      rows > MAX_GRID
    ) {
      return reply.code(400).send({ error: 'layer, bbox=w,s,e,n and cols/rows 1–160 required' });
    }
    const [w, s, e, n] = bbox as [number, number, number, number];
    try {
      const source = await findFrame(layer, request.params.frame);
      if (!source) return reply.code(404).send({ error: 'weather map frame not found' });
      const z = weatherGridZoom([w, s, e, n], cols, source.minzoom, source.maxzoom);
      const size = cols * rows;
      const values: (number | null)[] = new Array(size).fill(null);
      const u: (number | null)[] = new Array(size).fill(null);
      const v: (number | null)[] = new Array(size).fill(null);
      await Promise.all(
        Array.from({ length: size }, async (_, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const lng = w + ((col + 0.5) * (e - w)) / cols;
          const lat = n - ((row + 0.5) * (n - s)) / rows;
          const sample = await valueAt(source, lng, lat, z);
          if (!sample) return;
          switch (sample.layer) {
            case 'wind':
              u[i] = Math.round(sample.value.u * 100) / 100;
              v[i] = Math.round(sample.value.v * 100) / 100;
              break;
            case 'clouds':
              values[i] = Math.round(sample.value.total);
              break;
            default:
              values[i] = sample.value;
          }
        }),
      );
      const body: WeatherGridResponse = {
        layer,
        frame: source.frame.id,
        time: source.frame.time,
        bbox: [w, s, e, n],
        cols,
        rows,
        ...(layer === 'wind' ? { u, v } : { values }),
      };
      reply.header('cache-control', 'public, max-age=3600');
      return body;
    } catch (err) {
      request.log.error({ err }, 'weather grid failed');
      return reply.code(502).send({ error: 'weather grid unavailable' });
    }
  });

  // --------------------------------------------------------------- point ---

  app.get<{ Querystring: { lat?: string; lng?: string; time?: string } }>(
    '/api/weather/maps/point',
    async (request, reply) => {
      const lat = Number(request.query.lat);
      const lng = Number(request.query.lng);
      const requested = request.query.time ? Date.parse(request.query.time) : now();
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        !Number.isFinite(requested)
      ) {
        return reply.code(400).send({ error: 'valid lat, lng and time required' });
      }
      try {
        const cat = await catalog();
        const nearest = (layer: WeatherMapLayerId, timeline: WeatherMapTimelineId) => {
          const list = [...cat.frames.values()].filter(
            (source) => source.layer === layer && source.timeline === timeline,
          );
          if (list.length === 0) return null;
          const best =
            list[
              closestFrameIndex(
                list.map((f) => f.frame),
                requested,
              )
            ]!;
          const off = Math.abs(Date.parse(best.frame.time) - requested);
          return off <= POINT_TOLERANCE[timeline] ? best : null;
        };
        const read = async (source: FrameSource | null) =>
          source ? await valueAt(source, lng, lat).catch(() => null) : null;

        // Live or archived: a radar picture from yesterday still wants yesterday's temperature.
        const temperatureSource = (() => {
          if (cat.temperature.length === 0) return null;
          const best =
            cat.temperature[
              closestFrameIndex(
                cat.temperature.map((f) => f.frame),
                requested,
              )
            ]!;
          const off = Math.abs(Date.parse(best.frame.time) - requested);
          return off <= POINT_TOLERANCE.forecast ? best : null;
        })();
        const temperature = await read(temperatureSource);
        const temperatureC = temperature?.layer === 'temperature' ? temperature.value : null;

        // Radar answers where it has a picture of this place; the forecast elsewhere.
        const radarSource = nearest('precipitation', 'radar');
        let precipitationSource = radarSource;
        let precipitation = await read(radarSource);
        if (precipitation?.layer !== 'precipitation' || precipitation.value === null) {
          precipitationSource = nearest('precipitation', 'forecast');
          precipitation = await read(precipitationSource);
        }
        const level = precipitation?.layer === 'precipitation' ? precipitation.value : null;

        const wind = await read(nearest('wind', 'forecast'));
        const clouds = await read(nearest('clouds', 'forecast'));
        const sea = await read(nearest('sea-temperature', 'forecast'));

        const answeredBy = precipitationSource ?? temperatureSource;
        const sample: WeatherPointSample = {
          time: answeredBy?.frame.time ?? new Date(requested).toISOString(),
          temperatureC,
          wind:
            wind?.layer === 'wind'
              ? {
                  speed: Math.round(windSpeed(wind.value) * 10) / 10,
                  fromDeg: Math.round(windFromDeg(wind.value)),
                }
              : null,
          precipitation:
            level === null
              ? null
              : {
                  level,
                  frozen: temperatureC !== null && temperatureC <= FROZEN_PRECIPITATION_MAX_C,
                  radar: precipitationSource?.timeline === 'radar',
                },
          cloudCoverPct: clouds?.layer === 'clouds' ? Math.round(clouds.value.total) : null,
          seaTemperatureC:
            sea?.layer === 'sea-temperature' && sea.value !== null
              ? Math.round(sea.value * 10) / 10
              : null,
        };
        reply.header('cache-control', 'public, max-age=300');
        return sample;
      } catch (err) {
        request.log.error({ err }, 'weather point failed');
        return reply.code(502).send({ error: 'weather unavailable' });
      }
    },
  );

  // ------------------------------------------------------------ warnings ---

  let alerts: { fetchedAt: number; raw: unknown } | null = null;
  let alertsInflight: Promise<unknown> | null = null;

  async function currentAlerts(): Promise<unknown> {
    if (alerts && now() - alerts.fetchedAt < ALERTS_TTL_MS) return alerts.raw;
    if (alertsInflight) return alertsInflight;
    alertsInflight = (async () => {
      try {
        const res = await fetchImpl(METALERTS_URL, {
          headers: { 'User-Agent': userAgent },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`metalerts ${res.status}`);
        const raw = await res.json();
        alerts = { fetchedAt: now(), raw };
        status?.record(ALERTS_PROBE, true);
        return raw;
      } catch (err) {
        status?.record(ALERTS_PROBE, false, 'unreachable');
        // A warning that was in force a few minutes ago is still the best answer.
        if (alerts) return alerts.raw;
        throw err;
      } finally {
        alertsInflight = null;
      }
    })();
    return alertsInflight;
  }

  app.get(`/api/overlay/${WEATHER_WARNINGS_ID}/features`, async (request, reply) => {
    try {
      const raw = await currentAlerts();
      reply.header('cache-control', 'public, max-age=120');
      return normalizeMetAlerts(raw, now());
    } catch (err) {
      request.log.error({ err }, 'weather warnings upstream failed');
      return reply.code(502).send({ error: 'weather warnings unavailable' });
    }
  });
}
