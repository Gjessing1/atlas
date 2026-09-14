import { fmtClock, haversineM, type LatLng } from '@atlas/core';
import type { RoadWeatherRoute, RoadWeatherWarning } from '@atlas/routing';
import { SaxesParser } from 'saxes';

/** One NPRA road-weather observation or hourly forecast at a named road point. */
export interface RoadWeatherReading {
  siteId: string;
  source: 'measured' | 'forecast';
  validAt: string;
  surfaceTemperatureC?: number;
  airTemperatureC?: number;
  dewPointTemperatureC?: number;
  condition?: string;
  precipitationMmH?: number;
  friction?: number;
  iceThicknessM?: number;
  snowDepthM?: number;
  waterFilmM?: number;
}

/** Stable location metadata published separately from the weather values. */
export interface RoadWeatherSite {
  id: string;
  name: string;
  roadNumber: string;
  position: LatLng;
}

export interface RoadWeatherSnapshot {
  publishedAt: string;
  readings: RoadWeatherReading[];
}

export interface RoadWeatherFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
      id: string;
      name: string;
      roadNumber: string;
      source: RoadWeatherReading['source'];
      validAt: string;
      surfaceTemperatureC?: number;
      airTemperatureC?: number;
      condition: string;
      /** The surface sensor reads near freezing under warm air, so its reading is withheld. */
      surfaceSuspect?: true;
      risk: 'none' | 'possible' | 'high';
      markerColor: string;
      symbol: string;
    };
  }>;
}

const local = (name: string): string => name.replace(/^.*:/, '');
const attribute = (attributes: Record<string, unknown>, name: string): string => {
  const value = attributes[name];
  return typeof value === 'string' ? value : '';
};
const finite = (raw: string): number | undefined => {
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

/** Parse either of NPRA's point tables (measured sites or forecast points). */
export function parseRoadWeatherSites(xml: string): {
  publishedAt: string;
  sites: RoadWeatherSite[];
} {
  let publishedAt = '';
  const sites: RoadWeatherSite[] = [];
  const path: string[] = [];
  let current: { id: string; name: string; roadNumber: string; lat?: number; lng?: number } | null =
    null;
  let rootTag = '';
  let captureTag = '';
  let captureText = '';

  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    const name = local(tag.name);
    path.push(name);
    if (!current && (name === 'measurementSite' || name === 'predefinedLocationReference')) {
      const id = attribute(tag.attributes, 'id');
      if (id) {
        current = { id, name: '', roadNumber: '' };
        rootTag = name;
      }
    }
    const wanted =
      name === 'publicationTime' ||
      name === 'latitude' ||
      name === 'longitude' ||
      name === 'roadNumber' ||
      (name === 'value' &&
        (path.includes('measurementSiteName') || path.includes('predefinedLocationName')));
    if (wanted) {
      captureTag = name;
      captureText = '';
    }
  });
  parser.on('text', (chunk) => {
    if (captureTag) captureText += chunk;
  });
  parser.on('closetag', (tag) => {
    const name = local(tag.name);
    if (captureTag === name) {
      const value = captureText.trim();
      if (name === 'publicationTime' && !current) publishedAt = value;
      else if (current && name === 'value' && !current.name) current.name = value;
      else if (current && name === 'roadNumber' && !current.roadNumber) {
        current.roadNumber = value;
      } else if (current && name === 'latitude') current.lat = finite(value);
      else if (current && name === 'longitude') current.lng = finite(value);
      captureTag = '';
      captureText = '';
    }
    if (current && name === rootTag) {
      if (
        current.lat !== undefined &&
        Math.abs(current.lat) <= 90 &&
        current.lng !== undefined &&
        Math.abs(current.lng) <= 180
      ) {
        sites.push({
          id: current.id,
          name: current.name || current.roadNumber || 'Road weather station',
          roadNumber: current.roadNumber,
          position: { lat: current.lat, lng: current.lng },
        });
      }
      current = null;
      rootTag = '';
    }
    path.pop();
  });
  parser.write(xml).close();
  if (!publishedAt) throw new Error('DATEX road-weather site table has no publicationTime');
  return { publishedAt, sites };
}

type MutableReading = RoadWeatherReading;

