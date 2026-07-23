export type NavWidgetId = 'speed' | 'altitude' | 'ascent' | 'next-turn' | 'remaining';

export interface NavWidgetInfo {
  id: NavWidgetId;
  label: string;
}

/** Small enough to scan while moving; settings cap the visible subset at three. */
export const NAV_WIDGETS: readonly NavWidgetInfo[] = [
  { id: 'speed', label: 'Speed' },
  { id: 'altitude', label: 'Altitude' },
  { id: 'ascent', label: 'Ascent remaining' },
  { id: 'next-turn', label: 'Distance to turn' },
  { id: 'remaining', label: 'Distance remaining' },
];

export const DEFAULT_NAV_WIDGETS: readonly NavWidgetId[] = ['speed'];
export const MAX_NAV_WIDGETS = 3;

/**
 * What the widget strip shows before the user has ever customised it, by
 * travel mode. A speedometer is the right driving default and a useless
 * walking one; on a hike the number that matters is the climb still ahead —
 * so an untouched strip follows the trip's mode. A saved customisation
 * (`local.nav.widgets`) always wins over these.
 */
export function defaultNavWidgetsFor(profile: string): NavWidgetId[] {
  if (profile === 'hike') return ['ascent', 'altitude'];
  if (profile === 'foot') return ['remaining'];
  return [...DEFAULT_NAV_WIDGETS];
}

export function isNavWidgetId(value: unknown): value is NavWidgetId {
  return typeof value === 'string' && NAV_WIDGETS.some((widget) => widget.id === value);
}

/** Parse a device-local setting without allowing duplicates or an oversized strip. */
export function parseNavWidgets(raw: string | null | undefined): NavWidgetId[] {
  if (!raw) return [...DEFAULT_NAV_WIDGETS];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [...DEFAULT_NAV_WIDGETS];
    const widgets: NavWidgetId[] = [];
    for (const item of value) {
      if (isNavWidgetId(item) && !widgets.includes(item)) widgets.push(item);
      if (widgets.length === MAX_NAV_WIDGETS) break;
    }
    return widgets;
  } catch {
    return [...DEFAULT_NAV_WIDGETS];
  }
}
