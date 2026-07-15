import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';

// Placeholder public style until the self-hosted PMTiles basemap lands (ROADMAP Phase 2).
const STYLE_URL = 'https://demotiles.maplibre.org/style.json';

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: { lat: 59.91, lng: 10.75 }, // Oslo
      zoom: 4,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    return () => map.remove();
  }, []);

  return <div ref={containerRef} style={{ height: '100%' }} />;
}
