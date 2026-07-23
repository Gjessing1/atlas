export type NavWidgetId = 'speed' | 'altitude' | 'next-turn' | 'remaining';

export interface NavWidgetInfo {
  id: NavWidgetId;
  label: string;
}

/** Small enough to scan while moving; settings cap the visible subset at three. */
export const NAV_WIDGETS: readonly NavWidgetInfo[] = [
  { id: 'speed', label: 'Speed' },
  { id: 'altitude', label: 'Altitude' },
  { id: 'next-turn', label: 'Distance to turn' },
  { id: 'remaining', label: 'Distance remaining' },
];

export const DEFAULT_NAV_WIDGETS: readonly NavWidgetId[] = ['speed'];
export const MAX_NAV_WIDGETS = 3;

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
