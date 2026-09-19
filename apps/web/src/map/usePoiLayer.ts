import { poiResultsFeatureCollection, type PoiResult } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef } from 'react';

const SOURCE = 'atlas-poi-results';
const CLUSTER = 'atlas-poi-results-cluster';
const CLUSTER_COUNT = 'atlas-poi-results-cluster-count';
const HALO = 'atlas-poi-results-halo';
const DISC = 'atlas-poi-results-disc';
const NUMBER = 'atlas-poi-results-number';
const NAME = 'atlas-poi-results-name';
const LAYERS = [CLUSTER, CLUSTER_COUNT, HALO, DISC, NUMBER, NAME];

/** Explicit numbered POI pins; their indexes are the viewport-list indexes. */
export function usePoiLayer(
  map: maplibregl.Map | null,
  results: readonly PoiResult[],
  onPick: (result: PoiResult) => void,
  suppressClicks?: { readonly current: boolean },
): void {
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const data = useMemo(
    () => poiResultsFeatureCollection(results) as GeoJSON.FeatureCollection,
    [results],
  );
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    const remove = () => {
      if (!map.getStyle()) return;
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    };
    const ensure = () => {
      if (cancelled || !map.getStyle()) return;
      const source = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (source) source.setData(dataRef.current);
      else {
        if (resultsRef.current.length === 0) return;
        map.addSource(SOURCE, {
          type: 'geojson',
          data: dataRef.current,
          cluster: true,
          clusterRadius: 34,
          clusterMaxZoom: 15,
        });
      }
      if (map.getLayer(DISC)) return;
      const point: maplibregl.ExpressionSpecification = ['!', ['has', 'point_count']];
      map.addLayer({
        id: CLUSTER,
        type: 'circle',
        source: SOURCE,
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 17, 10, 21, 30, 25],
          'circle-color': '#0e7490',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.5,
        },
      });
      map.addLayer({
        id: CLUSTER_COUNT,
        type: 'symbol',
        source: SOURCE,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#ffffff' },
      });
      map.addLayer({
        id: HALO,
        type: 'circle',
        source: SOURCE,
        filter: point,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 12, 14, 17],
          'circle-color': '#ffffff',
          'circle-opacity': 0.96,
        },
      });
      map.addLayer({
        id: DISC,
        type: 'circle',
        source: SOURCE,
        filter: point,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 9, 14, 14],
          'circle-color': '#0e7490',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: NUMBER,
        type: 'symbol',
        source: SOURCE,
        filter: point,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 13],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': '#ffffff' },
      });
      map.addLayer({
        id: NAME,
        type: 'symbol',
        source: SOURCE,
        filter: point,
        minzoom: 15,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-anchor': 'top',
          'text-offset': [0, 1.5],
          'text-optional': true,
        },
        paint: {
          'text-color': '#172033',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });
    };
    if (results.length === 0) remove();
    else ensure();
    map.on('style.load', ensure);
    return () => {
      cancelled = true;
      map.off('style.load', ensure);
    };
  }, [map, data, results.length]);

  useEffect(() => {
    if (!map) return;
    const onClick = (event: maplibregl.MapMouseEvent) => {
      if (suppressClicks?.current || !map.getLayer(DISC)) return;
      const hit = map.queryRenderedFeatures(event.point, { layers: [DISC, HALO] })[0];
      const index = hit?.properties?.['index'];
      if (typeof index === 'number' && resultsRef.current[index]) {
        pickRef.current(resultsRef.current[index]!);
      }
    };
    const onClusterClick = (event: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(CLUSTER)) return;
      const hit = map.queryRenderedFeatures(event.point, { layers: [CLUSTER] })[0];
      const id = hit?.properties?.['cluster_id'];
      if (typeof id !== 'number' || hit?.geometry.type !== 'Point') return;
      const coordinates = hit.geometry.coordinates as [number, number];
      const source = map.getSource(SOURCE) as maplibregl.GeoJSONSource;
      void source
        .getClusterExpansionZoom(id)
        .then((zoom) => map.easeTo({ center: coordinates, zoom, duration: 450 }));
    };
    const pointer = () => (map.getCanvas().style.cursor = 'pointer');
    const unpointer = () => (map.getCanvas().style.cursor = '');
    map.on('click', onClick);
    map.on('click', CLUSTER, onClusterClick);
    map.on('mouseenter', DISC, pointer);
    map.on('mouseleave', DISC, unpointer);
    return () => {
      map.off('click', onClick);
      map.off('click', CLUSTER, onClusterClick);
      map.off('mouseenter', DISC, pointer);
      map.off('mouseleave', DISC, unpointer);
    };
  }, [map, suppressClicks]);
}