function takeMinimum(
  reading: MutableReading,
  key: 'surfaceTemperatureC',
  value: number | undefined,
) {
  if (value === undefined) return;
  const current = reading[key];
  reading[key] = current === undefined ? value : Math.min(current, value);
}

/** Parse `GetMeasuredWeatherData`, retaining only road-condition inputs. */
export function parseMeasuredRoadWeather(xml: string): RoadWeatherSnapshot {
  let publishedAt = '';
  const readings: RoadWeatherReading[] = [];
  const path: string[] = [];
  let current: MutableReading | null = null;
  let captureTag = '';
  let captureText = '';

  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    const name = local(tag.name);
    path.push(name);
    if (name === 'siteMeasurements') {
      current = { siteId: '', source: 'measured', validAt: '' };
    } else if (current && name === 'measurementSiteReference') {
      current.siteId = attribute(tag.attributes, 'id');
    }
    const wanted =
      name === 'publicationTime' ||
      name === 'timeValue' ||
      name === 'temperature' ||
      name === 'weatherRelatedRoadConditionType' ||
      name === 'millimetresPerHourIntensity' ||
      name === 'friction' ||
      name === 'distance';
    if (wanted) {
      captureTag = name;
      captureText = '';
    }
  });
  parser.on('text', (chunk) => {
    if (captureTag) captureText += chunk;
  });
  parser.on('closetag', (tag) => {
    const name = local(tag.name);
    if (captureTag === name) {
      const value = captureText.trim();
      const number = finite(value);
      if (name === 'publicationTime' && !current) publishedAt = value;
      else if (current) {
        if (name === 'timeValue' && path.includes('measurementTimeDefault')) {
          current.validAt = value;
        } else if (name === 'weatherRelatedRoadConditionType') current.condition = value;
        else if (name === 'temperature' && path.includes('roadSurfaceTemperature')) {
          takeMinimum(current, 'surfaceTemperatureC', number);
        } else if (name === 'temperature' && path.includes('airTemperature')) {
          current.airTemperatureC = number;
        } else if (name === 'temperature' && path.includes('dewPointTemperature')) {
          current.dewPointTemperatureC = number;
        } else if (name === 'millimetresPerHourIntensity') {
          current.precipitationMmH = number;
        } else if (name === 'friction') current.friction = number;
        else if (name === 'distance' && path.includes('iceLayerThickness')) {
          current.iceThicknessM = number;
        } else if (name === 'distance' && path.includes('depthOfSnow')) {
          current.snowDepthM = number;
        } else if (name === 'distance' && path.includes('waterFilmThickness')) {
          current.waterFilmM = number;
        }
      }
      captureTag = '';
      captureText = '';
    }
    if (name === 'siteMeasurements' && current) {
      if (current.siteId && current.validAt) readings.push(current);
      current = null;
    }
    path.pop();
  });
  parser.write(xml).close();
  if (!publishedAt) throw new Error('DATEX measured road weather has no publicationTime');
  return { publishedAt, readings };
}

