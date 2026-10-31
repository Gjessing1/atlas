interface TerrainControlProps {
  enabled: boolean;
  basemap: boolean;
  onToggle: () => void;
}

/**
 * Web-only DEM terrain switch, offered in every activity; MapLibre Native
 * deliberately remains 2D.
 */
export function TerrainControl({ enabled, basemap, onToggle }: TerrainControlProps) {
  const label = enabled ? 'Switch to 2D map' : 'Switch to 3D terrain';
  return (
    <button
      type="button"
      className={`map-terrain-control map-control has-tip${enabled ? ' on' : ''}`}
      aria-label={label}
      aria-pressed={enabled}
      data-tip={basemap ? label : 'Turn on the base map to use 3D terrain'}
      disabled={!basemap}
      onClick={onToggle}
    >
      {/* The label is the icon: "3D" says what the switch does at a glance,
          and the tooltip says which way it goes. */}
      <span aria-hidden="true">3D</span>
    </button>
  );
}
