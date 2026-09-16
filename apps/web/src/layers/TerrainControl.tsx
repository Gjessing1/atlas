import { TerrainIcon } from '../icons.js';

interface TerrainControlProps {
  available: boolean;
  enabled: boolean;
  basemap: boolean;
  onToggle: () => void;
}

/** Web-only DEM terrain switch; MapLibre Native deliberately remains 2D. */
export function TerrainControl({ available, enabled, basemap, onToggle }: TerrainControlProps) {
  if (!available) return null;
  const label = enabled ? 'Switch to 2D map' : 'Switch to 3D terrain';
  return (
    <button
      type="button"
      className={`map-terrain-control${enabled ? ' on' : ''}`}
      aria-label={label}
      aria-pressed={enabled}
      title={basemap ? label : 'Turn on the base map to use 3D terrain'}
      disabled={!basemap}
      onClick={onToggle}
    >
      <TerrainIcon size={20} />
      <span aria-hidden="true">3D</span>
    </button>
  );
}