/** Parse the hourly `GetForecastPointData` time profiles. */
export function parseForecastRoadWeather(xml: string): RoadWeatherSnapshot {
  let publishedAt = '';
  const readings: RoadWeatherReading[] = [];
  const path: string[] = [];
  let siteId = '';
  let current: MutableReading | null = null;
  let captureTag = '';
  let captureText = '';

  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    const name = local(tag.name);
    path.push(name);
    if (name === 'physicalQuantity') siteId = '';
    else if (name === 'predefinedLocationReference') siteId = attribute(tag.attributes, 'id');
    else if (name === 'basicData' && siteId) {
      const type = attribute(tag.attributes, 'xsi:type');
      if (type.endsWith('RoadSurfaceConditionInformation')) {
        current = { siteId, source: 'forecast', validAt: '' };
      }
    }
    const wanted =
      name === 'publicationTime' ||
      name === 'timeValue' ||
      name === 'temperature' ||
      name === 'weatherRelatedRoadConditionType' ||
      name === 'millimetresPerHourIntensity' ||
      name === 'distance';
    if (wanted) {
      captureTag = name;
      captureText = '';
    }
  });
  parser.on('text', (chunk) => {
    if (captureTag) captureText += chunk;
  });
  parser.on('closetag', (tag) => {
    const name = local(tag.name);
    if (captureTag === name) {
      const value = captureText.trim();
      const number = finite(value);
      if (name === 'publicationTime' && !siteId) publishedAt = value;
      else if (current) {
        if (name === 'timeValue') current.validAt = value;
        else if (name === 'weatherRelatedRoadConditionType') current.condition = value;
        else if (name === 'temperature' && path.includes('roadSurfaceTemperature')) {
          takeMinimum(current, 'surfaceTemperatureC', number);
        } else if (name === 'temperature' && path.includes('airTemperature')) {
          current.airTemperatureC = number;
        } else if (name === 'temperature' && path.includes('dewPointTemperature')) {
          current.dewPointTemperatureC = number;
        } else if (name === 'millimetresPerHourIntensity') {
          current.precipitationMmH = number;
        } else if (name === 'distance' && path.includes('depthOfSnow')) {
          current.snowDepthM = number;
        }
      }
      captureTag = '';
      captureText = '';
    }
    if (name === 'basicData' && current) {
      if (current.validAt) readings.push(current);
      current = null;
    }
    path.pop();
  });
  parser.write(xml).close();
  if (!publishedAt) throw new Error('DATEX forecast road weather has no publicationTime');
  return { publishedAt, readings };
}

const certainConditions = /(?:blackIce|freezing|frost|ice|icy|slippery|slush|snow)/i;
const moistureConditions = /(?:moist|wet|rain|slush|snow|water)/i;
const RISK_WEIGHT = { none: 0, possible: 1, high: 2 } as const;

/** The warmest road surface any rule below can warn on. */
const RISK_SURFACE_C = 3;
/**
 * Air this warm does not hold a road at freezing, so a surface sensor claiming
 * it is broken. Live on 2026-09-14, five stations read the road at 0–1.5 °C
 * under 8–15 °C air, and NPRA's forecast started from those sensors: hours of
 * `slippery` and `slushOnRoad` with snow depth at +13 °C.
 *
 * The test is the air's warmth, never the gap between air and road. On a
 * clear winter night the road genuinely runs well below the air — the two
 * winter readings left in that snapshot were 4.9 and 6.6 °C colder — and that
 * is the black-ice case this feature exists for. Below this value a reading is
 * believed, so the gate's error there is a false alarm, never a missed road;
 * above it, a road still frozen under warm air (a thaw morning in a shaded
 * cutting) goes unwarned, which is the price of not crying ice in September.
 */
const WARM_AIR_C = 8;
/** Air sensors fail too (one read 60 °C, several −40 °C); none can vouch against a road. */
const MAX_PLAUSIBLE_AIR_C = 40;
/** Grip below this is ice only on a cold road; on a warm one it is standing water. */
const LOW_FRICTION = 0.5;

/**
 * A near-freezing surface reading that warm air contradicts. It carries no ice
 * evidence, and neither does anything NPRA derives from the same sensor:
 * condition, snow and ice depth, and the station's forecast profile.
 */
export function surfaceSensorContradicted(reading: RoadWeatherReading): boolean {
  const surface = reading.surfaceTemperatureC;
  const air = reading.airTemperatureC;
  return (
    surface !== undefined &&
    air !== undefined &&
    air >= WARM_AIR_C &&
    air <= MAX_PLAUSIBLE_AIR_C &&
    surface <= RISK_SURFACE_C
  );
}

