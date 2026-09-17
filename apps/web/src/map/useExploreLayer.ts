import { exploreResultsFeatureCollection, type SearchResult } from '@atlas/core';
import type maplibregl from 'maplibre-gl';
import { useEffect, useMemo, useRef } from 'react';

const SOURCE_ID = 'atlas-explore-results';
const HALO_ID = 'atlas-explore-results-halo';
const DISC_ID = 'atlas-explore-results-disc';
const NUMBER_ID = 'atlas-explore-results-number';
const CLUSTER_ID = 'atlas-explore-results-cluster';
const CLUSTER_COUNT_ID = 'atlas-explore-results-cluster-count';
const SPIDER_LEG_ID = 'atlas-explore-results-spider-legs';
const ALL_LAYERS = [HALO_ID, DISC_ID, NUMBER_ID, CLUSTER_ID, CLUSTER_COUNT_ID, SPIDER_LEG_ID];
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Numbered Explore results: the list stays legible as a spatial answer on the map. */
export function useExploreLayer(
  map: maplibregl.Map | null,
  results: readonly SearchResult[],
  onPick: (result: SearchResult) => void,
  suppressClicks?: { readonly current: boolean },
): void {
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const data = useMemo(
    () =>
      results.length
        ? (exploreResultsFeatureCollection(results) as GeoJSON.FeatureCollection)
        : EMPTY_FC,
    [results],
  );
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    const removeAll = () => {
      if (!map.getStyle()) return;
      for (const id of ALL_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
    if (results.length === 0) {
      removeAll();
      return;
    }
    const ensure = () => {
      if (cancelled || !map.getStyle()) return;
      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (source) source.setData(dataRef.current);
      else
        map.addSource(SOURCE_ID, {
          type: 'geojson',
          data: dataRef.current,
          cluster: true,
          clusterRadius: 32,
          clusterMaxZoom: 16,
        });
      if (map.getLayer(DISC_ID)) return;
      const unclustered: maplibregl.ExpressionSpecification = ['!', ['has', 'point_count']];
      map.addLayer({
        id: SPIDER_LEG_ID,
        type: 'line',
        source: SOURCE_ID,
        filter: ['==', ['get', 'spiderLeg'], true],
        // Clusters form up to clusterMaxZoom; legs only mean something once
        // the points they lead to have separated.
        minzoom: 17,
        paint: { 'line-color': '#64748b', 'line-width': 1.5, 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: CLUSTER_ID,
        type: 'circle',
        source: SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 16, 5, 20, 12, 24],
          'circle-color': '#0e7490',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: CLUSTER_COUNT_ID,
        type: 'symbol',
        source: SOURCE_ID,
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
        id: HALO_ID,
        type: 'circle',
        source: SOURCE_ID,
        filter: unclustered,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 12, 14, 17],
          'circle-color': '#ffffff',
          'circle-opacity': 0.92,
        },
      });
      map.addLayer({
        id: DISC_ID,
        type: 'circle',
        source: SOURCE_ID,
        filter: unclustered,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 9.5, 14, 14],
          'circle-color': '#0e7490',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: NUMBER_ID,
        type: 'symbol',
        source: SOURCE_ID,
        filter: unclustered,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 14],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': '#ffffff' },
      });
    };
    ensure();
    map.on('style.load', ensure);
    map.on('styledata', ensure);
    return () => {
      cancelled = true;
      map.off('style.load', ensure);
      map.off('styledata', ensure);
    };
  }, [map, data, results.length]);

  useEffect(() => {
    if (!map) return;
    const onClick = (event: maplibregl.MapMouseEvent) => {
      if (suppressClicks?.current || !map.getLayer(DISC_ID)) return;
      const hit = map.queryRenderedFeatures(event.point, { layers: [DISC_ID, HALO_ID] })[0];
      const index = hit?.properties?.['index'];
      if (typeof index !== 'number') return;
      const result = resultsRef.current[index];
      if (result) pickRef.current(result);
    };
    map.on('click', onClick);
    const onClusterClick = (event: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(CLUSTER_ID)) return;
      const hit = map.queryRenderedFeatures(event.point, { layers: [CLUSTER_ID] })[0];
      const clusterId = hit?.properties?.['cluster_id'];
      if (typeof clusterId !== 'number' || hit?.geometry.type !== 'Point') return;
      const position = (hit.geometry as { coordinates: number[] }).coordinates;
      if (position.length < 2) return;
      const coordinates: [number, number] = [position[0]!, position[1]!];
      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource;
      void source.getClusterExpansionZoom(clusterId).then((zoom) => {
        map.easeTo({ center: coordinates, zoom, duration: 450 });
      });
    };
    map.on('click', CLUSTER_ID, onClusterClick);
    return () => {
      map.off('click', onClick);
      map.off('click', CLUSTER_ID, onClusterClick);
    };
  }, [map, suppressClicks]);
}
