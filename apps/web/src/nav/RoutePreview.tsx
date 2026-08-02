import type { NavController } from '@atlas/app-hooks';
import { fmtDuration, fmtEta, fmtKm } from '@atlas/core';
import { pathViaLabels, ROUTING_PROFILES, type RoutePath } from '@atlas/routing';
import { formatTrafficDelay } from '@atlas/traffic';
import { useMemo } from 'react';
import { ROUTING_ICON } from '../icons.js';

/** Extra minutes over the fastest choice, e.g. "+4 min" ("+<1 min" when tiny). */
function fmtExtra(timeMs: number, fastestMs: number): string {
  const min = Math.round((timeMs - fastestMs) / 60_000);
  return min < 1 ? '+<1 min' : `+${min} min`;
}

/**
 * Route-choice card for the nav `preview` phase (Android RoutePreview's twin):
 * profile chips, one row per choice — fastest first and pre-selected — with
 * duration, arrival time, distance and a "via …" label where the roads tell
 * the choices apart. Start begins guidance along the selected row.
 */
export function RoutePreview({ nav }: { nav: NavController }) {
  const paths: RoutePath[] | null = nav.previewPaths;
  const vias = useMemo(() => (paths ? pathViaLabels(paths) : []), [paths]);
  if (nav.phase !== 'preview' || !paths || paths.length === 0) return null;
  const fastestMs = paths[0]!.timeMs;

  return (
    <div className="nav-preview" role="dialog" aria-label="Route choices">
      {/* A walk to the car ferry is a different trip: switch the profile here
          and the choices refetch for the same origin/destination. */}
      <div className="route-profiles">
        {ROUTING_PROFILES.map((p) => {
          const Icon = ROUTING_ICON[p.id];
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === nav.profile}
              disabled={nav.previewLoading}
              onClick={() => nav.setProfile(p.id)}
            >
              <span className="mode-label">
                <Icon size={18} /> {p.label}
              </span>
            </button>
          );
        })}
      </div>
      {nav.previewError && (
        <p className="nav-preview-error">No route for that profile — kept the current one</p>
      )}
      <ul className={`nav-preview-choices${nav.previewLoading ? ' loading' : ''}`}>
        {paths.map((path, i) => {
          const selected = i === nav.previewIndex;
          return (
            <li key={i}>
              <button
                type="button"
                className={`nav-preview-choice${selected ? ' selected' : ''}`}
                aria-pressed={selected}
                disabled={nav.previewLoading}
                onClick={() => nav.selectPreview(i)}
              >
                <span className="nav-preview-time">
                  {fmtDuration(path.timeMs)}
                  {i > 0 && (
                    <span className="nav-preview-extra"> ({fmtExtra(path.timeMs, fastestMs)})</span>
                  )}
                </span>
                <span className="nav-preview-detail">
                  {fmtKm(path.distanceM)} · {fmtEta(path.timeMs)}
                  {vias[i] ? ` · via ${vias[i]}` : i === 0 ? ' · fastest' : ''}
                  {formatTrafficDelay(path.trafficDelayMs)
                    ? ` · ${formatTrafficDelay(path.trafficDelayMs)}`
                    : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="nav-preview-actions">
        <button type="button" className="nav-preview-cancel" onClick={nav.stop}>
          Cancel
        </button>
        <button
          type="button"
          className="nav-preview-go"
          disabled={nav.previewLoading}
          onClick={() => void nav.go()}
        >
          {nav.previewLoading ? 'Finding routes…' : 'Start'}
        </button>
      </div>
    </div>
  );
}
