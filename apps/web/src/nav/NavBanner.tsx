import { fmtClock } from '@atlas/core';
import { tunnelChipLabel } from '@atlas/navigation';
import { formatExitSign } from '@atlas/routing';
import { fmtDuration, fmtKm } from '../format.js';
import { TurnIcon } from './TurnIcon.js';
import type { WebNavController } from './useWebNavigation.js';

const fmtEta = fmtClock;

/** Ground speed in km/h, or null when stationary/unknown. */
function fmtSpeed(speedMps: number | null): string | null {
  if (speedMps == null || speedMps < 0.5) return null;
  return `${Math.round(speedMps * 3.6)} km/h`;
}

/**
 * Turn-by-turn banner for web navigation (Android NavBanner's twin): next
 * maneuver (+ "then" hint), progress, ETA, plus mute / orientation / overview /
 * recenter / End controls, a current-road chip at the bottom of the screen,
 * and a small trip summary on arrival.
 */
export function NavBanner({
  nav,
  followPaused,
  onResumeFollow,
  followMode,
  onToggleFollowMode,
  overview,
  onToggleOverview,
}: {
  nav: WebNavController;
  followPaused: boolean;
  onResumeFollow: () => void;
  followMode: 'course' | 'north';
  onToggleFollowMode: () => void;
  overview: boolean;
  onToggleOverview: () => void;
}) {
  // The preview phase has its own bottom card (RoutePreview) — no banner.
  if (nav.phase === 'idle' || nav.phase === 'preview') return null;
  const { state } = nav;
  const maneuver = state?.upcoming;
  const moving = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const speed = fmtSpeed(nav.speedMps);
  // "then …" hint when the maneuver after the current one follows hot on its
  // heels — the heads-up that matters for lane choice (Google-style).
  const thenManeuver =
    maneuver && state?.then && state.then.distanceToM - maneuver.distanceToM < 300
      ? state.then
      : null;
  // Inside a mapped tunnel the chip names the tunnel and counts it down — the
  // road underneath is still E6, but "Brynstunnelen · 1.2 km" is what the
  // driver can check against the world outside the windscreen.
  const tunnel = moving ? (state?.tunnel ?? null) : null;
  const road = tunnel ? tunnelChipLabel(tunnel) : moving ? (state?.currentRoad ?? null) : null;
  const speedLimit = moving ? (state?.speedLimitKph ?? null) : null;

  return (
    <>
      <div className="nav-banner" role="status">
        <div className="nav-card">
          {nav.phase === 'starting' ? (
            <span className="nav-maneuver">Finding route…</span>
          ) : nav.phase === 'error' ? (
            <span className="nav-error">{nav.error ?? 'Navigation error'}</span>
          ) : nav.phase === 'arrived' ? (
            <>
              <span className="nav-maneuver">You have arrived</span>
              {nav.tripSummary ? (
                <span className="nav-summary">
                  {fmtKm(nav.tripSummary.distanceM)} · {fmtDuration(nav.tripSummary.durationMs)}
                </span>
              ) : null}
            </>
          ) : maneuver ? (
            <div className="nav-maneuver-row">
              <TurnIcon instruction={maneuver.instruction} />
              <span className="nav-distance-to">{fmtKm(maneuver.distanceToM)}</span>
              <div className="nav-maneuver-text">
                <span className="nav-maneuver">{maneuver.instruction.text}</span>
                {maneuver.instruction.exitSign ? (
                  <span className="nav-exit-sign">
                    {formatExitSign(maneuver.instruction.exitSign)}
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <span className="nav-maneuver">Continue on route</span>
          )}
          {thenManeuver ? (
            <div className="nav-then-row">
              <span className="nav-then-label">then</span>
              <TurnIcon instruction={thenManeuver.instruction} size={20} />
            </div>
          ) : null}
          {nav.phase === 'rerouting' ? <span className="nav-reroute">Rerouting…</span> : null}
          {nav.rerouteFailed && nav.phase === 'navigating' ? (
            <span className="nav-reroute">Can’t reroute — continue on the line</span>
          ) : null}
          {state && nav.phase !== 'arrived' ? (
            <>
              <div className="nav-progress-track">
                <div
                  className="nav-progress-fill"
                  style={{
                    width: `${Math.round(Math.min(1, Math.max(0, state.routeProgress)) * 100)}%`,
                  }}
                />
              </div>
              <span className="nav-summary">
                {fmtKm(state.distanceRemainingM)} · {fmtDuration(state.timeRemainingMs)} · arrive{' '}
                {fmtEta(state.etaEpochMs)}
              </span>
            </>
          ) : null}
        </div>
        <div className="nav-actions">
          {moving ? (
            <div className="nav-speed-group">
              <span className="nav-speed">{speed ?? '0 km/h'}</span>
              {/* Absent wherever the map data has no limit — an honest gap
                  beats a stale number the driver might trust. */}
              {speedLimit != null ? (
                <span className="nav-speed-limit" title="Speed limit">
                  {speedLimit}
                </span>
              ) : null}
            </div>
          ) : (
            <span />
          )}
          <div className="nav-buttons">
            {moving && followPaused ? (
              <button type="button" onClick={onResumeFollow}>
                Recenter
              </button>
            ) : null}
            {moving ? (
              <button
                type="button"
                onClick={onToggleOverview}
                aria-pressed={overview}
                title={overview ? 'Back to the follow view' : 'Show the whole remaining route'}
              >
                {overview ? 'Follow' : 'Overview'}
              </button>
            ) : null}
            {moving ? (
              <button
                type="button"
                onClick={onToggleFollowMode}
                title={followMode === 'course' ? 'Switch to north-up' : 'Switch to course-up'}
              >
                {followMode === 'course' ? 'N' : '➤'}
              </button>
            ) : null}
            {moving ? (
              <button type="button" onClick={nav.toggleMute} aria-pressed={nav.muted}>
                {nav.muted ? '🔇' : '🔊'}
              </button>
            ) : null}
            <button type="button" className="nav-stop" onClick={nav.stop}>
              {nav.phase === 'arrived' ? 'Done' : 'End'}
            </button>
          </div>
        </div>
      </div>
      {road ? <div className="nav-road-chip">{road}</div> : null}
    </>
  );
}
