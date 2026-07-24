import {
  circleFeature,
  destinationPoint,
  fmtKm,
  haversineM,
  pathLengthM,
  type LatLng,
} from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';

const SOURCE_ID = 'atlas-measure';
const RING_FILL = 'atlas-measure-ring-fill';
const RING_LINE = 'atlas-measure-ring-line';
const PATH_LINE = 'atlas-measure-path';
const POINTS = 'atlas-measure-points';
const LABELS = 'atlas-measure-labels';
const ALL_LAYERS = [RING_FILL, RING_LINE, PATH_LINE, POINTS, LABELS];

/** Distinct from the route purple and the camera amber. */
const MEASURE_COLOR = '#0e7490'; // cyan-700
const LABEL_COLOR = '#0e7490';

/** Radius presets, metres. Multi-select — a stand often wants two rings at once. */
const RADIUS_PRESETS = [50, 100, 200, 300, 500] as const;

type Mode = 'distance' | 'radius';

function fmtRadius(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

/**
 * The radius / measure tool (roadmap §4.7b): a click-to-add distance ruler and
 * click-to-drop radius rings, for hunt line-of-sight and general planning. A
 * tool, not a catalog layer — it owns its own MapLibre GeoJSON source while
 * open and clears it on close. Geometry math is shared with Android via
 * `@atlas/core` (circleFeature/destinationPoint/pathLengthM), so a ring is the
 * same shape on both platforms.
 */
export function MeasureTool({ map, onClose }: { map: maplibregl.Map; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('distance');
  const [points, setPoints] = useState<LatLng[]>([]);
  const [centers, setCenters] = useState<LatLng[]>([]);
  const [radii, setRadii] = useState<number[]>([100, 200]);

  // The map handler is registered once; it reads the live mode via a ref.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const totalM = useMemo(() => pathLengthM(points), [points]);
  const straightM = useMemo(
    () => (points.length >= 2 ? haversineM(points[0]!, points[points.length - 1]!) : 0),
    [points],
  );

  // ---- feature collection derived from the current measurement ----
  const fc = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    if (mode === 'distance') {
      if (points.length >= 2) {
        features.push({
          type: 'Feature',
          properties: { kind: 'path' },
          geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
        });
      }
      points.forEach((p, i) => {
        features.push({
          type: 'Feature',
          properties: { kind: 'point' },
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        });
        // Running total sits at each vertex from the second one on.
        if (i > 0) {
          features.push({
            type: 'Feature',
            properties: { kind: 'label', text: fmtKm(pathLengthM(points.slice(0, i + 1))) },
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          });
        }
      });
    } else {
      for (const c of centers) {
        features.push({
          type: 'Feature',
          properties: { kind: 'point' },
          geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
        });
        for (const r of radii) {
          features.push(circleFeature(c, r, { kind: 'ring' }));
          // Label each ring at its top (due north of the centre).
          const top = destinationPoint(c, 0, r);
          features.push({
            type: 'Feature',
            properties: { kind: 'label', text: fmtRadius(r) },
            geometry: { type: 'Point', coordinates: [top.lng, top.lat] },
          });
        }
      }
    }
    return { type: 'FeatureCollection', features };
  }, [mode, points, centers, radii]);

  const fcRef = useRef(fc);
  fcRef.current = fc;

  // ---- layers: ensure once, re-ensure across style swaps, seed from fcRef ----
  useEffect(() => {
    const ensure = () => {
      if (!map.getStyle()) return;
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, { type: 'geojson', data: fcRef.current });
      }
      if (map.getLayer(RING_FILL)) return;
      const ring: maplibregl.ExpressionSpecification = ['==', ['get', 'kind'], 'ring'];
      map.addLayer({
        id: RING_FILL,
        type: 'fill',
        source: SOURCE_ID,
        filter: ring,
        paint: { 'fill-color': MEASURE_COLOR, 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: RING_LINE,
        type: 'line',
        source: SOURCE_ID,
        filter: ring,
        layout: { 'line-join': 'round' },
        paint: { 'line-color': MEASURE_COLOR, 'line-width': 1.8, 'line-dasharray': [3, 2] },
      });
      map.addLayer({
        id: PATH_LINE,
        type: 'line',
        source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'path'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': MEASURE_COLOR, 'line-width': 3 },
      });
      map.addLayer({
        id: POINTS,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'point'],
        paint: {
          'circle-radius': 5,
          'circle-color': '#ffffff',
          'circle-stroke-color': MEASURE_COLOR,
          'circle-stroke-width': 2.5,
        },
      });
      map.addLayer({
        id: LABELS,
        type: 'symbol',
        source: SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'label'],
        layout: {
          'text-field': ['get', 'text'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12.5,
          'text-offset': [0, -1.2],
          'text-anchor': 'bottom',
          // A measure tool must always show its numbers: nearby rings (100/200 m)
          // and dense path vertices otherwise lose labels to symbol collision.
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': LABEL_COLOR,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.6,
        },
      });
    };
    ensure();
    map.on('style.load', ensure);
    map.on('styledata', ensure);
    return () => {
      map.off('style.load', ensure);
      map.off('styledata', ensure);
      if (map.getStyle()) {
        for (const id of ALL_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      }
    };
  }, [map]);

  // Push the current measurement into the source whenever it changes.
  useEffect(() => {
    const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    source?.setData(fc);
  }, [map, fc]);

  // ---- clicks add points/centres; crosshair cursor while the tool is open ----
  useEffect(() => {
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const at = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      if (modeRef.current === 'distance') setPoints((prev) => [...prev, at]);
      else setCenters((prev) => [...prev, at]);
    };
    map.on('click', onClick);
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
    return () => {
      map.off('click', onClick);
      canvas.style.cursor = prevCursor;
    };
  }, [map]);

  const hasWork = mode === 'distance' ? points.length > 0 : centers.length > 0;
  const undo = () => {
    if (mode === 'distance') setPoints((p) => p.slice(0, -1));
    else setCenters((c) => c.slice(0, -1));
  };
  const clear = () => {
    setPoints([]);
    setCenters([]);
  };
  const toggleRadius = (r: number) =>
    setRadii((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r].sort((a, b) => a - b),
    );

  return (
    <div className="measure-panel" role="dialog" aria-label="Measure">
      <div className="measure-head">
        <strong>Measure</strong>
        <button type="button" onClick={onClose} aria-label="Close measure tool" title="Close">
          ✕
        </button>
      </div>
      <div className="measure-modes" role="group" aria-label="Measure mode">
        <button
          type="button"
          aria-pressed={mode === 'distance'}
          onClick={() => setMode('distance')}
        >
          Distance
        </button>
        <button type="button" aria-pressed={mode === 'radius'} onClick={() => setMode('radius')}>
          Radius
        </button>
      </div>
      {mode === 'distance' ? (
        <div className="measure-body">
          {points.length >= 2 ? (
            <>
              <div className="measure-readout">{fmtKm(totalM)}</div>
              {straightM > 0 && straightM !== totalM && (
                <div className="measure-sub">straight line {fmtKm(straightM)}</div>
              )}
            </>
          ) : (
            <p className="measure-hint">Click the map to add points along a line.</p>
          )}
        </div>
      ) : (
        <div className="measure-body">
          <div className="measure-chips" role="group" aria-label="Ring radii">
            {RADIUS_PRESETS.map((r) => (
              <button
                key={r}
                type="button"
                className={radii.includes(r) ? 'measure-chip on' : 'measure-chip'}
                aria-pressed={radii.includes(r)}
                onClick={() => toggleRadius(r)}
              >
                {fmtRadius(r)}
              </button>
            ))}
          </div>
          <p className="measure-hint">
            {centers.length === 0
              ? 'Click the map to drop a circle.'
              : `${centers.length} ${centers.length === 1 ? 'circle' : 'circles'}`}
          </p>
        </div>
      )}
      <div className="measure-actions">
        <button type="button" onClick={undo} disabled={!hasWork}>
          Undo
        </button>
        <button type="button" onClick={clear} disabled={!hasWork}>
          Clear
        </button>
      </div>
    </div>
  );
}