/** Conservative ice-risk classification over explicit road-surface measurements. */
export function roadIceRisk(reading: RoadWeatherReading): 'none' | 'possible' | 'high' {
  if (surfaceSensorContradicted(reading)) return 'none';
  const condition = reading.condition ?? '';
  if (certainConditions.test(condition)) return 'high';
  if ((reading.iceThicknessM ?? 0) > 0 || (reading.snowDepthM ?? 0) > 0) return 'high';
  const surface = reading.surfaceTemperatureC;
  // Several stations use zero as "sensor unavailable"; real coefficients are
  // positive, so zero must not manufacture black ice on a warm dry road. Nor
  // does a low one on a warm road: E10 Bjørnfjell read 0.48 wet at 9 °C.
  if (
    reading.friction !== undefined &&
    reading.friction > 0 &&
    reading.friction < LOW_FRICTION &&
    (surface === undefined || surface <= RISK_SURFACE_C)
  ) {
    return 'high';
  }
  if (surface === undefined) return 'none';
  const moisture =
    moistureConditions.test(condition) ||
    (reading.precipitationMmH ?? 0) > 0 ||
    (reading.waterFilmM ?? 0) > 0;
  if (moisture && surface <= 1) return 'high';
  if (moisture && surface <= RISK_SURFACE_C) return 'possible';
  const dew = reading.dewPointTemperatureC;
  if (surface <= 1 && dew !== undefined && Math.abs(surface - dew) <= 2) return 'possible';
  return 'none';
}

const DEG_M = 111_320;
/** Roughly 1.1 km north/south; route points only inspect nearby cells. */
const ROUTE_CELL_DEG = 0.01;

interface WeatherRouteIndex {
  points: readonly LatLng[];
  alongM: number[];
  routeM: number;
  cells: Map<string, number[]>;
  cellLngDeg: number;
}

const routeCellKey = (row: number, col: number): string => `${row}:${col}`;

/** Bucket route segments so every national weather station does not scan every vertex. */
function indexWeatherRoute(points: readonly LatLng[]): WeatherRouteIndex {
  const alongM = [0];
  for (let i = 1; i < points.length; i++) {
    alongM.push(alongM[i - 1]! + haversineM(points[i - 1]!, points[i]!));
  }
  const midLat = points[Math.floor(points.length / 2)]?.lat ?? 60;
  const cellLngDeg = ROUTE_CELL_DEG / Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const cells = new Map<string, number[]>();
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const fromRow = Math.floor(a.lat / ROUTE_CELL_DEG);
    const fromCol = Math.floor(a.lng / cellLngDeg);
    const toRow = Math.floor(b.lat / ROUTE_CELL_DEG);
    const toCol = Math.floor(b.lng / cellLngDeg);
    // Sampling once per crossed row/column keeps even an unusually long,
    // simplified segment searchable without filling its entire bounding box.
    const steps = Math.max(1, Math.abs(toRow - fromRow), Math.abs(toCol - fromCol));
    let previousKey = '';
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const key = routeCellKey(
        Math.floor((a.lat + (b.lat - a.lat) * t) / ROUTE_CELL_DEG),
        Math.floor((a.lng + (b.lng - a.lng) * t) / cellLngDeg),
      );
      if (key === previousKey) continue;
      previousKey = key;
      const bucket = cells.get(key);
      if (bucket) bucket.push(i);
      else cells.set(key, [i]);
    }
  }
  return { points, alongM, routeM: alongM.at(-1) ?? 0, cells, cellLngDeg };
}

/** Nearest route projection, including distance from its start. */
function projectToRoute(
  point: LatLng,
  route: WeatherRouteIndex,
  maxDistanceM: number,
): { offsetM: number; alongM: number } {
  if (route.points.length < 2) return { offsetM: Infinity, alongM: 0 };
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  let bestOffset = Infinity;
  let bestAlong = 0;
  const row = Math.floor(point.lat / ROUTE_CELL_DEG);
  const col = Math.floor(point.lng / route.cellLngDeg);
  // One extra ring absorbs grid distortion over long north/south routes.
  const radius = Math.ceil(maxDistanceM / (ROUTE_CELL_DEG * DEG_M)) + 1;
  const candidates = new Set<number>();
  for (let dRow = -radius; dRow <= radius; dRow++) {
    for (let dCol = -radius; dCol <= radius; dCol++) {
      for (const i of route.cells.get(routeCellKey(row + dRow, col + dCol)) ?? []) {
        candidates.add(i);
      }
    }
  }
  for (const i of candidates) {
    const a = route.points[i - 1]!;
    const b = route.points[i]!;
    const ax = (a.lng - point.lng) * cosLat;
    const ay = a.lat - point.lat;
    const dx = (b.lng - a.lng) * cosLat;
    const dy = b.lat - a.lat;
    const denom = dx * dx + dy * dy;
    const t = denom === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom));
    const offsetM = Math.hypot(ax + t * dx, ay + t * dy) * 111_320;
    const segmentM = haversineM(a, b);
    if (offsetM < bestOffset) {
      bestOffset = offsetM;
      bestAlong = route.alongM[i - 1]! + t * segmentM;
    }
  }
  return { offsetM: bestOffset, alongM: bestAlong };
}

