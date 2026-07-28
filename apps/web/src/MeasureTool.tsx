import type { MeasureController } from '@atlas/app-hooks';
import { fmtRadius, MEASURE_RADII_M, type LatLng } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

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

/**
 * The radius / measure tool: a click-to-add distance ruler and click-to-drop
 * radius rings, for hunt line-of-sight and general planning. A tool, not a
 * catalog layer — it owns its own MapLibre GeoJSON source while open and clears
 * it on close.
 *
 * The measurement itself lives in `useMeasure` (@atlas/app-hooks) over the
 * `@atlas/core` measure model, so the Android tool draws the same geometry and
 * says the same words; what stays here is purely MapLibre — the layers, and
 * turning a map click into `addPoint`.
 */
export function MeasureTool({
  map,
  measure,
  onClose,
}: {
  map: maplibregl.Map;
  measure: MeasureController;
  onClose: () => void;
}) {
  const { mode, radii, features, readout, hasWork } = measure;

  const fcRef = useRef(features);
  fcRef.current = features;

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
    source?.setData(features);
  }, [map, features]);

  // ---- clicks add points/centres; crosshair cursor while the tool is open ----
  const addPoint = measure.addPoint;
  useEffect(() => {
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const at: LatLng = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      addPoint(at);
    };
    map.on('click', onClick);
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
    return () => {
      map.off('click', onClick);
      canvas.style.cursor = prevCursor;
    };
  }, [map, addPoint]);

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
          onClick={() => measure.setMode('distance')}
        >
          Distance
        </button>
        <button
          type="button"
          aria-pressed={mode === 'radius'}
          onClick={() => measure.setMode('radius')}
        >
          Radius
        </button>
      </div>
      <div className="measure-body">
        {mode === 'radius' && (
          <div className="measure-chips" role="group" aria-label="Ring radii">
            {MEASURE_RADII_M.map((r) => (
              <button
                key={r}
                type="button"
                className={radii.includes(r) ? 'measure-chip on' : 'measure-chip'}
                aria-pressed={radii.includes(r)}
                onClick={() => measure.toggleRadius(r)}
              >
                {fmtRadius(r)}
              </button>
            ))}
          </div>
        )}
        {readout.headline && <div className="measure-readout">{readout.headline}</div>}
        {readout.detail && <div className="measure-sub">{readout.detail}</div>}
        {readout.hint && <p className="measure-hint">{readout.hint}</p>}
      </div>
      <div className="measure-actions">
        <button type="button" onClick={measure.undo} disabled={!hasWork}>
          Undo
        </button>
        <button type="button" onClick={measure.clear} disabled={!hasWork}>
          Clear
        </button>
      </div>
    </div>
  );
}
