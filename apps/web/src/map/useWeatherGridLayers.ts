import type { WeatherGridViewport } from '@atlas/app-hooks';
import { sampleWindGrid, weatherValueLabels, type WeatherGridResponse } from '@atlas/conditions';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';

const LABEL_SOURCE = 'atlas-weather-values';
const LABEL_LAYER = 'atlas-weather-values-text';

/**
 * The grid to ask for over the visible map: one cell per `cellPx` of screen,
 * clamped to what the grid endpoint accepts (whole-world views wrap past ±180,
 * which a bbox cannot say).
 */
export function useWeatherGridViewport(
  map: maplibregl.Map | null,
  bbox: readonly [number, number, number, number] | null,
  cellPx: number,
): WeatherGridViewport | null {
  const w = bbox?.[0];
  const s = bbox?.[1];
  const e = bbox?.[2];
  const n = bbox?.[3];
  return useMemo(() => {
    if (!map || w === undefined || s === undefined || e === undefined || n === undefined) {
      return null;
    }
    const canvas = map.getCanvas();
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;
    const west = Math.max(-180, w);
    const east = Math.min(180, e);
    const south = Math.max(-85, s);
    const north = Math.min(85, n);
    if (west >= east || south >= north) return null;
    return {
      bbox: [west, south, east, north],
      cols: Math.max(2, Math.min(160, Math.round(width / cellPx))),
      rows: Math.max(2, Math.min(160, Math.round(height / cellPx))),
    };
  }, [map, w, s, e, n, cellPx]);
}

/** The basemap's town and city label layers, whose placed names anchor the numbers. */
const PLACE_LABEL_LAYERS = ['label_city_capital', 'label_city', 'label_town'];
const PLACE_NUMBER_LAYER = 'atlas-weather-values-place';

/**
 * Temperature numbers over the temperature fields. One sits under each town
 * name the basemap is showing ("Oslo / 16°"), and a sparse fill covers the
 * country and sea between them. The fill is placed with collision on and under
 * the basemap's labels, so names keep their places and numbers take the gaps;
 * the town numbers always draw, since they belong to a name already shown.
 */
