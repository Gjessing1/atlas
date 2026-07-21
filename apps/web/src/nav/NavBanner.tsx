import { fmtClock } from '@atlas/core';
import { tunnelChipLabel } from '@atlas/navigation';
import { formatExitSign } from '@atlas/routing';
import { fmtDuration, fmtKm } from '../format.js';
import { TurnIcon } from './TurnIcon.js';
import type { WebNavController } from './useWebNavigation.js';

const fmtEta = fmtClock;

/** Ground speed in km/h, or null when stationary/unknown. */
function speedKph(speedMps: number | null): number | null {
  if (speedMps == null || speedMps < 0.5) return null;
  return Math.round(speedMps * 3.6);
}

function NavActionIcon({ kind }: { kind: 'recenter' | 'overview' | 'follow' | 'sound' | 'mute' }) {
  if (kind === 'recenter') {
    return (
      <svg className="nav-action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="5" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </svg>
    );
  }
  if (kind === 'overview') {
    return (
      <svg className="nav-action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m3.5 6 5-2.5 7 3 5-2.5v14l-5 2.5-7-3-5 2.5zM8.5 3.5v14M15.5 6.5v14" />
      </svg>
    );
  }
  if (kind === 'follow') {
    return (
      <svg className="nav-action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3 7.5 17-7.5-3.4L4.5 20z" />
      </svg>
    );
  }
  return (
    <svg className="nav-action-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10v4h4l5 4V6L8 10z" />
      {kind === 'mute' ? (
        <path d="m17 9 5 5M22 9l-5 5" />
      ) : (
        <path d="M16.5 9.2a4 4 0 0 1 0 5.6M19 6.8a7.3 7.3 0 0 1 0 10.4" />
      )}
    </svg>
  );
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
  const speed = speedKph(nav.speedMps);
  const sustain = moving ? (state?.sustain ?? null) : null;
  // "then …" hint when the maneuver after the current one follows hot on its
  // heels — or the distant maneuver demoted below a long-road sustain cue.
  const thenManeuver =
    sustain && maneuver
      ? maneuver
      : maneuver && state?.then && state.then.distanceToM - maneuver.distanceToM < 300
        ? state.then
        : null;
  // Inside a mapped tunnel the chip names the tunnel and counts it down — the
  // road underneath is still E6, but "Brynstunnelen · 1.2 km" is what the
  // driver can check against the world outside the windscreen.
  const tunnel = moving ? (state?.tunnel ?? null) : null;
  const road = tunnel ? tunnelChipLabel(tunnel) : moving ? (state?.currentRoad ?? null) : null;
  const speedLimit = moving ? (state?.speedLimitKph ?? null) : null;
  // The manual way out, offered only near the destination — where the automatic
  // rules can fail (a fix that never gets accurate enough in a car park) and
  // where "I've arrived" is the one thing the traveller knows better than we do.
  // Deliberately distinct from End: this completes the trip rather than
  // abandoning it, so it banks the summary.
  const canDeclareArrival = moving && state != null && state.distanceRemainingM <= 150;

  return (
    <>
      <div className="nav-banner" role="status">
        <div className="nav-card">
          {nav.phase === 'starting' ? (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">Navigation</span>
              <span className="nav-maneuver">Finding the best route…</span>
            </div>
          ) : nav.phase === 'error' ? (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">Navigation unavailable</span>
              <span className="nav-error">{nav.error ?? 'Navigation error'}</span>
            </div>
          ) : nav.phase === 'arrived' ? (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">Trip complete</span>
              <span className="nav-maneuver">You have arrived</span>
              {nav.tripSummary ? (
                <span className="nav-arrival-summary">
                  {fmtKm(nav.tripSummary.distanceM)} · {fmtDuration(nav.tripSummary.durationMs)}
                </span>
              ) : null}
            </div>
          ) : maneuver ? (
            <>
              <div className="nav-guidance-row">
                <div className="nav-turn-panel">
                  <TurnIcon instruction={sustain ? { sign: 0 } : maneuver.instruction} size={44} />
                </div>
                <div className="nav-maneuver-text">
                  <span className="nav-distance-to">
                    {sustain
                      ? `Continue for ${fmtKm(sustain.distanceRemainingM)}`
                      : `In ${fmtKm(maneuver.distanceToM)}`}
                  </span>
                  <span className="nav-maneuver">
                    {sustain ? sustain.road : maneuver.instruction.text}
                  </span>
                  {!sustain && maneuver.instruction.exitSign ? (
                    <span className="nav-exit-sign">
                      {formatExitSign(maneuver.instruction.exitSign)}
                    </span>
                  ) : null}
                </div>
              </div>
              {thenManeuver ? (
                <div className="nav-then-row">
                  <span className="nav-then-label">Then</span>
                  <TurnIcon instruction={thenManeuver.instruction} size={20} />
                  <span className="nav-then-text">{thenManeuver.instruction.text}</span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">On route</span>
              <span className="nav-maneuver">Continue straight ahead</span>
            </div>
          )}

          {nav.phase === 'rerouting' ? <span className="nav-reroute">Rerouting…</span> : null}
          {nav.rerouteFailed && nav.phase === 'navigating' ? (
            <span className="nav-reroute">Can’t reroute — continue on the line</span>
          ) : null}
          {state && nav.phase !== 'arrived' ? (
            <>
              <div className="nav-trip-row">
                <span className="nav-eta">
                  <strong>{fmtEta(state.etaEpochMs)}</strong>
                  <small>arrival</small>
                </span>
                <span className="nav-summary">
                  {fmtDuration(state.timeRemainingMs)} · {fmtKm(state.distanceRemainingM)} remaining
                </span>
              </div>
              <div className="nav-progress-track" aria-hidden="true">
                <div
                  className="nav-progress-fill"
                  style={{
                    width: `${Math.round(Math.min(1, Math.max(0, state.routeProgress)) * 100)}%`,
                  }}
                />
              </div>
            </>
          ) : null}
        </div>
        <div className={`nav-actions${canDeclareArrival ? ' nav-actions-arrival' : ''}`}>
          {moving ? (
            <div className="nav-speed-group" aria-label={`Current speed ${speed ?? 0} km/h`}>
              <span className="nav-speed">
                <strong>{speed ?? 0}</strong>
                <small>km/h</small>
              </span>
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
              <button
                type="button"
                className="nav-action-button"
                onClick={onResumeFollow}
                aria-label="Recenter"
                title="Recenter"
              >
                <NavActionIcon kind="recenter" />
              </button>
            ) : null}
            {moving ? (
              <button
                type="button"
                className="nav-action-button"
                onClick={onToggleOverview}
                aria-label={overview ? 'Back to follow view' : 'Show route overview'}
                aria-pressed={overview}
                title={overview ? 'Back to the follow view' : 'Show the whole remaining route'}
              >
                <NavActionIcon kind={overview ? 'follow' : 'overview'} />
              </button>
            ) : null}
            {moving ? (
              <button
                type="button"
                className="nav-action-button nav-orientation-button"
                onClick={onToggleFollowMode}
                aria-label={followMode === 'course' ? 'Switch to north-up' : 'Switch to course-up'}
                title={followMode === 'course' ? 'Switch to north-up' : 'Switch to course-up'}
              >
                {followMode === 'course' ? 'N' : <NavActionIcon kind="follow" />}
              </button>
            ) : null}
            {moving ? (
              <button
                type="button"
                className="nav-action-button"
                onClick={nav.toggleMute}
                aria-label={nav.muted ? 'Unmute guidance' : 'Mute guidance'}
                aria-pressed={nav.muted}
                title={nav.muted ? 'Unmute guidance' : 'Mute guidance'}
              >
                <NavActionIcon kind={nav.muted ? 'mute' : 'sound'} />
              </button>
            ) : null}
            {canDeclareArrival ? (
              <button
                type="button"
                className="nav-arrived"
                onClick={nav.arriveNow}
                title="Finish the trip here"
              >
                I&apos;ve arrived
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
