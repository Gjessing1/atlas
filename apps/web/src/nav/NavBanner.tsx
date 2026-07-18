import { fmtDuration, fmtKm } from '../format.js';
import type { WebNavController } from './useWebNavigation.js';

const fmtEta = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Rotation (deg) of the shared ↑ glyph for an Atlas turn sign (see
 * RouteInstruction: -2 left … 0 continue … 2 right, ±3 sharp, ±7 keep,
 * ±8 u-turn), or null for signs drawn as their own glyph.
 */
function turnRotation(sign: number): number | null {
  if (sign >= -3 && sign <= 3) return sign * 45;
  if (sign === 7 || sign === -7) return Math.sign(sign) * 30;
  if (sign === 8 || sign === -8) return 180;
  return null;
}

/** Visual for the upcoming maneuver: a rotated arrow, ↻ roundabout, ⚑ arrive/via. */
function TurnArrow({ sign, exitNumber }: { sign: number; exitNumber?: number }) {
  if (sign === 6) {
    return (
      <span className="nav-turn">
        ↻{exitNumber ? <span className="nav-turn-exit">{exitNumber}</span> : null}
      </span>
    );
  }
  if (sign === 4 || sign === 5) return <span className="nav-turn">⚑</span>;
  return (
    <span className="nav-turn" style={{ transform: `rotate(${turnRotation(sign) ?? 0}deg)` }}>
      ↑
    </span>
  );
}

/** Ground speed in km/h, or null when stationary/unknown. */
function fmtSpeed(speedMps: number | null): string | null {
  if (speedMps == null || speedMps < 0.5) return null;
  return `${Math.round(speedMps * 3.6)} km/h`;
}

/**
 * Turn-by-turn banner for web navigation (Android NavBanner's twin): next
 * maneuver, progress, ETA, plus mute / orientation / recenter / End controls.
 */
export function NavBanner({
  nav,
  followPaused,
  onResumeFollow,
  followMode,
  onToggleFollowMode,
}: {
  nav: WebNavController;
  followPaused: boolean;
  onResumeFollow: () => void;
  followMode: 'course' | 'north';
  onToggleFollowMode: () => void;
}) {
  if (nav.phase === 'idle') return null;
  const { state } = nav;
  const maneuver = state?.upcoming;
  const moving = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const speed = fmtSpeed(nav.speedMps);

  return (
    <div className="nav-banner" role="status">
      <div className="nav-card">
        {nav.phase === 'starting' ? (
          <span className="nav-maneuver">Finding route…</span>
        ) : nav.phase === 'error' ? (
          <span className="nav-error">{nav.error ?? 'Navigation error'}</span>
        ) : nav.phase === 'arrived' ? (
          <span className="nav-maneuver">You have arrived</span>
        ) : maneuver ? (
          <div className="nav-maneuver-row">
            <TurnArrow
              sign={maneuver.instruction.sign}
              exitNumber={maneuver.instruction.exitNumber}
            />
            <span className="nav-distance-to">{fmtKm(maneuver.distanceToM)}</span>
            <span className="nav-maneuver">{maneuver.instruction.text}</span>
          </div>
        ) : (
          <span className="nav-maneuver">Continue on route</span>
        )}
        {nav.phase === 'rerouting' ? <span className="nav-reroute">Rerouting…</span> : null}
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
        {moving ? <span className="nav-speed">{speed ?? '0 km/h'}</span> : <span />}
        <div className="nav-buttons">
          {moving && followPaused ? (
            <button type="button" onClick={onResumeFollow}>
              Recenter
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
  );
}