export function useWeatherValueLabels(
  map: maplibregl.Map | null,
  grid: WeatherGridResponse | null,
): void {
  const [places, setPlaces] = useState<{ lng: number; lat: number }[]>([]);
  const placesKey = useRef('');

  // Read which towns are labelled once the map settles after a move.
  useEffect(() => {
    if (!map || !grid) return;
    let cancelled = false;
    const read = () => {
      if (cancelled) return;
      try {
        const layers = PLACE_LABEL_LAYERS.filter((id) => map.getLayer(id));
        const seen = new Map<string, { lng: number; lat: number }>();
        for (const feature of layers.length ? map.queryRenderedFeatures({ layers }) : []) {
          if (feature.geometry.type !== 'Point') continue;
          const [lng, lat] = feature.geometry.coordinates as [number, number];
          const name = String(feature.properties?.['name'] ?? `${lng},${lat}`);
          seen.set(name, { lng, lat });
        }
        const key = [...seen.keys()].sort().join('|');
        // Only a changed set re-renders: setData makes the map idle again.
        if (key === placesKey.current) return;
        placesKey.current = key;
        setPlaces([...seen.values()]);
      } catch {
        // No style yet.
      }
    };
    const afterMove = () => map.once('idle', read);
    afterMove();
    map.on('moveend', afterMove);
    return () => {
      cancelled = true;
      map.off('moveend', afterMove);
      map.off('idle', read);
    };
  }, [map, grid]);

  const data = useMemo(() => (grid ? weatherValueLabels(grid, places) : null), [grid, places]);

  useEffect(() => {
    if (!map) return;
    const ensure = () => {
      let style: maplibregl.StyleSpecification;
      try {
        style = map.getStyle();
      } catch {
        return;
      }
      try {
        if (!data) {
          for (const id of [PLACE_NUMBER_LAYER, LABEL_LAYER]) {
            if (map.getLayer(id)) map.removeLayer(id);
          }
          if (map.getSource(LABEL_SOURCE)) map.removeSource(LABEL_SOURCE);
          return;
        }
        const source = map.getSource(LABEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
        if (source) source.setData(data);
        else map.addSource(LABEL_SOURCE, { type: 'geojson', data });
        const paint = {
          'text-color': '#1c2530',
          'text-halo-color': 'rgba(255,255,255,0.85)',
          'text-halo-width': 1.4,
        };
        if (!map.getLayer(LABEL_LAYER)) {
          const labelAnchor = (style.layers ?? []).find((layer) => layer.type === 'symbol')?.id;
          map.addLayer(
            {
              id: LABEL_LAYER,
              type: 'symbol',
              source: LABEL_SOURCE,
              filter: ['==', ['get', 'place'], false],
              layout: {
                'text-field': ['get', 'label'],
                'text-font': ['Noto Sans Bold'],
                'text-size': 13,
                'text-padding': 12,
              },
              paint,
            },
            labelAnchor,
          );
          map.addLayer({
            id: PLACE_NUMBER_LAYER,
            type: 'symbol',
            source: LABEL_SOURCE,
            filter: ['==', ['get', 'place'], true],
            layout: {
              'text-field': ['get', 'label'],
              'text-font': ['Noto Sans Bold'],
              'text-size': 13,
              'text-anchor': 'top',
              'text-offset': [0, 0.9],
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            },
            paint,
          });
        }
      } catch {
        // Mid style swap; style.load retries.
      }
    };
    ensure();
    map.on('style.load', ensure);
    return () => {
      map.off('style.load', ensure);
    };
  }, [map, data]);
}

/** Screen pixels between the samples the particle field is built from. */
const FIELD_STEP_PX = 12;
/** Screen pixels a particle moves per animation frame per m/s of wind. */
const PX_PER_FRAME_PER_MS = 0.22;

interface ScreenField {
  cols: number;
  rows: number;
  /** Screen-space velocity per sample, px/frame; NaN where there is no wind data. */
  vx: Float32Array;
  vy: Float32Array;
}

/**
 * Build the wind field in screen space for the map as it sits now: every
 * `FIELD_STEP_PX`, the grid's wind turned into a pixel velocity by projecting a
 * short step along it — which also accounts for bearing and pitch.
 */
function screenField(map: maplibregl.Map, grid: WeatherGridResponse): ScreenField {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const cols = Math.ceil(width / FIELD_STEP_PX) + 1;
  const rows = Math.ceil(height / FIELD_STEP_PX) + 1;
  const vx = new Float32Array(cols * rows).fill(Number.NaN);
  const vy = new Float32Array(cols * rows).fill(Number.NaN);
  const [w, s, e, n] = grid.bbox;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * FIELD_STEP_PX;
      const y = r * FIELD_STEP_PX;
      const at = map.unproject([x, y]);
      const fx = ((at.lng - w) / (e - w)) * grid.cols - 0.5;
      const fy = ((n - at.lat) / (n - s)) * grid.rows - 0.5;
      // Within the grid's outer half-cells, lean on the edge; beyond it (a grid
      // still answering for the previous view) there is no wind to show yet.
      if (fx < -0.5 || fy < -0.5 || fx > grid.cols - 0.5 || fy > grid.rows - 0.5) continue;
      const wind = sampleWindGrid(
        grid,
        Math.max(0, Math.min(grid.cols - 1, fx)),
        Math.max(0, Math.min(grid.rows - 1, fy)),
      );
      if (!wind) continue;
      const speed = Math.hypot(wind.u, wind.v);
      if (speed < 0.05) {
        vx[r * cols + c] = 0;
        vy[r * cols + c] = 0;
        continue;
      }
      const cosLat = Math.max(0.05, Math.cos((at.lat * Math.PI) / 180));
      const step = 0.02;
      const ahead = map.project([
        at.lng + ((wind.u / speed) * step) / cosLat,
        at.lat + (wind.v / speed) * step,
      ]);
      const dx = ahead.x - x;
      const dy = ahead.y - y;
      const length = Math.hypot(dx, dy) || 1;
      vx[r * cols + c] = (dx / length) * speed * PX_PER_FRAME_PER_MS;
      vy[r * cols + c] = (dy / length) * speed * PX_PER_FRAME_PER_MS;
    }
  }
  return { cols, rows, vx, vy };
}