const readingNear = (
  values: readonly RoadWeatherReading[],
  wantedMs: number,
  maxDeltaMs: number,
): RoadWeatherReading | null => {
  let best: RoadWeatherReading | null = null;
  let bestDelta = Infinity;
  for (const reading of values) {
    const at = Date.parse(reading.validAt);
    const delta = Math.abs(at - wantedMs);
    if (Number.isFinite(at) && delta <= maxDeltaMs && delta < bestDelta) {
      best = reading;
      bestDelta = delta;
    }
  }
  return best;
};

/**
 * Stations whose current observation is a contradicted surface sensor. NPRA
 * starts each station's forecast from that sensor, so the whole profile goes
 * with it: Fv 714 Våvatnet's stuck 0.0 °C still forecast "slippery" at 01:00,
 * once the air had cooled below the warm-air gate.
 */
function contradictedStations(measured: readonly RoadWeatherReading[], nowMs: number): Set<string> {
  const stations = new Set<string>();
  for (const reading of measured) {
    const ageMs = nowMs - Date.parse(reading.validAt);
    if (ageMs >= -10 * 60_000 && ageMs <= 60 * 60_000 && surfaceSensorContradicted(reading)) {
      stations.add(reading.siteId);
    }
  }
  return stations;
}

/**
 * Match road-weather points to the route and choose the reading at expected
 * arrival time. `durationMs` covers the whole route; `traveledM` is how far
 * along it the traveller already is, so a mid-drive check times each station
 * from there rather than from the route's start.
 */
export function roadWeatherForRoute(
  route: readonly LatLng[],
  durationMs: number,
  sites: readonly RoadWeatherSite[],
  measured: readonly RoadWeatherReading[],
  forecast: readonly RoadWeatherReading[],
  now = new Date(),
  traveledM = 0,
  maxDistanceM = 1_000,
): RoadWeatherRoute {
  if (route.length < 2) return { checkedAt: now.toISOString(), matchedSites: 0, warnings: [] };
  const routeIndex = indexWeatherRoute(route);
  const measuredBySite = new Map(measured.map((reading) => [reading.siteId, reading]));
  const forecastBySite = new Map<string, RoadWeatherReading[]>();
  for (const reading of forecast) {
    const values = forecastBySite.get(reading.siteId);
    if (values) values.push(reading);
    else forecastBySite.set(reading.siteId, [reading]);
  }
  const warnings: RoadWeatherWarning[] = [];
  let matchedSites = 0;
  const nowMs = now.getTime();
  const contradicted = contradictedStations(measured, nowMs);
  for (const site of sites) {
    const projected = projectToRoute(site.position, routeIndex, maxDistanceM);
    if (projected.offsetM > maxDistanceM || routeIndex.routeM <= 0) continue;
    matchedSites++;
    const aheadM = Math.max(0, projected.alongM - traveledM);
    const arrivalMs = nowMs + durationMs * (aheadM / routeIndex.routeM);
    const observed = measuredBySite.get(site.id);
    const observedMs = Date.parse(observed?.validAt ?? '');
    const recentObservation =
      observed &&
      Number.isFinite(observedMs) &&
      nowMs - observedMs >= -10 * 60_000 &&
      nowMs - observedMs <= 45 * 60_000 &&
      arrivalMs - nowMs <= 30 * 60_000
        ? observed
        : null;
    const predicted = contradicted.has(site.id)
      ? null
      : readingNear(forecastBySite.get(site.id) ?? [], arrivalMs, 90 * 60_000);
    const candidates = [recentObservation, predicted].filter(
      (reading): reading is RoadWeatherReading => reading !== null,
    );
    const selected = candidates.sort(
      (a, b) => RISK_WEIGHT[roadIceRisk(b)] - RISK_WEIGHT[roadIceRisk(a)],
    )[0];
    if (!selected) continue;
    const risk = roadIceRisk(selected);
    if (risk === 'none') continue;
    warnings.push({
      id: site.id,
      stationName: site.name,
      roadNumber: site.roadNumber,
      position: site.position,
      atM: projected.alongM,
      offsetM: projected.offsetM,
      validAt: selected.validAt,
      source: selected.source,
      risk,
      ...(selected.surfaceTemperatureC !== undefined
        ? { surfaceTemperatureC: selected.surfaceTemperatureC }
        : {}),
      ...(selected.condition ? { condition: selected.condition } : {}),
    });
  }
  warnings.sort((a, b) => a.atM - b.atM || RISK_WEIGHT[b.risk] - RISK_WEIGHT[a.risk]);
  return { checkedAt: now.toISOString(), matchedSites, warnings };
}

