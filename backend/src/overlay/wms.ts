import type { WmsUpstream } from './catalog.js';

/**
 * Web-mercator tile math and WMS request building — the piece the tile proxy
 * and the identify proxy share (GetMap and GetFeatureInfo differ only in a
 * handful of extra parameters on top of the same base request).
 */

const WEB_MERCATOR_EXTENT = 20037508.342789244;

/** [minx, miny, maxx, maxy] of a z/x/y tile in EPSG:3857 metres. */
export function tileBbox3857(z: number, x: number, y: number): [number, number, number, number] {
  const size = (2 * WEB_MERCATOR_EXTENT) / 2 ** z;
  const minX = -WEB_MERCATOR_EXTENT + x * size;
  const maxY = WEB_MERCATOR_EXTENT - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

/** Fractional web-mercator tile coordinates of a lat/lng at zoom z. */
export function tileCoords(lat: number, lng: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

/**
 * `size` is the GetMap image edge in px. Identify keeps the default 256 (its
 * I/J pixel is computed against a 256 px tile); GetMap can ask for a larger
 * image over the same bbox for hi-dpi rendering (see `renderScale`).
 */
export function wmsBaseParams(u: WmsUpstream, z: number, x: number, y: number, size = 256): URL {
  const url = new URL(u.url);
  const p = url.searchParams;
  p.set('SERVICE', 'WMS');
  p.set('VERSION', u.version);
  p.set('LAYERS', u.layers);
  p.set('STYLES', u.styles ?? '');
  p.set('FORMAT', 'image/png');
  p.set('TRANSPARENT', 'TRUE');
  p.set('WIDTH', String(size));
  p.set('HEIGHT', String(size));
  // A bigger image over the same bbox is only crisper if the server also scales
  // its symbology; the DPI hint asks it to (ArcGIS honours DPI, MapServer/
  // GeoServer MAP_RESOLUTION — both are set, unknown params are ignored). Left
  // off at 256 px so plain tiles keep their existing request shape.
  if (size !== 256) {
    const dpi = String(Math.round((96 * size) / 256));
    p.set('DPI', dpi);
    p.set('MAP_RESOLUTION', dpi);
  }
  // 1.3.0 uses CRS, 1.1.1 uses SRS; EPSG:3857 keeps x,y axis order in both.
  p.set(u.version === '1.3.0' ? 'CRS' : 'SRS', 'EPSG:3857');
  p.set('BBOX', tileBbox3857(z, x, y).join(','));
  return url;
}

/** Expands `${VAR}` references in an upstream URL template from the env. */
export function substituteEnv(template: string, env: Record<string, string | undefined>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '');
}