/**
 * White streaks drifting with the wind over the wind field — slow in a calm,
 * fast in a gale. A 2D canvas over the map: a few thousand short segments per
 * frame, with the previous frame faded rather than cleared so each particle
 * leaves a trail.
 *
 * The particles stop while the map moves (their screen field no longer matches
 * the ground) and restart from the new view. Nothing animates for a reader who
 * has asked for reduced motion.
 */
export function useWindParticles(
  map: maplibregl.Map | null,
  grid: WeatherGridResponse | null,
): void {
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const rebuildRef = useRef<() => void>(() => {});
  const active = Boolean(map && grid);

  useEffect(() => {
    if (!map || !active) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const container = map.getContainer();
    const canvas = document.createElement('canvas');
    canvas.className = 'weather-particles';
    container.insertBefore(canvas, container.querySelector('.maplibregl-control-container'));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      return;
    }

    let field: ScreenField | null = null;
    let frameHandle = 0;
    let moving = false;
    let width = 0;
    let height = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    type Particle = { x: number; y: number; age: number; life: number };
    let particles: Particle[] = [];

    const spawn = (p?: Particle): Particle => {
      const next = p ?? { x: 0, y: 0, age: 0, life: 0 };
      next.x = Math.random() * width;
      next.y = Math.random() * height;
      next.age = 0;
      next.life = 40 + Math.random() * 60;
      return next;
    };

    const resize = () => {
      width = container.clientWidth;
      height = container.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(3500, Math.round((width * height) / 380));
      particles = Array.from({ length: count }, () => spawn());
    };

    const rebuild = () => {
      const current = gridRef.current;
      field = current && !moving ? screenField(map, current) : null;
    };
    rebuildRef.current = rebuild;

    const velocity = (x: number, y: number): [number, number] | null => {
      if (!field) return null;
      const c = Math.round(x / FIELD_STEP_PX);
      const r = Math.round(y / FIELD_STEP_PX);
      if (c < 0 || r < 0 || c >= field.cols || r >= field.rows) return null;
      const i = r * field.cols + c;
      const vx = field.vx[i]!;
      if (Number.isNaN(vx)) return null;
      return [vx, field.vy[i]!];
    };

    const tick = () => {
      frameHandle = requestAnimationFrame(tick);
      if (!field) return;
      // Fade what is there instead of clearing it: the fade is the trail.
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 1.3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const p of particles) {
        const v = velocity(p.x, p.y);
        p.age += 1;
        if (!v || p.age > p.life) {
          spawn(p);
          continue;
        }
        const nx = p.x + v[0];
        const ny = p.y + v[1];
        if (nx < 0 || ny < 0 || nx > width || ny > height) {
          spawn(p);
          continue;
        }
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(nx, ny);
        p.x = nx;
        p.y = ny;
      }
      ctx.stroke();
    };

    const onMoveStart = () => {
      moving = true;
      field = null;
      ctx.clearRect(0, 0, width, height);
    };
    const onMoveEnd = () => {
      moving = false;
      for (const p of particles) spawn(p);
      rebuild();
    };

    resize();
    rebuild();
    frameHandle = requestAnimationFrame(tick);
    map.on('movestart', onMoveStart);
    map.on('moveend', onMoveEnd);
    map.on('resize', resize);
    return () => {
      cancelAnimationFrame(frameHandle);
      map.off('movestart', onMoveStart);
      map.off('moveend', onMoveEnd);
      map.off('resize', resize);
      rebuildRef.current = () => {};
      canvas.remove();
    };
  }, [map, active]);

  // A new frame's wind (while playing, every step) reshapes the field without
  // restarting the particles, so the streaks bend instead of blinking.
  useEffect(() => {
    rebuildRef.current();
  }, [grid]);
}