/** Current display reading at every known site, with forecasts filling observation gaps. */
export function roadWeatherFeatureCollection(
  sites: readonly RoadWeatherSite[],
  measured: readonly RoadWeatherReading[],
  forecast: readonly RoadWeatherReading[],
  now = new Date(),
): RoadWeatherFeatureCollection {
  const observed = new Map(measured.map((reading) => [reading.siteId, reading]));
  const predicted = new Map<string, RoadWeatherReading[]>();
  for (const reading of forecast) {
    const values = predicted.get(reading.siteId);
    if (values) values.push(reading);
    else predicted.set(reading.siteId, [reading]);
  }
  return {
    type: 'FeatureCollection',
    features: sites.flatMap((site) => {
      const measuredReading = observed.get(site.id);
      const measuredAt = Date.parse(measuredReading?.validAt ?? '');
      const ageMs = now.getTime() - measuredAt;
      const freshObservation =
        measuredReading &&
        Number.isFinite(measuredAt) &&
        ageMs >= -10 * 60_000 &&
        ageMs <= 60 * 60_000
          ? measuredReading
          : undefined;
      const current =
        freshObservation ?? readingNear(predicted.get(site.id) ?? [], now.getTime(), 90 * 60_000);
      if (!current) return [];
      const risk = roadIceRisk(current);
      const suspect = surfaceSensorContradicted(current);
      const visual =
        risk === 'high'
          ? { markerColor: '#dc2626', symbol: '!' }
          : risk === 'possible'
            ? { markerColor: '#d97706', symbol: '!' }
            : { markerColor: '#2563eb', symbol: '°' };
      return [
        {
          type: 'Feature' as const,
          geometry: {
            type: 'Point' as const,
            coordinates: [site.position.lng, site.position.lat] as [number, number],
          },
          properties: {
            id: site.id,
            name: site.name,
            roadNumber: site.roadNumber,
            source: current.source,
            validAt: current.validAt,
            // A discarded sensor's temperature, and the condition read with
            // it, would describe an icy road beside a marker that says not.
            ...(current.surfaceTemperatureC !== undefined && !suspect
              ? { surfaceTemperatureC: current.surfaceTemperatureC }
              : {}),
            ...(current.airTemperatureC !== undefined
              ? { airTemperatureC: current.airTemperatureC }
              : {}),
            condition: suspect ? 'unknown' : (current.condition ?? 'unknown'),
            ...(suspect ? { surfaceSuspect: true as const } : {}),
            risk,
            ...visual,
          },
        },
      ];
    }),
  };
}

export function formatRoadWeatherWarning(warning: RoadWeatherWarning | undefined): string | null {
  if (!warning) return null;
  const temperature =
    warning.surfaceTemperatureC === undefined
      ? ''
      : ` · road ${Math.round(warning.surfaceTemperatureC)} °C`;
  const condition = warning.condition
    ? ` · ${warning.condition.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`
    : '';
  const at = Date.parse(warning.validAt);
  const forecast =
    warning.source === 'forecast' && Number.isFinite(at)
      ? `Forecast ${warning.risk === 'high' ? 'ice risk' : 'possible ice'} at ${fmtClock(at)}`
      : warning.risk === 'high'
        ? 'Ice risk'
        : 'Possible ice';
  return `${forecast} near ${warning.stationName}${temperature}${condition}`;
}
