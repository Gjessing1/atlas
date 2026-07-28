import type { RouteEnrichment } from './model.js';

export interface RouteSurfaceShare {
  label: string;
  distanceM: number;
  percent: number;
}

/** Short, stable labels for Valhalla's OSM-derived surface enum. */
export function routeSurfaceLabel(surface: string | undefined): string {
  if (!surface) return 'Unknown';
  if (surface.startsWith('paved')) return 'Paved';
  if (surface === 'compacted') return 'Compacted';
  if (surface === 'gravel' || surface === 'fine_gravel') return 'Gravel';
  if (
    surface === 'dirt' ||
    surface === 'earth' ||
    surface === 'ground' ||
    surface === 'mud' ||
    surface === 'sand'
  ) {
    return 'Natural';
  }
  return surface.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Surface covering a distance along a route, when the graph knows it. */
export function routeSurfaceAt(
  enrichment: RouteEnrichment | null | undefined,
  alongM: number,
): string | null {
  const segment = enrichment?.segments.find((item) => alongM >= item.startM && alongM <= item.endM);
  return segment?.surface ? routeSurfaceLabel(segment.surface) : null;
}

/** Whole-route surface breakdown, longest first and rounded to whole percent. */
export function routeSurfaceBreakdown(
  enrichment: RouteEnrichment | null | undefined,
  totalM: number,
): RouteSurfaceShare[] {
  if (!enrichment || totalM <= 0) return [];
  const distances = new Map<string, number>();
  let coveredM = 0;
  for (const segment of enrichment.segments) {
    const distanceM = Math.max(0, Math.min(totalM, segment.endM) - Math.max(0, segment.startM));
    if (distanceM <= 0) continue;
    const label = routeSurfaceLabel(segment.surface);
    distances.set(label, (distances.get(label) ?? 0) + distanceM);
    coveredM += distanceM;
  }
  if (coveredM < totalM - 1) {
    distances.set('Unknown', (distances.get('Unknown') ?? 0) + totalM - coveredM);
  }
  return [...distances.entries()]
    .map(([label, distanceM]) => ({
      label,
      distanceM,
      percent: Math.round((distanceM / totalM) * 100),
    }))
    .filter((item) => item.percent > 0)
    .sort((a, b) => b.distanceM - a.distanceM);
}
