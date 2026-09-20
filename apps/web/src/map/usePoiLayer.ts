import { POI_ICON_IMAGE, poiResultsFeatureCollection, type PoiResult } from '@atlas/core';
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

/** Explicit category-icon POI pins, independent of list snapshot ordering. */
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
      // Still `…-results-number`: the id is what the style, the tests and the
      // click handler agree on, and only what it draws has changed. EV charging
      // has no honest sprite, so that one category keeps its ⚡ as disc text.
      map.addLayer({
        id: NUMBER,
        type: 'symbol',
        source: SOURCE,
        filter: point,
        layout: {
          'icon-image': POI_ICON_IMAGE as unknown as maplibregl.ExpressionSpecification,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.62, 14, 0.82],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'text-field': ['case', ['==', ['get', 'categoryId'], 'charging'], ['get', 'marker'], ''],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 13],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': '#ffffff' },
      });
      // Names start one zoom before clustering stops (15), which the numbered
      // discs could not afford: the icon says what a place is, so its name is
      // free to appear as soon as the pins separate. Collisions need no zoom
      // rule — the layer allows no overlap and `text-optional` drops a label
      // rather than its disc.
      map.addLayer({
        id: NAME,
        type: 'symbol',
        source: SOURCE,
        filter: point,
        minzoom: 14,
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
      const id = hit?.properties?.['id'];
      const result =
        typeof id === 'string' ? resultsRef.current.find((item) => item.id === id) : undefined;
      if (result) pickRef.current(result);
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
